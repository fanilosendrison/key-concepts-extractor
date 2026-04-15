import { describe, expect, it } from "vitest";
import { verifyCoverage } from "../src/domain/coverage-verifier.js";
import type { FinalConcept } from "../src/domain/types.js";
import { finalConcept } from "./helpers/factories.js";

const fc = (overrides: Partial<FinalConcept> = {}) =>
	finalConcept({ canonical_term: "variance", explicit_in_source: false, ...overrides });

describe("CoverageVerifier", () => {
	it("T-CV-01: explicit term", () => {
		const result = verifyCoverage({
			concepts: [fc({ canonical_term: "variance" })],
			sourceText: "the variance of outputs",
		});
		expect(result.concepts[0]?.explicit_in_source).toBe(true);
	});

	it("T-CV-02: implicit term", () => {
		const result = verifyCoverage({
			concepts: [fc({ canonical_term: "consistency", variants: ["consistency"] })],
			sourceText: "the variance of outputs",
		});
		expect(result.concepts[0]?.explicit_in_source).toBe(false);
	});

	it("T-CV-03: variant match", () => {
		const result = verifyCoverage({
			concepts: [fc({ canonical_term: "variance", variants: ["variance", "output variance"] })],
			sourceText: "output variance was measured",
		});
		expect(result.concepts[0]?.explicit_in_source).toBe(true);
	});

	it("T-CV-04: fragile detection", () => {
		const result = verifyCoverage({
			concepts: [
				fc({
					canonical_term: "x",
					variants: ["x"],
					explicit_in_source: false,
					angle_provenance: {
						conditions_bord: { consensus: "1/3", models: ["claude"] },
					},
				}),
			],
			sourceText: "nothing",
		});
		expect(result.stats.fragile).toBe(1);
	});

	it("P-03: idempotent", () => {
		const input = {
			concepts: [fc({ canonical_term: "variance", variants: ["variance"] })],
			sourceText: "the variance of outputs",
		};
		const r1 = verifyCoverage(input);
		const r2 = verifyCoverage({ concepts: r1.concepts, sourceText: input.sourceText });
		expect(r2.concepts).toEqual(r1.concepts);
	});
});
