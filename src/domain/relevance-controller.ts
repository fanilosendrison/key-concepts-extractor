import type { ProviderAdapter } from "./ports.js";
import type { ControlScope, MergedConcept, RelevanceReport } from "./types.js";

export interface RelevanceInput {
  mergedList: MergedConcept[];
  context: string;
  scope: ControlScope;
  anthropic: ProviderAdapter;
  openai: ProviderAdapter;
}

export interface RelevanceOutput {
  filteredList: MergedConcept[];
  report: RelevanceReport;
}

export function runRelevanceControl(_input: RelevanceInput): Promise<RelevanceOutput> {
  throw new Error("Not implemented");
}
