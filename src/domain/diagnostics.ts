import type { DiagnosticsReport, FinalConcept } from "./types.js";

export interface DiagnosticsInput {
  concepts: FinalConcept[];
}

export function generateDiagnostics(_input: DiagnosticsInput): DiagnosticsReport {
  throw new Error("Not implemented");
}
