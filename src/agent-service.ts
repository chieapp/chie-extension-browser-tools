import fs from 'node:fs';
import path from 'node:path';
import {APIError, ChatMessage, ChatRole, ChatService} from 'chie';

import Tool from './tool';

interface DeduceStep {
  name: 'Thought' | 'Action' | 'Observation' | 'Answer';
  value: string;
}

export default class AgentService extends ChatService {
  tools: Tool[] = [];

  state: 'start' | 'think' | 'action' | 'before-execute' | 'execute' | 'begin-answer' | 'answer' | 'end';
  steps: DeduceStep[];

  // Our fake pending message.
  #agentMessage: Partial<ChatMessage>;

  // Saved execution.
  #execution?: () => void;

  static deserialize(data) {
    return ChatService.deserialize(data);
  }

  constructor(options) {
    super(options);

    // Read tools.
    for (const name of fs.readdirSync(__dirname)) {
      if (name.startsWith('tool-')) {
        const tool = require('./' + name).default;
        this.tools.push(new tool());
      }
    }

    // Construct prompt text.
    const promptText = fs.readFileSync(path.join(__dirname, '..', 'prompt.txt'))
      .toString()
      .replace('{{toolNames}}', this.tools.map(t => t.name).join(', '))
      .replace('{{tools}}', this.tools.map(t => `  ${t.name}: ${t.descriptionForModel}`).join('\n\n'));
    this.setParam('systemPrompt', promptText);
  }

