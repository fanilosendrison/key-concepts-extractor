import { describe, expect, it } from "vitest";
import { runQualityControl } from "../src/domain/quality-controller.js";
import type { FinalConcept } from "../src/domain/types.js";
import { qualityR1, qualityR2, qualityR3 } from "./helpers/control-responses.js";
import { finalConcept, mergedConcept } from "./helpers/factories.js";
import { createMockProvider } from "./helpers/mock-provider.js";

const mc = (term: string) => mergedConcept({ term });

describe("QualityController", () => {
	it("T-QC-01: no errors → 1 round", async () => {
		const list = [mc("consistency"), mc("variance")];
		const anthropic = createMockProvider("anthropic", [qualityR1([], 10)]);
		const openai = createMockProvider("openai", []);
		const result = await runQualityControl({
			mergedList: list,
			context: "source",
			scope: "angle:etats_ideaux",
			anthropic,
			openai,
		});
		expect(result.report.review_rounds).toBe(1);
		expect(result.report.corrections).toEqual([]);
		expect(result.correctedList).toEqual(list);
		expect(anthropic.remaining).toBe(0);
		expect(openai.calls).toHaveLength(0);
	});

	it("T-QC-02: abusive_merge flagged+confirmed → 2 rounds, real split into N concepts", async () => {
		const anthropic = createMockProvider("anthropic", [
			qualityR1([
				{
					target: "consistency / reliability",
					error_type: "abusive_merge",
					justification: "merged distinct properties",
					suggested_split: ["consistency", "reliability"],
				},
			]),
		]);
		const openai = createMockProvider("openai", [
			qualityR2([
				{
					target: "consistency / reliability",
					claude_error_type: "abusive_merge",
					verdict: "confirmed",
					justification: "agree",
				},
			]),
		]);
		const result = await runQualityControl({
			mergedList: [mc("consistency / reliability")],
			context: "source",
			scope: "angle:etats_ideaux",
			anthropic,
			openai,
		});
		expect(result.report.review_rounds).toBe(2);
		expect(result.report.corrections).toHaveLength(1);
		expect(result.report.corrections[0]?.error_type).toBe("abusive_merge");
		expect(result.report.corrections[0]?.suggested_split).toEqual(["consistency", "reliability"]);
		// NIB-M-QC §4.4 line 189-191 : split concepts built from `suggested_split`
		// with `term` and `variants` overridden in the array order provided by the LLM.
		expect(result.correctedList.map((c) => c.term)).toEqual(["consistency", "reliability"]);
		// Provenance reset invariant: every split concept carries derived_from
		// pointing at the parent, and its provenance fields are wiped.
		for (const c of result.correctedList) {
			expect(c.derived_from).toBe("consistency / reliability");
			expect(c.found_by_models).toEqual([]);
			expect(c.consensus).toBe("1/3");
			expect(c.justifications).toEqual([]);
		}
	});

	it("T-QC-03: contested → R3 resolves as corrected → 3 rounds", async () => {
		const anthropic = createMockProvider("anthropic", [
			qualityR1([
				{
					target: "temperature",
					error_type: "incorrect_categorization",
					justification: "is a property",
				},
			]),
			qualityR3([{ target: "temperature", decision: "corrected", reasoning: "doubt = correct" }]),
		]);
		const openai = createMockProvider("openai", [
			qualityR2([
				{
					target: "temperature",
					claude_error_type: "incorrect_categorization",
					verdict: "contested",
					justification: "is a constraint",
				},
			]),
		]);
		const result = await runQualityControl({
			mergedList: [mc("temperature")],
			context: "source",
			scope: "angle:etats_ideaux",
			anthropic,
			openai,
		});
		expect(result.report.review_rounds).toBe(3);
		expect(result.report.corrections).toHaveLength(1);
	});

	it("T-QC-04: GPT additional error confirmed by Claude in R3 → 3 rounds", async () => {
		const anthropic = createMockProvider("anthropic", [
			qualityR1([
				{
					target: "consistency",
					error_type: "abusive_merge",
					justification: "x",
					suggested_split: ["consistency_a", "consistency_b"],
				},
			]),
			qualityR3([{ target: "caching", decision: "corrected", reasoning: "ok" }]),
		]);
		const openai = createMockProvider("openai", [
			qualityR2(
				[
					{
						target: "consistency",
						claude_error_type: "abusive_merge",
						verdict: "confirmed",
						justification: "agree",
					},
				],
				[
					{
						target: "caching",
						error_type: "incorrect_categorization",
						justification: "method not property",
					},
				],
			),
		]);
		const result = await runQualityControl({
			mergedList: [mc("consistency"), mc("caching")],
			context: "source",
			scope: "angle:etats_ideaux",
			anthropic,
			openai,
		});
		expect(result.report.review_rounds).toBe(3);
		const targets = result.report.corrections.map((c) => c.target);
		expect(targets).toContain("caching");
	});

	it("T-QC-MINIMAL: parser accepts bare-minimum LLM JSON (spec-mandated extras omitted)", async () => {
		// Bypass the helpers on purpose: validate parser tolerance against an LLM
		// that omits every spec-optional field across all 3 rounds. R2 contests
		// so R3 is actually consumed — otherwise R3's bare-minimum shape would
		// be untested and the parser tolerance on R3 would only appear covered.
		const r1Bare = JSON.stringify({
			errors_found: [
				{
					target: "consistency / reliability",
					error_type: "abusive_merge",
					suggested_split: ["consistency", "reliability"],
				},
			],
		});
		const r2Bare = JSON.stringify({
			reviews_of_claude: [{ target: "consistency / reliability", verdict: "contested" }],
			// claude_error_type intentionally omitted to exercise parser tolerance
			// on the spec-mandated field — the production Zod schema treats it as
			// optional, so a minimal LLM response must still parse.
		});
		const r3Bare = JSON.stringify({
			final_decisions: [
				{
					target: "consistency / reliability",
					decision: "corrected",
					suggested_split: ["consistency", "reliability"],
				},
			],
		});
		const anthropic = createMockProvider("anthropic", [r1Bare, r3Bare]);
		const openai = createMockProvider("openai", [r2Bare]);
		const result = await runQualityControl({
			mergedList: [mc("consistency / reliability")],
			context: "source",
			scope: "angle:etats_ideaux",
			anthropic,
			openai,
		});
		expect(result.report.review_rounds).toBe(3);
		expect(anthropic.remaining).toBe(0);
		expect(result.correctedList.map((c) => c.term).sort()).toEqual(["consistency", "reliability"]);
	});

	it("T-QC-02-INTER: abusive_merge split on FinalConcept resets inter-angle provenance", async () => {
		// Locks the same reset invariant as T-QC-02 (MergedConcept / angle-level)
		// on the FinalConcept / inter-angle path that pipeline.ts exercises via
		// runQualityControl<FinalConcept>. Without this, a future edit to the
		// FinalConcept branch of `deriveSplit` that forgets to reset
		// `angle_provenance` or `angles_count` would silently inflate diagnostics
		// and coverage — no test would catch it.
		const parent: FinalConcept = finalConcept({
			canonical_term: "consistency / reliability",
			angle_provenance: {
				etats_ideaux: { consensus: "3/3", models: ["claude", "gpt", "gemini"] },
				taxonomie: { consensus: "2/3", models: ["claude", "gpt"] },
			},
			angles_count: "2/5",
			justifications: ["parent j1", "parent j2"],
		});
		const anthropic = createMockProvider("anthropic", [
			qualityR1([
				{
					target: "consistency / reliability",
					error_type: "abusive_merge",
					justification: "merged distinct properties",
					suggested_split: ["consistency", "reliability"],
				},
			]),
		]);
		const openai = createMockProvider("openai", [
			qualityR2([
				{
					target: "consistency / reliability",
					claude_error_type: "abusive_merge",
					verdict: "confirmed",
					justification: "agree",
				},
			]),
		]);
		const result = await runQualityControl<FinalConcept>({
			mergedList: [parent],
			context: "source",
			scope: "inter_angle",
			anthropic,
			openai,
		});
		expect(result.correctedList.map((c) => c.canonical_term)).toEqual([
			"consistency",
			"reliability",
		]);
		for (const c of result.correctedList) {
			expect(c.derived_from).toBe("consistency / reliability");
			expect(c.angle_provenance).toEqual({});
			expect(c.angles_count).toBe("1/5");
			expect(c.justifications).toEqual([]);
			expect(c.variants).toEqual([c.canonical_term]);
			// Inheritance (NIB-M-QC §4.4): these hold after splitting.
			expect(c.category).toBe(parent.category);
			expect(c.granularity).toBe(parent.granularity);
			expect(c.explicit_in_source).toBe(parent.explicit_in_source);
		}
	});

	it("P-08: quality never decreases count", async () => {
		const input = [mc("a"), mc("b")];
		const result = await runQualityControl({
			mergedList: input,
			context: "source",
			scope: "angle:etats_ideaux",
			anthropic: createMockProvider("anthropic", [qualityR1([], 2)]),
			openai: createMockProvider("openai", []),
		});
		expect(result.correctedList.length).toBeGreaterThanOrEqual(input.length);
	});
});
