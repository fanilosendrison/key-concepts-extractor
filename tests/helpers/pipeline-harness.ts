import type { EmbeddingAdapter, ProviderAdapter } from "../../src/domain/ports.js";
import {
  CANONICAL_ANGLES,
  CANONICAL_PROVIDERS,
  type ProviderId,
  type RawConcept,
} from "../../src/domain/types.js";
import { createMockEmbedding } from "./mock-embedding.js";
import { createMockProvider } from "./mock-provider.js";
import { loadFixture, loadJsonFixture } from "./fixture-loader.js";
import { qualityR1, relevanceR1 } from "./control-responses.js";

function buildExtractionQueue(short: ProviderId): string[] {
  return CANONICAL_ANGLES.map((angle) => loadFixture(`extraction/${angle}-${short}.json`));
}

// 5 angle scopes + 1 inter_angle scope = 6 per control phase.
// Pipeline call order: quality on all 6 scopes, then relevance on all 6 scopes.
// With no-op R1 responses (zero errors flagged), only Round 1 fires per scope.
const NOOP_SCOPES_PER_PHASE = 6;

export interface PipelineHarness {
  anthropic: ProviderAdapter;
  openai: ProviderAdapter;
  google: ProviderAdapter;
  embeddings: EmbeddingAdapter;
}

export function createPipelineHarness(): PipelineHarness {
  const anthropicControls: string[] = [
    ...Array.from({ length: NOOP_SCOPES_PER_PHASE }, () => qualityR1([], 0)),
    ...Array.from({ length: NOOP_SCOPES_PER_PHASE }, () => relevanceR1([], 0)),
  ];

  const allTerms = new Set<string>();
  for (const angle of CANONICAL_ANGLES) {
    for (const short of CANONICAL_PROVIDERS) {
      const concepts = loadJsonFixture<RawConcept[]>(
        `extraction/${angle}-${short}.json`,
      );
      for (const c of concepts) allTerms.add(c.term);
    }
  }
  const similarityPairs: Array<[string, string, number]> = [];
  for (const t of allTerms) similarityPairs.push([t, t, 1.0]);

  return {
    anthropic: createMockProvider("anthropic", [
      ...buildExtractionQueue("claude"),
      ...anthropicControls,
    ]),
    openai: createMockProvider("openai", [
      ...buildExtractionQueue("gpt"),
      // No-op R1 path never reaches R2, so openai extraction-only queue suffices.
    ]),
    google: createMockProvider("google", buildExtractionQueue("gemini")),
    embeddings: createMockEmbedding(similarityPairs),
  };
}
