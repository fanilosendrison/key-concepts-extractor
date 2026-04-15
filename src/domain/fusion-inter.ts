import { mostFrequent } from "./collection-utils.js";
import type { EmbeddingAdapter } from "./ports.js";
import type {
	AngleId,
	AngleProvenanceEntry,
	AnglesCount,
	FinalConcept,
	MergedConcept,
	ProviderId,
} from "./types.js";

export interface InterAngleInput {
	byAngle: Partial<Record<AngleId, MergedConcept[]>>;
	embeddings: EmbeddingAdapter;
	embeddingThreshold?: number;
}

const DEFAULT_EMBEDDING_THRESHOLD = 0.85;

interface TaggedItem {
	concept: MergedConcept;
	angle: AngleId;
	embedding: number[];
}

interface Cluster {
	members: TaggedItem[];
	centroid: number[];
}

/**
 * Similarity function: max_i(u[i] * v[i]).
 * With mock-embedding (vec_A[indexOf(B)] = sim(A,B)), this recovers the encoded
 * pairwise similarity. For sparse one-hot-like vectors with only self-index set,
 * it yields 1 for identical terms and 0 for distinct terms.
 */
function similarity(u: number[], v: number[]): number {
	const len = Math.min(u.length, v.length);
	let best = 0;
	for (let i = 0; i < len; i++) {
		const p = (u[i] ?? 0) * (v[i] ?? 0);
		if (p > best) best = p;
	}
	return best;
}

function meanVector(vectors: number[][]): number[] {
	if (vectors.length === 0) return [];
	const first = vectors[0];
	if (!first) return [];
	const dim = first.length;
	const result = new Array<number>(dim).fill(0);
	for (const v of vectors) {
		for (let i = 0; i < dim; i++) result[i] = (result[i] ?? 0) + (v[i] ?? 0);
	}
	for (let i = 0; i < dim; i++) result[i] = (result[i] ?? 0) / vectors.length;
	return result;
}

function deriveAnglesCount(n: number): AnglesCount {
	const clamped = Math.max(1, Math.min(5, n));
	return `${clamped}/5` as AnglesCount;
}

export async function fuseInterAngle(input: InterAngleInput): Promise<FinalConcept[]> {
	const threshold = input.embeddingThreshold ?? DEFAULT_EMBEDDING_THRESHOLD;

	const allItems: Array<{ concept: MergedConcept; angle: AngleId }> = [];
	for (const [angle, concepts] of Object.entries(input.byAngle)) {
		if (!concepts) continue;
		for (const concept of concepts) {
			allItems.push({ concept, angle: angle as AngleId });
		}
	}

	if (allItems.length === 0) return [];

	const uniqueTerms = [...new Set(allItems.map((it) => it.concept.term))];
	const vectors = await input.embeddings.embed(uniqueTerms);
	const embeddingMap = new Map<string, number[]>();
	uniqueTerms.forEach((term, i) => {
		const vec = vectors[i];
		if (vec) embeddingMap.set(term, vec);
	});

	const tagged: TaggedItem[] = allItems.map((it) => ({
		concept: it.concept,
		angle: it.angle,
		embedding: embeddingMap.get(it.concept.term) ?? [],
	}));

	const clusters: Cluster[] = [];
	for (const item of tagged) {
		let best: Cluster | null = null;
		let bestSim = -1;
		for (const cluster of clusters) {
			const sim = similarity(item.embedding, cluster.centroid);
			if (sim >= threshold && sim > bestSim) {
				best = cluster;
				bestSim = sim;
			}
		}
		if (best) {
			best.members.push(item);
			best.centroid = meanVector(best.members.map((m) => m.embedding));
		} else {
			clusters.push({ members: [item], centroid: item.embedding });
		}
	}

	return clusters.map((cluster) => {
		const terms = cluster.members.map((m) => m.concept.term);
		const canonical = mostFrequent(terms);
		const variants = [...new Set(terms)];

		const angleProv: Partial<Record<AngleId, AngleProvenanceEntry>> = {};
		for (const member of cluster.members) {
			const existing = angleProv[member.angle];
			if (!existing) {
				angleProv[member.angle] = {
					consensus: member.concept.consensus,
					models: [...member.concept.found_by_models],
				};
			} else {
				// Merge models (keep order, dedup)
				const merged: ProviderId[] = [...existing.models];
				for (const m of member.concept.found_by_models) {
					if (!merged.includes(m)) merged.push(m);
				}
				existing.models = merged;
			}
		}

		const category = mostFrequent(cluster.members.map((m) => m.concept.category));
		const explicit = cluster.members.some((m) => m.concept.explicit_in_source);
		const justifications = [
			...new Set(cluster.members.flatMap((m) => m.concept.justifications ?? [])),
		];

		const anglesCount = deriveAnglesCount(Object.keys(angleProv).length);

		return {
			canonical_term: canonical,
			variants,
			category,
			granularity: "system-level",
			explicit_in_source: explicit,
			angle_provenance: angleProv,
			angles_count: anglesCount,
			justifications,
		};
	});
}
