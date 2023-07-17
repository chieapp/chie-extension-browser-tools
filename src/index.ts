import {toolManager} from 'chie';

import toolBrowse from './tool-browse';
import toolSearch from './tool-search';

export function activate() {
  toolManager.registerTool(toolBrowse);
  toolManager.registerTool(toolSearch);
}

export function deactivate() {
  toolManager.unregisterTool(toolBrowse.name);
  toolManager.unregisterTool(toolSearch.name);
}
