import type { EmbeddingAdapter } from "./ports.js";
import type { AngleId, FinalConcept, MergedConcept } from "./types.js";

export interface InterAngleInput {
  byAngle: Partial<Record<AngleId, MergedConcept[]>>;
  embeddings: EmbeddingAdapter;
}

export function fuseInterAngle(_input: InterAngleInput): Promise<FinalConcept[]> {
  throw new Error("Not implemented");
}
