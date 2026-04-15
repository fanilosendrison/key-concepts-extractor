---
id: NIB-M-FUSION-INTER
type: nib-module
version: "1.0.0"
scope: key-concepts-extractor/fusion-inter-angle
status: approved
consumers: [claude-code]
superseded_by: []
---

---

## 1. Purpose

Takes the 5 post-control intra-angle concept lists and merges them into a single final list using semantic similarity (embedding-based clustering). Preserves angle provenance and inter-model consensus per angle. Selects a canonical term for each cluster.

---

## 2. Inputs

```typescript
interface FusionInterInput {
  angleLists: FusionIntraOutput[];    // Exactly 5 (one per angle, post-controls)
  embeddingThreshold: number;         // Default 0.85, configurable
}
// Also receives (injected):
//   embeddingAdapter: EmbeddingAdapter
```

---

## 3. Outputs

```typescript
interface FusionInterOutput {
  concepts: FinalConcept[];
}
interface FinalConcept {
  canonical_term: string;             // Most frequent term in cluster
  variants: string[];                 // All distinct terms in cluster
  category: ConceptCategory;
  granularity: GranularityLevel;
  explicit_in_source: boolean;        // true if ANY member is explicit
  angle_provenance: Record<AngleId, {
    consensus: '1/3' | '2/3' | '3/3';
    models: ProviderId[];
  }>;
  angles_count: AnglesCount;          // '1/5' | '2/5' | '3/5' | '4/5' | '5/5'
  justifications: string[];           // All unique justifications
}
```

---

## 4. Algorithm

### 4.1 EmbeddingAdapter interface

```typescript
interface EmbeddingAdapter {
  embed(texts: string[]): Promise<number[][]>;  // Returns one vector per text
}
```

Implemented using the OpenAI Embeddings API (model configurable, default: text-embedding-3-small). See DC-OPENAI-EMBEDDINGS for contract.

### 4.2 cosineSimilarity(a, b)

```javascript
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

### 4.3 clusterBySimilarity(items, threshold)

Single-pass greedy clustering: for each item, find the first existing cluster whose centroid (average embedding) has cosine similarity ≥ threshold. If found, add to cluster and recompute centroid. If not found, create new cluster.

```javascript
function clusterBySimilarity(
  items: { term: string; embedding: number[]; source: TaggedIntraConcept }[],
  threshold: number
): Cluster[] {
  const clusters: Cluster[] = [];

  for (const item of items) {
    let bestCluster: Cluster | null = null;
    let bestSim = -1;

    for (const cluster of clusters) {
      const sim = cosineSimilarity(item.embedding, cluster.centroid);
      if (sim >= threshold && sim > bestSim) {
        bestCluster = cluster;
        bestSim = sim;
      }
    }

    if (bestCluster) {
      bestCluster.members.push(item);
      // Recompute centroid as mean of all member embeddings
      bestCluster.centroid = meanVector(bestCluster.members.map(m => m.embedding));
    } else {
      clusters.push({
        centroid: item.embedding,
        members: [item],
      });
    }
  }

  return clusters;
}

interface Cluster {
  centroid: number[];
  members: { term: string; embedding: number[]; source: TaggedIntraConcept }[];
}

