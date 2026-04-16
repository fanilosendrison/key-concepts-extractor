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

// Escape regex metacharacters so user-supplied term is matched as a literal.
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Cache compiled regex per NFC-normalized term. verifyCoverage runs N concepts
// × M variants regex compilations per invocation; the Unicode moteur is
// noticeably slower than ASCII, so memoizing by term pays off on larger runs.
// Map is module-scoped — fine for a single-process CLI, never grows unbounded
// beyond the set of distinct terms extracted across runs in the same process.
const patternCache = new Map<string, RegExp>();

// Unicode-aware word boundary.
// Two gotchas the naive fix missed: (1) NFD decomposition — "café" stored
// as "cafe" + U+0301 would match "cafe" inside because U+0301 (\p{M}) was
// treated as non-letter by the lookaround; normalize both sides to NFC.
// (2) The boundary class must also exclude combining marks (\p{M}) and
// connector punctuation (\p{Pc}, e.g. underscore) so "foo" doesn't match
// inside "foo_bar" or a base+mark sequence.
// Non-alphanum edges (intentional): when the term starts or ends with a
// non-letter/digit (e.g. "C++", ".NET", "#hashtag"), the lookaround on
// that side is vacuously satisfied against ANY following/preceding char.
// So "C++" matches inside "C++17" and ".NET" matches inside ".NETCore".
// This is the expected behavior for KCE — a word boundary only has
// meaning against a word character. Concepts with punctuation edges are
// matched greedily by design, not by oversight.
function checkExplicit(term: string, sourceText: string): boolean {
	const trimmed = term.trim().normalize("NFC");
	if (trimmed.length === 0) return false;
	let pattern = patternCache.get(trimmed);
	if (pattern === undefined) {
		pattern = new RegExp(
			`(?<![\\p{L}\\p{N}\\p{M}\\p{Pc}])${escapeRegex(trimmed)}(?![\\p{L}\\p{N}\\p{M}\\p{Pc}])`,
			"iu",
		);
		patternCache.set(trimmed, pattern);
	}
	return pattern.test(sourceText.normalize("NFC"));
}

function isFragile(concept: FinalConcept): boolean {
	if (concept.explicit_in_source) return false;
	// Split-derived concepts carry no real provenance (reset in withTerm per
	// NIB-M-QC §4.4). Not explicit in source + no trustworthy attribution =
	// fragile by definition.
	if (concept.derived_from !== undefined) return true;
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
