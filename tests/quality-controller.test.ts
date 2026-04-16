import { describe, expect, it } from "vitest";
import { runQualityControl } from "../src/domain/quality-controller.js";
import { qualityR1, qualityR2, qualityR3 } from "./helpers/control-responses.js";
import { mergedConcept } from "./helpers/factories.js";
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
				{ target: "consistency / reliability", verdict: "confirmed", justification: "agree" },
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
				{ target: "temperature", verdict: "contested", justification: "is a constraint" },
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
				[{ target: "consistency", verdict: "confirmed", justification: "agree" }],
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
