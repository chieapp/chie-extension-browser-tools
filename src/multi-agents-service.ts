import {
  BaseMultiChatsService,
  ChatCompletionAPI,
} from 'chie';

import AgentService from './agent-service';

export default class MultiAgentsService extends BaseMultiChatsService<ChatCompletionAPI> {
  static deserialize(data) {
    return BaseMultiChatsService.deserialize(data);
  }

  constructor(options) {
    super(AgentService, options);
  }
}
