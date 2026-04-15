import type { FinalConcept } from "./types.js";

export interface CoverageInput {
  concepts: FinalConcept[];
  sourceText: string;
}

export interface CoverageStats {
  explicit: number;
  implicit: number;
  fragile: number;
}

export interface CoverageOutput {
  concepts: FinalConcept[];
  stats: CoverageStats;
}

export function verifyCoverage(_input: CoverageInput): CoverageOutput {
  throw new Error("Not implemented");
}
