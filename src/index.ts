import AgentService from './agent-service';
import {ChatCompletionAPI, ChatView, serviceManager} from 'chie';

export function activate() {
  serviceManager.registerService({
    name: 'AgentService',
    serviceType: AgentService,
    viewType: ChatView,
    apiTypes: [ChatCompletionAPI],
    description: 'Have AI agents work for you.',
  });
}
