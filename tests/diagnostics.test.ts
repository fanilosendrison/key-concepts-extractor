import { describe, expect, it } from "vitest";
import { generateDiagnostics } from "../src/domain/diagnostics.js";
import type { FinalConcept } from "../src/domain/types.js";
import { finalConcept } from "./helpers/factories.js";

const fc = (overrides: Partial<FinalConcept>) => finalConcept(overrides);

describe("DiagnosticsGenerator", () => {
  it("T-DG-01: unique by angle", () => {
    const a = fc({
      canonical_term: "a",
      angle_provenance: {
        extraction_directe: { consensus: "1/3", models: ["claude"] },
      },
    });
    const b = fc({
      canonical_term: "b",
      angle_provenance: {
        etats_ideaux: { consensus: "1/3", models: ["claude"] },
        taxonomie: { consensus: "1/3", models: ["gpt"] },
        conditions_bord: { consensus: "1/3", models: ["gemini"] },
      },
    });
    const report = generateDiagnostics({ concepts: [a, b] });
    expect(report.unique_by_angle.extraction_directe).toBe(1);
  });

  it("T-DG-02: unique by model", () => {
    const c = fc({
      canonical_term: "c",
      angle_provenance: {
        etats_ideaux: { consensus: "1/3", models: ["gemini"] },
      },
    });
    const report = generateDiagnostics({ concepts: [c] });
    expect(report.unique_by_model.gemini).toContain("c");
  });

  it("T-DG-03: unanimous", () => {
    const u = fc({
      canonical_term: "u",
      angles_count: "3/5",
      angle_provenance: {
        etats_ideaux: { consensus: "3/3", models: ["claude", "gpt", "gemini"] },
        taxonomie: { consensus: "2/3", models: ["claude", "gpt"] },
        conditions_bord: { consensus: "2/3", models: ["claude", "gemini"] },
      },
    });
    const report = generateDiagnostics({ concepts: [u] });
    expect(report.unanimous_concepts).toBe(1);
  });
});
