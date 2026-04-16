import { mostFrequent } from "./collection-utils.js";
import type { EmbeddingAdapter } from "./ports.js";
import {
	type AngleId,
	type AngleProvenanceEntry,
	type AnglesCount,
	DEFAULT_RUN_CONFIG,
	type FinalConcept,
	type MergedConcept,
	type ProviderId,
} from "./types.js";

export interface InterAngleInput {
	byAngle: Partial<Record<AngleId, MergedConcept[]>>;
	embeddings: EmbeddingAdapter;
	embeddingThreshold?: number;
	signal?: AbortSignal | undefined;
}

// Single source of truth for the 0.85 default lives in DEFAULT_RUN_CONFIG
// (NIB-S-KCE §3.15). Re-exported here for legacy direct callers of fuseInterAngle.
export const DEFAULT_EMBEDDING_THRESHOLD = DEFAULT_RUN_CONFIG.embedding_threshold;

interface TaggedItem {
	concept: MergedConcept;
	angle: AngleId;
	embedding: number[];
}

interface Cluster {
	members: TaggedItem[];
	centroid: number[];
}

// Cosine similarity per NIB-M-FUSION-INTER §4.2.
// Zero-norm vectors (either side) yield 0 rather than NaN — defensive.
function similarity(u: number[], v: number[]): number {
	const len = Math.min(u.length, v.length);
	let dot = 0;
	let normU = 0;
	let normV = 0;
	for (let i = 0; i < len; i++) {
		const a = u[i] ?? 0;
		const b = v[i] ?? 0;
		dot += a * b;
		normU += a * a;
		normV += b * b;
	}
	if (normU === 0 || normV === 0) return 0;
	return dot / (Math.sqrt(normU) * Math.sqrt(normV));
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
	input.signal?.throwIfAborted();
	const vectors = await input.embeddings.embed(uniqueTerms, { signal: input.signal });
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
		const granularity = mostFrequent(cluster.members.map((m) => m.concept.granularity));
		const explicit = cluster.members.some((m) => m.concept.explicit_in_source);
		const justifications = [
			...new Set(cluster.members.flatMap((m) => m.concept.justifications ?? [])),
		];

		const anglesCount = deriveAnglesCount(Object.keys(angleProv).length);

		// Propagate derivation: the FinalConcept is derived iff every cluster
		// member is itself derived. A single non-derived member means the
		// concept was grounded by a real extraction from at least one angle —
		// the derived pieces are subsumed by that real attribution.
		// Re-merge idempotency: when a future extraction pass re-clusters a
		// derived concept with a genuinely-extracted one (same term from
		// another angle), allDerived becomes false and derived_from is
		// dropped — the real extraction absorbs the synthetic one. This is
		// the desired behavior: once grounded by real provenance, the concept
		// is no longer synthetic. Heterogeneous derived_from values across
		// members (splits from different parents) are also collapsed: only
		// the first parent's identity is kept, which is acceptable because
		// the cluster merge already unified them into one canonical term.
		const allDerived = cluster.members.every((m) => m.concept.derived_from !== undefined);
		const derivedFrom = allDerived ? cluster.members[0]?.concept.derived_from : undefined;

		const final: FinalConcept = {
			canonical_term: canonical,
			variants,
			category,
			granularity,
			explicit_in_source: explicit,
			angle_provenance: angleProv,
			angles_count: anglesCount,
			justifications,
		};
		if (derivedFrom !== undefined) final.derived_from = derivedFrom;
		return final;
	});
}
