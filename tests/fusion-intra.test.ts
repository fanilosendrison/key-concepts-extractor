import { describe, expect, it } from "vitest";
import { fuseIntraAngle } from "../src/domain/fusion-intra.js";
import { rawConcept } from "./helpers/factories.js";

const rc = (term: string, category = "property", explicit = true) =>
  rawConcept({ term, category, explicit_in_source: explicit });

describe("FusionIntraAngle", () => {
  it("T-FI-01: exact dedup, 3/3 consensus", () => {
    const result = fuseIntraAngle({
      angle: "etats_ideaux",
      passes: {
        claude: [rc("consistency")],
        gpt: [rc("consistency")],
        gemini: [rc("consistency")],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.consensus).toBe("3/3");
    expect(result[0]?.found_by_models.sort()).toEqual(["claude", "gemini", "gpt"]);
  });

  it("T-FI-02: case-insensitive dedup", () => {
    const result = fuseIntraAngle({
      angle: "etats_ideaux",
      passes: {
        claude: [rc("Consistency")],
        gpt: [rc("consistency")],
        gemini: [rc("CONSISTENCY")],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.consensus).toBe("3/3");
  });

  it("T-FI-03: near-exact dedup (Levenshtein)", () => {
    const result = fuseIntraAngle({
      angle: "etats_ideaux",
      passes: {
        claude: [rc("output consistency")],
        gpt: [rc("output-consistency")],
        gemini: [],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.consensus).toBe("2/3");
  });

  it("T-FI-04: distinct concepts remain separate", () => {
    const result = fuseIntraAngle({
      angle: "etats_ideaux",
      passes: {
        claude: [rc("consistency")],
        gpt: [rc("reliability")],
        gemini: [],
      },
    });
    expect(result).toHaveLength(2);
    for (const c of result) expect(c.consensus).toBe("1/3");
  });

  it("T-FI-05: explicit_in_source OR logic", () => {
    const result = fuseIntraAngle({
      angle: "etats_ideaux",
      passes: {
        claude: [rc("consistency", "property", false)],
        gpt: [rc("consistency", "property", true)],
        gemini: [],
      },
    });
    expect(result[0]?.explicit_in_source).toBe(true);
  });

  it("T-FI-06: empty provider output", () => {
    const result = fuseIntraAngle({
      angle: "etats_ideaux",
      passes: {
        claude: [rc("a"), rc("b"), rc("c"), rc("d"), rc("e")],
        gpt: [],
        gemini: [rc("a"), rc("f"), rc("g")],
      },
    });
    expect(result.every((c) => c.consensus !== "3/3")).toBe(true);
    expect(result.some((c) => c.consensus === "2/3")).toBe(true);
  });

  it("T-FI-07: category resolution (most frequent)", () => {
    const result = fuseIntraAngle({
      angle: "etats_ideaux",
      passes: {
        claude: [rc("consistency", "property")],
        gpt: [rc("consistency", "property")],
        gemini: [rc("consistency", "method")],
      },
    });
    expect(result[0]?.category).toBe("property");
  });

  it("P-01: deterministic across pass ordering permutations", () => {
    const claudePass = [rc("a"), rc("b")];
    const gptPass = [rc("b"), rc("c")];
    const geminiPass = [rc("a"), rc("c")];
    const r1 = fuseIntraAngle({
      angle: "etats_ideaux",
      passes: { claude: claudePass, gpt: gptPass, gemini: geminiPass },
    });
    const r2 = fuseIntraAngle({
      angle: "etats_ideaux",
      passes: { gemini: geminiPass, claude: claudePass, gpt: gptPass },
    });
    const r3 = fuseIntraAngle({
      angle: "etats_ideaux",
      passes: {
        claude: [...claudePass].reverse(),
        gpt: [...gptPass].reverse(),
        gemini: [...geminiPass].reverse(),
      },
    });
    const canon = (arr: typeof r1) =>
      [...arr].map((c) => ({ ...c, found_by_models: [...c.found_by_models].sort() }));
    expect(canon(r1)).toEqual(canon(r2));
    expect(canon(r1)).toEqual(canon(r3));
  });

  it("P-02: consensus bounds", () => {
    const result = fuseIntraAngle({
      angle: "etats_ideaux",
      passes: {
        claude: [rc("a"), rc("b")],
        gpt: [rc("a"), rc("c")],
        gemini: [rc("b"), rc("c")],
      },
    });
    for (const c of result) {
      expect(["1/3", "2/3", "3/3"]).toContain(c.consensus);
    }
  });
});
