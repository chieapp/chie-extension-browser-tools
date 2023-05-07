import {NodeVM} from 'vm2';

import Tool from './tool';

export default class ToolScript implements Tool {
  name = 'eval';
  displayName = 'Script';
  descriptionForModel = `\
Run Node.js script, can only use builtin modules, and it should not write any \
file into filesystem. Input is raw Node.js code, do not pass markdown text. \
Output is the console output, can only get output from console.log.`

  async execute(code: string) {
    const vm = new NodeVM({
      console: 'redirect',
      env: process.env,
      require: {
        builtin: [ '*' ],
      },
    });
    let output = '';
    vm.on('console.log', data => output += data + '\n');
    vm.on('console.error', data => output += data + '\n');
    vm.run(code);
    return {
      resultForModel: output,
      resultForHuman: output,
    };
  }
}


