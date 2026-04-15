import { describe, expect, it } from "vitest";
import { runRelevanceControl } from "../src/domain/relevance-controller.js";
import { relevanceR1, relevanceR2, relevanceR3 } from "./helpers/control-responses.js";
import { mergedConcept } from "./helpers/factories.js";
import { createMockProvider } from "./helpers/mock-provider.js";

const mc = (term: string) => mergedConcept({ term });

describe("RelevanceController", () => {
	it("T-RC-01: no flags → 1 round", async () => {
		const list = [mc("a"), mc("b")];
		const anthropic = createMockProvider("anthropic", [relevanceR1([], 10)]);
		const openai = createMockProvider("openai", []);
		const result = await runRelevanceControl({
			mergedList: list,
			context: "source",
			scope: "angle:etats_ideaux",
			anthropic,
			openai,
		});
		expect(result.report.review_rounds).toBe(1);
		expect(result.report.removed).toEqual([]);
		expect(result.filteredList).toEqual(list);
		expect(openai.calls).toHaveLength(0);
	});

	it("T-RC-02: flagged and confirmed → removed", async () => {
		const anthropic = createMockProvider("anthropic", [
			relevanceR1([{ term: "blockchain", justification: "unrelated" }]),
		]);
		const openai = createMockProvider("openai", [
			relevanceR2([{ term: "blockchain", verdict: "confirmed_off_topic", justification: "agree" }]),
		]);
		const result = await runRelevanceControl({
			mergedList: [mc("blockchain"), mc("a")],
			context: "source",
			scope: "angle:etats_ideaux",
			anthropic,
			openai,
		});
		expect(result.report.review_rounds).toBe(2);
		expect(result.report.removed.map((r) => r.term)).toContain("blockchain");
		expect(result.filteredList.find((c) => c.term === "blockchain")).toBeUndefined();
	});

	it("T-RC-03: flagged but defended → R3 fires, retained", async () => {
		// Per NIB-M-RELEVANCE-CONTROLLER §4.2 : defended verdict triggers R3.
		const anthropic = createMockProvider("anthropic", [
			relevanceR1([{ term: "caching", justification: "seems off-topic" }]),
			relevanceR3([]),
		]);
		const openai = createMockProvider("openai", [
			relevanceR2([{ term: "caching", verdict: "defended", justification: "affects consistency" }]),
		]);
		const result = await runRelevanceControl({
			mergedList: [mc("caching")],
			context: "source",
			scope: "angle:etats_ideaux",
			anthropic,
			openai,
		});
		expect(result.report.review_rounds).toBe(3);
		expect(result.report.retained_after_dispute.map((r) => r.term)).toContain("caching");
		expect(result.filteredList.find((c) => c.term === "caching")).toBeDefined();
	});

	it("T-RC-04: R2 confirms 1, defends 2 → 1 removed, 2 retained", async () => {
		const anthropic = createMockProvider("anthropic", [
			relevanceR1([
				{ term: "x", justification: "off" },
				{ term: "y", justification: "off" },
				{ term: "z", justification: "off" },
			]),
			relevanceR3([]),
		]);
		const openai = createMockProvider("openai", [
			relevanceR2([
				{ term: "x", verdict: "confirmed_off_topic", justification: "" },
				{ term: "y", verdict: "defended", justification: "relevant" },
				{ term: "z", verdict: "defended", justification: "relevant" },
			]),
		]);
		const result = await runRelevanceControl({
			mergedList: [mc("x"), mc("y"), mc("z")],
			context: "source",
			scope: "angle:etats_ideaux",
			anthropic,
			openai,
		});
		expect(result.report.concepts_removed).toBe(1);
		expect(result.report.concepts_retained_after_dispute).toBe(2);
	});

	it("T-RC-05: GPT additional_flag removed via R3 → removed with flagged_by gpt", async () => {
		const anthropic = createMockProvider("anthropic", [
			relevanceR1([{ term: "x", justification: "off" }]),
			relevanceR3([
				{ term: "y", origin: "gpt_round2", decision: "removed", reasoning: "confirm gpt" },
			]),
		]);
		const openai = createMockProvider("openai", [
			relevanceR2(
				[{ term: "x", verdict: "confirmed_off_topic", justification: "agree" }],
				[{ term: "y", justification: "also off" }],
			),
		]);
		const result = await runRelevanceControl({
			mergedList: [mc("x"), mc("y"), mc("z")],
			context: "source",
			scope: "angle:etats_ideaux",
			anthropic,
			openai,
		});
		expect(result.report.review_rounds).toBe(3);
		expect(result.report.concepts_removed).toBe(2);
		const y = result.report.removed.find((r) => r.term === "y");
		expect(y?.flagged_by).toBe("gpt");
		expect(y?.confirmed_by).toBe("claude");
		expect(result.filteredList.find((c) => c.term === "y")).toBeUndefined();
	});

	it("P-07: never adds concepts", async () => {
		const input = [mc("a"), mc("b"), mc("c")];
		const result = await runRelevanceControl({
			mergedList: input,
			context: "source",
			scope: "angle:etats_ideaux",
			anthropic: createMockProvider("anthropic", [relevanceR1([], 3)]),
			openai: createMockProvider("openai", []),
		});
		expect(result.filteredList.length).toBeLessThanOrEqual(input.length);
	});
});
