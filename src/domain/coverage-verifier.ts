import type { AngleId, FinalConcept } from "./types.js";

export interface CoverageInput {
	concepts: FinalConcept[];
	sourceText: string;
}

export interface CoverageStats {
	explicit: number;
	implicit: number;
	fragile: number;
}

export interface CoverageOutput {
	concepts: FinalConcept[];
	stats: CoverageStats;
}

function checkExplicit(term: string, sourceText: string): boolean {
	return sourceText.toLowerCase().includes(term.toLowerCase());
}

function isFragile(concept: FinalConcept): boolean {
	if (concept.explicit_in_source) return false;
	const angles = Object.keys(concept.angle_provenance) as AngleId[];
	if (angles.length !== 1) return false;
	const only = angles[0];
	if (!only) return false;
	return concept.angle_provenance[only]?.consensus === "1/3";
}

export function verifyCoverage(input: CoverageInput): CoverageOutput {
	const updated = input.concepts.map((concept) => {
		const termsToCheck = [concept.canonical_term, ...concept.variants];
		const explicit = termsToCheck.some((t) => checkExplicit(t, input.sourceText));
		return { ...concept, explicit_in_source: explicit };
	});

	return {
		concepts: updated,
		stats: {
			explicit: updated.filter((c) => c.explicit_in_source).length,
			implicit: updated.filter((c) => !c.explicit_in_source).length,
			fragile: updated.filter(isFragile).length,
		},
	};
}
