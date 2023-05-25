import {
  ChatCompletionAPI,
  ChatView,
  MultiChatsView,
  serviceManager,
} from 'chie';

import AgentService from './agent-service';
import MultiAgentsService from './multi-agents-service';

export function activate() {
  serviceManager.registerService({
    name: 'AgentService',
    serviceClass: AgentService,
    apiClasses: [ChatCompletionAPI],
    viewClasses: [ChatView],
    description: 'Have AI agents work for you.',
  });
  serviceManager.registerService({
    name: 'MultiAgentsService',
    serviceClass: MultiAgentsService,
    apiClasses: [ChatCompletionAPI],
    viewClasses: [MultiChatsView],
    description: 'Have multiple AI agents work for you.',
  });
}