interface TaggedIntraConcept {
  concept: IntraAngleConcept;
  angle: AngleId;
}
```

### 4.4 resolveCluster(cluster)

```javascript
function resolveCluster(cluster: Cluster): FinalConcept {
  // canonical_term: most frequent term (by count of occurrences across angles)
  const termCounts = countOccurrences(cluster.members.map(m => m.term.toLowerCase()));
  const canonical = cluster.members.find(
    m => m.term.toLowerCase() === mostFrequentKey(termCounts)
  )!.term;

  // variants: all distinct terms in the cluster
  const variants = [...new Set(cluster.members.map(m => m.term))];

  // angle_provenance: for each angle present, consensus and models
  const provenance: Record<string, { consensus: string; models: string[] }> = {};
  for (const member of cluster.members) {
    provenance[member.source.angle] = {
      consensus: member.source.concept.consensus,
      models: member.source.concept.found_by_models,
    };
  }

  const anglesCount = `${Object.keys(provenance).length}/5`;

  // category/granularity: most frequent across members
  const category = mostFrequent(cluster.members.map(m => m.source.concept.category));
  const granularity = mostFrequent(cluster.members.map(m => m.source.concept.granularity));

  // explicit_in_source: true if ANY member is explicit
  const explicit = cluster.members.some(m => m.source.concept.explicit_in_source);

  // justifications: all unique justification strings
  const justifications = [...new Set(
    cluster.members.flatMap(m => Object.values(m.source.concept.justifications))
  )];

  return {
    canonical_term: canonical,
    variants,
    category,
    granularity,
    explicit_in_source: explicit,
    angle_provenance: provenance as any,
    angles_count: anglesCount,
    justifications,
  };
}
```

### 4.5 fuse(input) — main entry point

```javascript
async function fuse(input: FusionInterInput): Promise<FusionInterOutput> {
  // 1. Flatten all concepts from 5 angle lists, tagging each with its angle
  const allItems: TaggedIntraConcept[] = input.angleLists.flatMap(angleList =>
    angleList.concepts.map(concept => ({ concept, angle: angleList.angle }))
  );

  // 2. Extract all unique terms for embedding
  const uniqueTerms = [...new Set(allItems.map(item => item.concept.term))];

  // 3. Batch embed all terms
  const embeddings = await embeddingAdapter.embed(uniqueTerms);
  const embeddingMap = new Map(uniqueTerms.map((term, i) => [term, embeddings[i]]));

  // 4. Build items with embeddings
  const embeddedItems = allItems.map(item => ({
    term: item.concept.term,
    embedding: embeddingMap.get(item.concept.term)!,
    source: item,
  }));

  // 5. Cluster by semantic similarity
  const clusters = clusterBySimilarity(embeddedItems, input.embeddingThreshold);

  // 6. Resolve each cluster into a FinalConcept
  const concepts = clusters.map(resolveCluster);

  return { concepts };
}
```

---

## 5. Examples

### 5.1 Semantic merge across angles

```javascript
Angle etats_ideaux: { term: "consistency", consensus: "3/3" }
Angle taxonomie:    { term: "output consistency", consensus: "2/3" }
Angle extraction:   { term: "consistency", consensus: "1/3" }

Embeddings: cosine("consistency", "output consistency") = 0.92 > 0.85
All three merge into one cluster.

Output: {
  canonical_term: "consistency",  // Most frequent
  variants: ["consistency", "output consistency"],
  angle_provenance: {
    etats_ideaux: { consensus: "3/3", models: ["claude", "gpt", "gemini"] },
    taxonomie: { consensus: "2/3", models: ["claude", "gemini"] },
    extraction_directe: { consensus: "1/3", models: ["gpt"] }
  },
  angles_count: "3/5"
}
```

### 5.2 Distinct concepts remain separate

```javascript
"consistency" and "reliability": cosine similarity = 0.78 < 0.85 → separate clusters
```

---

## 6. Edge cases

| Case | Expected behavior |
|---|---|
| Same term appears in multiple angles with different categories | Most frequent category wins |
| Embedding API returns error | Fatal error (uses ProviderAdapter retry logic via EmbeddingAdapter) |
| Threshold = 1.0 | Only exact embedding matches (practically never) → no clustering |
| Threshold = 0.0 | Everything clusters together → single concept. Degenerate. |
| Large number of terms (>200) | Embedding API called in batch. See DC-OPENAI-EMBEDDINGS for batch limits. |

---

## 7. Constraints

- **One LLM-adjacent call** — the embedding call. Not counted in the 87 API call budget (embeddings are not generative LLM calls).
- **Greedy clustering** — order-dependent. Input order is deterministic (angles in fixed order, concepts in order from intra-angle fusion).
- **No modifications to intra-angle data** — reads only. Angle provenance is preserved losslessly.

---

## 8. Integration

```typescript
// In pipeline orchestrator (Phase 4):
const interResult = await FusionInterAngle.fuse({
  angleLists: intraResults,  // 5 post-control lists
  embeddingThreshold: config.embeddingThreshold,
});
// Then pass interResult.concepts to QualityController, then RelevanceController
```
