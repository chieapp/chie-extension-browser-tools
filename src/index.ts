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
    serviceType: AgentService,
    viewType: ChatView,
    apiTypes: [ChatCompletionAPI],
    description: 'Have AI agents work for you.',
  });
  serviceManager.registerService({
    name: 'MultiAgentsService',
    serviceType: MultiAgentsService,
    viewType: MultiChatsView,
    apiTypes: [ChatCompletionAPI],
    description: 'Have multiple AI agents work for you.',
  });
}
