import type {
	AngleId,
	AngleProvenanceEntry,
	AnglesCount,
	Consensus,
	FinalConcept,
	MergedConcept,
	ProviderId,
	RawConcept,
} from "../../src/domain/types.js";

export function rawConcept(overrides: Partial<RawConcept> = {}): RawConcept {
	return {
		term: "concept",
		category: "property",
		explicit_in_source: true,
		...overrides,
	};
}

export function mergedConcept(overrides: Partial<MergedConcept> = {}): MergedConcept {
	const term = overrides.term ?? "concept";
	return {
		term,
		category: "property",
		explicit_in_source: true,
		found_by_models: ["claude"] as ProviderId[],
		consensus: "1/3" as Consensus,
		variants: [term],
		...overrides,
	};
}

export function finalConcept(overrides: Partial<FinalConcept> = {}): FinalConcept {
	const canonical = overrides.canonical_term ?? "concept";
	return {
		canonical_term: canonical,
		category: "property",
		granularity: "atomic",
		explicit_in_source: true,
		variants: [canonical],
		angles_count: "1/5" as AnglesCount,
		angle_provenance: {} as Partial<Record<AngleId, AngleProvenanceEntry>>,
		justifications: [],
		...overrides,
	};
}
