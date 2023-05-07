export interface ExecutionResult {
  resultForModel: string;
  resultForHuman: string;
}

export default interface Tool {
  name: string;
  displayName: string;
  descriptionForModel: string;
  execute: (arg: string) => Promise<ExecutionResult>;
}
