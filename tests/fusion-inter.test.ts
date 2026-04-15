import { describe, expect, it } from "vitest";
import { fuseInterAngle } from "../src/domain/fusion-inter.js";
import type { MergedConcept } from "../src/domain/types.js";
import { mergedConcept } from "./helpers/factories.js";
import { createMockEmbedding } from "./helpers/mock-embedding.js";

const mc = (
	term: string,
	found: MergedConcept["found_by_models"],
	consensus: MergedConcept["consensus"],
): MergedConcept => mergedConcept({ term, found_by_models: found, consensus });

describe("FusionInterAngle", () => {
	it("T-FN-01: semantic merge when similarity ≥ 0.85", async () => {
		const result = await fuseInterAngle({
			byAngle: {
				etats_ideaux: [mc("consistency", ["claude", "gpt"], "2/3")],
				taxonomie: [mc("output consistency", ["claude"], "1/3")],
			},
			embeddings: createMockEmbedding([["consistency", "output consistency", 0.92]]),
		});
		expect(result).toHaveLength(1);
		expect(result[0]?.variants).toEqual(
			expect.arrayContaining(["consistency", "output consistency"]),
		);
		expect(result[0]?.angles_count).toBe("2/5");
	});

	it("T-FN-02: distinct when similarity < 0.85", async () => {
		const result = await fuseInterAngle({
			byAngle: {
				etats_ideaux: [mc("consistency", ["claude"], "1/3")],
				taxonomie: [mc("reliability", ["gpt"], "1/3")],
			},
			embeddings: createMockEmbedding([["consistency", "reliability", 0.78]]),
		});
		expect(result).toHaveLength(2);
	});

	it("T-FN-03: canonical term = most frequent in cluster", async () => {
		const result = await fuseInterAngle({
			byAngle: {
				etats_ideaux: [mc("consistency", ["claude"], "3/3")],
				taxonomie: [mc("consistency", ["claude"], "3/3")],
				mecanismes_causaux: [mc("consistency", ["claude"], "3/3")],
				conditions_bord: [mc("output consistency", ["claude"], "1/3")],
			},
			embeddings: createMockEmbedding([
				["consistency", "output consistency", 0.92],
				["consistency", "consistency", 1.0],
			]),
		});
		const target = result.find((c) => c.canonical_term === "consistency");
		expect(target).toBeDefined();
		expect(target?.variants).toEqual(expect.arrayContaining(["consistency", "output consistency"]));
	});

	it("T-FN-04: angle provenance preserved across identical terms", async () => {
		const result = await fuseInterAngle({
			byAngle: {
				etats_ideaux: [mc("consistency", ["claude", "gpt", "gemini"], "3/3")],
				taxonomie: [mc("consistency", ["claude", "gpt"], "2/3")],
			},
			embeddings: createMockEmbedding([["consistency", "consistency", 1.0]]),
		});
		expect(result).toHaveLength(1);
		expect(result[0]?.angle_provenance.etats_ideaux?.consensus).toBe("3/3");
		expect(result[0]?.angle_provenance.taxonomie?.consensus).toBe("2/3");
		expect(result[0]?.angle_provenance.etats_ideaux?.models).toEqual(
			expect.arrayContaining(["claude", "gpt", "gemini"]),
		);
	});
});