  getHistory() {
    // Last history entry is our request.
    if (this.state == 'execute' && this.#lastMessageIsFromAssitant())
      return this.history.slice(0, -1);
    return this.history;
  }

  getPendingMessage() {
    return this.#agentMessage;
  }

  isPending() {
    return this.#agentMessage != null;
  }

  isAborted() {
    return false;
  }

  notifyMessageBegin() {
    if (this.state == 'execute')
      return;
    this.state = 'start';
    this.steps = [];
    this.#agentMessage = {steps: [], content: ''};
    super.notifyMessageBegin();
  }

  notifyMessageDelta(delta, response) {
    if (!this.pendingMessage?.content)
      return;
    if (this.state == 'start') {
      // Start of bot message.
      if (!response.pending)
        return this.#unexpectedResponse();
      // May get answer directly.
      if (this.#findStringBetween(/\n*Answer:/)) {
        this.state = 'begin-answer';
        return;
      }
      // Otherwise wait for the thought.
      if (!this.#findStringBetween(/\n*Thought:/))
        return;
      this.state = 'think';
    } else if (this.state == 'think') {
      if (!response.pending)
        return this.#unexpectedResponse();
      // After thought we either get answer or do action.
      const nextIsAction = this.#findStringBetween(/\n*Action:/);
      const nextIsAnswer = this.#findStringBetween(/\n*Answer:/);
      if (!nextIsAction && !nextIsAnswer)
        return;
      // Print thought.
      const thought = this.#findStringBetween(/\n*Thought:/, /\n\w+:/);
      const step = `Thought: ${thought}`;
      super.notifyMessageDelta({steps: [ step ]}, response);
      this.#agentMessage.steps.push(step);
      this.steps.push({name: 'Thought', value: thought});
      this.state = nextIsAction ? 'action' : 'begin-answer';
    } else if (this.state == 'action') {
      // After action is observation.
      if (!this.#findStringBetween(/\n*Observation:/))
        return;
      // Print action.
      const action = this.#findStringBetween(/\n*Action:/, /\n\w+:/).toLowerCase();
      let input = this.#findStringBetween(/\n*Input:/, /\n\w+:/);
      if (!input) {
        this.notifyMessageError(new APIError(`Missing input for action: ${action}.`));
        return;
      }
      input = removeQuotes(input);
      const step = `Action: ${action}("${input}")`;
      super.notifyMessageDelta({steps: [ step ]}, response);
      this.#agentMessage.steps.push(step);
      this.steps.push({name: 'Action', value: `${action}\nInput:${input}`});
      // Abort since we don't need chatgpt's imaginary observation.
      this.state = 'before-execute';
      this.aborter.abort();
      this.#execution = this.#execute.bind(this, action, input);
    } else if (this.state == 'before-execute') {
      // After previous abortion there will be an end delta.
      if (response.pending) {
        this.notifyMessageError(new APIError('Unexpected pending delta.'));
        return;
      }
      this.state = 'execute';
      // Only start new message after previous one is ended.
      this.#execution();
      this.#execution = null;
    } else if (this.state == 'execute') {
      // Start receving thought of observation.
      if (!response.pending)
        return this.#unexpectedResponse();
      // After execution will think again.
      if (!this.#findStringBetween(/\n*Thought:/))
        return;
      this.state = 'think';
    } else if (this.state == 'begin-answer') {
      // Print answer.
      const content = this.#findStringBetween(/\n*Answer:/) + delta.content;
      super.notifyMessageDelta({content}, response);
      this.#agentMessage.content += content;
      if (response.pending)  // more answer streaming
        this.state = 'answer';
      else
        this.#end();
    } else if (this.state == 'answer') {
      // Stream answer.
      super.notifyMessageDelta(delta, response);
      this.#agentMessage.content += delta.content;
      if (!response.pending)
        this.#end();
    } else {
      this.notifyMessageError(new APIError(`Invalid state: ${this.state}.`));
    }
  }

  notifyMessageError(error) {
    super.notifyMessageError(error);
    this.#end();
  }

  notifyMessage(message) {
    if (this.state == 'execute')
      return;
    super.notifyMessage(message);
  }

  async #execute(action: string, input: string) {
    // Find tool.
    const tool = this.tools.find(t => t.name == action);
    if (!tool) {
      this.notifyMessageError(new APIError(`Can not find action: ${action}.`));
      return;
    }
    // Use tool.
    try {
      const result = await tool.execute(input);
      const step = `Observation: ${result.resultForHuman}`;
      super.notifyMessageDelta({steps: [ step ]}, {pending: true});
      this.#agentMessage.steps.push(step);
      this.steps.push({name: 'Observation', value: result.resultForModel});
    } catch (error) {
      this.notifyMessageError(new APIError(`Failed to execute action: ${action}(${input}): ${error.message}.`));
      return;
    }
    // Construct a fake response from bot.
    const content = this.steps.map(s => `${s.name}: ${s.value}`).join('\n');
    // Send response.
    if (this.#lastMessageIsFromAssitant())
      this.history.pop();
    this.history.push({role: ChatRole.Assistant, content});
    try {
      await super.invokeChatAPI({});
    } finally {
      // Concatenate the new response to previous one.
      if (this.history.length > 2 && this.history[this.history.length - 2].role == ChatRole.Assistant) {
        this.history[this.history.length - 2].content += this.history[this.history.length -1].content;
        this.history.pop();
      }
      super.saveHistory();
    }
  }

  #unexpectedResponse() {
    this.#end();
    // Just print out what we got so far.
    super.notifyMessageDelta(this.pendingMessage, {pending: false});
  }

  #end() {
    this.state = 'end';
    this.aborter.abort();
    if (this.lastError?.name == 'AbortError')
      this.lastError = null;
    this.#agentMessage = null;
  }

  #lastMessageIsFromAssitant() {
    return this.history[this.history.length - 1].role == ChatRole.Assistant;
  }

  #findStringBetween(startText: RegExp, endText?: RegExp) {
    const content = this.pendingMessage.content;
    const match = startText.exec(content);
    if (!match)
      return null;
    const start = match.index + match[0].length;
    if (endText) {
      const end = endText.exec(content.slice(start));
      if (end)
        return content.slice(start, start + end.index).trim();
    }
    return content.slice(start).trim();
  }
}

function removeQuotes(str: string) {
  str = str.trim();
  if (str.startsWith('```') && str.endsWith('```'))
    return str.slice(3, -3);
  if (str.startsWith('"') && str.endsWith('"'))
    return str.slice(1, -1);
  if (str.startsWith('`') && str.endsWith('`'))
    return str.slice(1, -1);
  return str;
}
