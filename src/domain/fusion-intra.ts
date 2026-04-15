import { distance } from "fastest-levenshtein";
import {
	type AngleId,
	CANONICAL_PROVIDERS,
	type Consensus,
	type MergedConcept,
	type ProviderId,
	type RawConcept,
} from "./types.js";

export interface IntraAngleInput {
	angle: AngleId;
	passes: Partial<Record<ProviderId, RawConcept[]>>;
	levenshteinThreshold?: number;
}

const DEFAULT_LEVENSHTEIN_THRESHOLD = 0.9;

interface TaggedConcept {
	concept: RawConcept;
	provider: ProviderId;
}

interface ConceptGroup {
	normalizedTerm: string;
	representativeTerm: string;
	members: TaggedConcept[];
}

function normalizeTerm(term: string): string {
	return term.toLowerCase().trim().replace(/\s+/g, " ");
}

function similarity(a: string, b: string): number {
	if (a === b) return 1;
	const max = Math.max(a.length, b.length);
	if (max === 0) return 1;
	return 1 - distance(a, b) / max;
}

function mostFrequent<T>(values: T[]): T {
	if (values.length === 0) throw new Error("mostFrequent: empty array");
	const counts = new Map<T, { count: number; firstIndex: number }>();
	values.forEach((v, i) => {
		const entry = counts.get(v);
		if (entry) entry.count++;
		else counts.set(v, { count: 1, firstIndex: i });
	});
	let best: T = values[0] as T;
	let bestCount = -1;
	let bestFirstIndex = Number.POSITIVE_INFINITY;
	for (const [value, { count, firstIndex }] of counts) {
		if (count > bestCount || (count === bestCount && firstIndex < bestFirstIndex)) {
			best = value;
			bestCount = count;
			bestFirstIndex = firstIndex;
		}
	}
	return best;
}

function consensusFor(providerCount: number): Consensus {
	if (providerCount >= 3) return "3/3";
	if (providerCount === 2) return "2/3";
	return "1/3";
}

export function fuseIntraAngle(input: IntraAngleInput): MergedConcept[] {
	const threshold = input.levenshteinThreshold ?? DEFAULT_LEVENSHTEIN_THRESHOLD;

	// Stable iteration order: claude, gpt, gemini
	const tagged: TaggedConcept[] = [];
	for (const provider of CANONICAL_PROVIDERS) {
		const concepts = input.passes[provider] ?? [];
		for (const concept of concepts) {
			tagged.push({ concept, provider });
		}
	}

	const groups: ConceptGroup[] = [];
	for (const item of tagged) {
		const normalized = normalizeTerm(item.concept.term);
		let matched: ConceptGroup | undefined;
		for (const group of groups) {
			if (group.normalizedTerm === normalized) {
				matched = group;
				break;
			}
			if (similarity(group.normalizedTerm, normalized) >= threshold) {
				matched = group;
				break;
			}
		}
		if (matched) {
			matched.members.push(item);
		} else {
			groups.push({
				normalizedTerm: normalized,
				representativeTerm: item.concept.term,
				members: [item],
			});
		}
	}

	groups.sort((a, b) => a.normalizedTerm.localeCompare(b.normalizedTerm));

	return groups.map((group) => {
		const providers: ProviderId[] = [];
		for (const m of group.members) {
			if (!providers.includes(m.provider)) providers.push(m.provider);
		}
		const category = mostFrequent(group.members.map((m) => m.concept.category));
		const explicit = group.members.some((m) => m.concept.explicit_in_source);
		const justifications = group.members
			.map((m) => m.concept.justification)
			.filter((j): j is string => typeof j === "string" && j.length > 0);

		return {
			term: group.representativeTerm,
			category,
			explicit_in_source: explicit,
			found_by_models: providers,
			consensus: consensusFor(providers.length),
			variants: [...new Set(group.members.map((m) => m.concept.term))],
			justifications,
		};
	});
}
