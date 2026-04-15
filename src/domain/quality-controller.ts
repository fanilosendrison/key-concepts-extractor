import type { ProviderAdapter } from "./ports.js";
import type { ControlScope, MergedConcept, QualityReport } from "./types.js";

export interface QualityInput {
  mergedList: MergedConcept[];
  context: string;
  scope: ControlScope;
  anthropic: ProviderAdapter;
  openai: ProviderAdapter;
}

export interface QualityOutput {
  correctedList: MergedConcept[];
  report: QualityReport;
}

export function runQualityControl(_input: QualityInput): Promise<QualityOutput> {
  throw new Error("Not implemented");
}
