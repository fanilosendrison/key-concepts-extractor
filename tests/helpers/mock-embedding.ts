import type { EmbeddingAdapter } from "../../src/domain/ports.js";

export function createMockEmbedding(
  similarPairs: Array<[string, string, number]>,
): EmbeddingAdapter {
  const pairMap = new Map<string, number>();
  for (const [a, b, sim] of similarPairs) {
    pairMap.set(`${a}||${b}`, sim);
    pairMap.set(`${b}||${a}`, sim);
  }

  return {
    async embed(terms: string[]): Promise<number[][]> {
      return terms.map((term, i) => {
        const vec = new Array(terms.length).fill(0) as number[];
        vec[i] = 1;
        for (let j = 0; j < terms.length; j++) {
          if (j === i) continue;
          const other = terms[j];
          if (other === undefined) continue;
          const sim = pairMap.get(`${term}||${other}`);
          if (sim !== undefined) vec[j] = sim;
        }
        return vec;
      });
    },
  };
}
