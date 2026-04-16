import type { EmbeddingAdapter } from "../../src/domain/ports.js";

// Produces unit vectors where cosine(a, b) == encoded similarity for each declared pair.
// Each unique term anchors its own orthogonal axis; pair partners are rotated in the
// anchor's 2D plane so dot(anchor, partner) == sim and both remain unit-norm.
// Limitation: a term may participate in at most one pair — either as anchor or as
// partner. Mixing roles across pairs would silently break the cosine==sim invariant
// for the earlier pair, so we throw rather than skip.
export function createMockEmbedding(
	similarPairs: Array<[string, string, number]>,
): EmbeddingAdapter {
	return {
		async embed(terms: string[]): Promise<number[][]> {
			const unique = [...new Set(terms)];
			const dim = unique.length * 2;
			const vecs = new Map<string, number[]>();

			unique.forEach((term, i) => {
				const base = new Array<number>(dim).fill(0);
				base[i * 2] = 1;
				vecs.set(term, base);
			});

			const used = new Set<string>();
			for (const [a, b, sim] of similarPairs) {
				if (a === b) continue;
				const ai = unique.indexOf(a);
				const bi = unique.indexOf(b);
				if (ai === -1 || bi === -1) continue;
				if (used.has(a) || used.has(b)) {
					throw new Error(
						`mock-embedding: term "${used.has(a) ? a : b}" appears in multiple pairs (anchor/partner reuse not supported)`,
					);
				}
				const clamped = Math.max(-1, Math.min(1, sim));
				const vec = new Array<number>(dim).fill(0);
				vec[ai * 2] = clamped;
				vec[ai * 2 + 1] = Math.sqrt(Math.max(0, 1 - clamped * clamped));
				vecs.set(b, vec);
				used.add(a);
				used.add(b);
			}

			return terms.map((t) => vecs.get(t) ?? []);
		},
	};
}
