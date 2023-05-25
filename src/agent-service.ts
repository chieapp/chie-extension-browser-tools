import fs from 'node:fs';
import path from 'node:path';
import {
  APIError,
  BaseChatService,
  BaseChatServiceData,
  BaseChatServiceOptions,
  ChatCompletionAPI,
  ChatHistoryData,
  ChatMessage,
  ChatRole,
  ChatStep,
} from 'chie';

import Tool, {ExecutionResult} from './tool';

interface Action {
  tool: string;
  input: string;
}

class DeduceStep implements ChatStep {
  name: 'Thought' | 'Action' | 'Observation' | 'Answer';
  value: string | Action | ExecutionResult;

  constructor(name, value) {
    this.name = name;
    this.value = value;
  }

  toString() {
    if (this.name == 'Action') {
      const action = this.value as Action;
      return `Action: ${action.tool}("${action.input}")`;
    } else if (this.name == 'Observation') {
      const observation = this.value as ExecutionResult;
      return `Observation: ${observation.resultForHuman}`;
    } else {
      return `${this.name}: ${this.value}`;
    }
  }
}

export default class AgentService extends BaseChatService<ChatCompletionAPI> {
  tools: Tool[] = [];
  promptText: string;

  state: 'start' | 'think' | 'action' | 'before-execute' | 'execute' | 'begin-answer' | 'answer' | 'end';
  buffer: string;
  abortedByUs: boolean;
  agentAborter: AbortController;

  // Saved execution of action.
  execution?: () => Promise<ChatMessage>;

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
    this.promptText = fs.readFileSync(path.join(__dirname, '..', 'prompt.txt'))
      .toString()
      .replace('{{toolNames}}', this.tools.map(t => t.name).join(', '))
      .replace('{{tools}}', this.tools.map(t => `  ${t.name}: ${t.descriptionForModel}`).join('\n\n'));
  }

  deserializeHistory(data: ChatHistoryData) {
    super.deserializeHistory(data);
    for (const message of this.history) {
      if (message.steps)
        message.steps = message.steps.map((raw: DeduceStep) => new DeduceStep(raw.name, raw.value));
    }
  }

  canRegenerateFrom() {
    return true;
  }

  async sendHistoryAndGetResponse(options) {
    // Initialize state.
    this.state = 'start' as typeof this.state;
    let thinkProgress: ChatMessage | null;
    // Enter think <=> action loop.
    do {
      // Clear buffer for new response.
      this.buffer = '';
      this.abortedByUs = false;
      this.agentAborter = new AbortController();
      this.execution = null;
      // Add system prompt and history.
      const conversation = [{role: ChatRole.System, content: this.promptText}, ...this.history.map(formatMessage)];
      // Add result of thinking and action.
      if (thinkProgress) {
        conversation.push(thinkProgress);
        thinkProgress = null;
      }
      // Call API.
      try {
        await this.api.sendConversation(conversation, {
          signal: this.agentAborter.signal,
          onMessageDelta: this.#parseDelta.bind(this),
        });
      } catch (error) {
        // Ignored intentional aborts by us.
        if (!(error.name == 'AbortError' && this.abortedByUs))
          throw error;
      }
      // Execute the action if there is one.
      if (this.execution) {
        if (this.state != 'execute')
          throw new APIError(`Unexpected state when executing action: ${this.state}.`);
        thinkProgress = await this.execution();
      } else if (this.state != 'end') {
        throw new APIError(`Unexpected state after end of message: ${this.state}.`);
      }
    } while (this.state != 'end');
  }

  #parseDelta(delta, response) {
    if (delta.content)
      this.buffer += delta.content;
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
      this.notifyMessageDelta({steps: [ new DeduceStep('Thought', thought) ]}, response);
      this.state = nextIsAction ? 'action' : 'begin-answer';
    } else if (this.state == 'action') {
      // After action is observation.
      if (!this.#findStringBetween(/\n*Observation:/))
        return;
      // Print action.
      const tool = this.#findStringBetween(/\n*Action:/, /\n\w+:/).toLowerCase();
      let input = this.#findStringBetween(/\n*Input:/, /\n\w+:/);
      if (!input) {
        this.#abortAgent();
        throw new APIError(`Missing input for action: ${tool}.`);
      }
      input = removeQuotes(input);
      this.notifyMessageDelta({steps: [ new DeduceStep('Action', {tool, input}) ]}, response);
      // Prepare for action execution.
      this.state = 'execute';
      this.execution = this.#execute.bind(this, tool, input);
      // Abort since we don't need chatgpt's imaginary observation.
      this.#abortAgent();
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
      this.notifyMessageDelta({content}, response);
      if (response.pending)  // more answer streaming
        this.state = 'answer';
      else
        this.#end();
    } else if (this.state == 'answer') {
      // Stream answer.
      this.notifyMessageDelta(delta, response);
      if (!response.pending)
        this.#end();
    } else if (this.state == 'end') {
      // Just print out data when not in state machine.
      this.notifyMessageDelta(delta, response);
    } else {
      throw new APIError(`Invalid state: ${this.state}.`);
    }
  }

  async #execute(action: string, input: string) {
    // Find tool.
    const tool = this.tools.find(t => t.name == action);
    if (!tool)
      throw new APIError(`Can not find action: ${action}.`);
    // Use tool.
    try {
      const result = await tool.execute(input);
      this.notifyMessageDelta({steps: [ new DeduceStep('Observation', result) ]}, {pending: true});
    } catch (error) {
      throw new APIError(`Failed to execute action: ${action}(${input}): ${error.message}.`);
    }
    // Construct a fake response from bot.
    return formatMessage(this.pendingMessage);
  }

  #abortAgent() {
    this.abortedByUs = true;
    this.agentAborter.abort();
  }

  #unexpectedResponse() {
    this.#end();
    // Just print out what we got so far.
    this.notifyMessageDelta({content: this.buffer}, {pending: false});
  }

  #end() {
    this.state = 'end';
    this.#abortAgent();
  }

  #findStringBetween(startText: RegExp, endText?: RegExp) {
    const match = startText.exec(this.buffer);
    if (!match)
      return null;
    const start = match.index + match[0].length;
    if (endText) {
      const end = endText.exec(this.buffer.slice(start));
      if (end)
        return this.buffer.slice(start, start + end.index).trim();
    }
    return this.buffer.slice(start).trim();
  }
}

function formatMessage(message: Partial<ChatMessage>) {
  let content = '';
  if (message.steps) {
    for (const step of message.steps) {
      if (!(step instanceof DeduceStep))
        continue;
      if (step.name == 'Action') {
        const action = step.value as Action;
        content += `Action: ${action.tool}\nInput: ${action.input}\n`;
      } else if (step.name == 'Observation') {
        const observation = step.value as ExecutionResult;
        content += `Observation: ${observation.resultForModel}\n`;
      } else {
        content += `${step.name}: ${step.value}\n`;
      }
    }
  }
  if (message.content)
    content += `Answer: ${message.content}\n`;
  return {role: message.role, content};
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
