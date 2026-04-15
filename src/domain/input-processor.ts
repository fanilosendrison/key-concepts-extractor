import type { InputFile, ProcessedInput } from "./types.js";

export interface InputProcessorArgs {
  prompt?: string | undefined;
  files?: InputFile[] | undefined;
}

export function processInput(_args: InputProcessorArgs): ProcessedInput {
  throw new Error("Not implemented");
}
