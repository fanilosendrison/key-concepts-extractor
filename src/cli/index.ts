export interface ParsedCli {
  command: "run" | "history" | "help";
  options?: {
    prompt?: string;
    files?: string[];
  };
  exitCode?: number;
  usage?: string;
}

export function parseCli(_argv: string[]): ParsedCli {
  throw new Error("Not implemented");
}
