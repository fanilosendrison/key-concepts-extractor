---
id: NIB-M-FUSION-INTRA
type: nib-module
version: "1.0.0"
scope: key-concepts-extractor/fusion-intra-angle
status: approved
validates: [src/domain/fusion-intra.ts, tests/fusion-intra.test.ts]
consumers: [claude-code]
superseded_by: []
---

---

## 1. Purpose

For a single angle, takes the 3 provider extraction outputs and produces a deduplicated list with inter-model consensus scores. Uses exact and near-exact string matching only (no semantic similarity — that is FusionInterAngle's responsibility).

---

## 2. Inputs

```typescript
interface FusionIntraInput {
  angle: AngleId;
  passes: ExtractionPass[];           // Exactly 3 (one per provider)
  levenshteinThreshold: number;       // Default 0.9, configurable
}
```

Provenance: ExtractionOrchestrator output, filtered by angle.

---

## 3. Outputs

```typescript
interface FusionIntraOutput {
  angle: AngleId;
  concepts: IntraAngleConcept[];
}
interface IntraAngleConcept {
  term: string;                       // Representative term of the group
  consensus: '1/3' | '2/3' | '3/3';
  found_by_models: ProviderId[];
  category: ConceptCategory;          // Most frequent, or first if tie
  granularity: GranularityLevel;      // Most frequent, or first if tie
  explicit_in_source: boolean;        // true if ANY provider marked it true
  justifications: Record<ProviderId, string>;
}
```

---

## 4. Algorithm

### 4.1 normalize(term)

```javascript
function normalize(term: string): string {
  return term.toLowerCase().trim().replace(/\s+/g, ' ');
}
```

### 4.2 levenshteinSimilarity(a, b)

```javascript
function levenshteinSimilarity(a: string, b: string): number {
  // Standard Levenshtein distance, converted to similarity:
  // similarity = 1 - (distance / max(a.length, b.length))
  // Returns value between 0 and 1.
}
```

### 4.3 groupConcepts(allConcepts, threshold)

This is the core deduplication algorithm.

```javascript
function groupConcepts(
  allConcepts: { concept: RawConcept; provider: ProviderId }[],
  threshold: number
): ConceptGroup[] {
  const groups: ConceptGroup[] = [];

  for (const item of allConcepts) {
    const normalizedTerm = normalize(item.concept.term);
    let matched = false;

    for (const group of groups) {
      // Check exact match first
      if (group.normalizedTerm === normalizedTerm) {
        group.members.push(item);
        matched = true;
        break;
      }
      // Check near-exact match (Levenshtein)
      if (levenshteinSimilarity(group.normalizedTerm, normalizedTerm) >= threshold) {
        group.members.push(item);
        matched = true;
        break;
      }
    }

    if (!matched) {
      groups.push({
        normalizedTerm,
        representativeTerm: item.concept.term,  // First occurrence keeps original casing
        members: [item],
      });
    }
  }

  return groups;
}

interface ConceptGroup {
  normalizedTerm: string;
  representativeTerm: string;
  members: { concept: RawConcept; provider: ProviderId }[];
}
```

### 4.4 resolveGroup(group)

```javascript
function resolveGroup(group: ConceptGroup): IntraAngleConcept {
  const providers = [...new Set(group.members.map(m => m.provider))];
  const consensusMap: Record<number, '1/3' | '2/3' | '3/3'> = { 1: '1/3', 2: '2/3', 3: '3/3' };

  // Category: most frequent among members. Tie-break: first encountered.
  const category = mostFrequent(group.members.map(m => m.concept.category));
  // Granularity: same logic.
  const granularity = mostFrequent(group.members.map(m => m.concept.granularity));
  // explicit_in_source: true if ANY member marked it true.
  const explicit = group.members.some(m => m.concept.explicit_in_source);
  // Justifications: one per provider. If multiple members from same provider (shouldn't happen
  // with 3 providers, but defensive), keep the first.
  const justifications: Record<ProviderId, string> = {};
  for (const member of group.members) {
    if (!justifications[member.provider]) {
      justifications[member.provider] = member.concept.justification;
    }
  }

  return {
    term: group.representativeTerm,
    consensus: consensusMap[providers.length],
    found_by_models: providers,
    category,
    granularity,
    explicit_in_source: explicit,
    justifications,
  };
}
```

### 4.5 fuse(input) — main entry point

```javascript
function fuse(input: FusionIntraInput): FusionIntraOutput {
  // Flatten all concepts from 3 passes into a single list with provider tag
  const allConcepts = input.passes.flatMap(pass =>
    pass.concepts.map(concept => ({ concept, provider: pass.provider }))
  );

  // Group by exact + near-exact match
  const groups = groupConcepts(allConcepts, input.levenshteinThreshold);

  // Resolve each group into a single IntraAngleConcept
  const concepts = groups.map(resolveGroup);

  return { angle: input.angle, concepts };
}
```

---

## 5. Examples

### 5.1 Three providers find the same concept

```javascript
Input passes:
  claude: { term: "consistency", category: "property", ... }
  gpt:    { term: "Consistency", category: "property", ... }
  gemini: { term: "consistency", category: "property", ... }

After normalize: all → "consistency" → exact match → single group
Output: { term: "consistency", consensus: "3/3", found_by_models: ["claude", "gpt", "gemini"], ... }
```

### 5.2 Near-exact match

```javascript
  claude: { term: "output consistency", ... }
  gpt:    { term: "output-consistency", ... }   // Levenshtein similarity ≈ 0.94 > 0.9
  gemini: { term: "response stability", ... }   // Levenshtein similarity ≈ 0.35 < 0.9

Groups: ["output consistency", "output-consistency"] (consensus 2/3) + ["response stability"] (consensus 1/3)
```

### 5.3 Same provider finds duplicate terms

```javascript
  claude: [{ term: "variance" }, { term: "Variance" }]
  gpt:    [{ term: "variance" }]

After grouping: single group with 3 members, but only 2 distinct providers.
Output: { consensus: "2/3", found_by_models: ["claude", "gpt"] }
(Claude counted once even though it produced the term twice.)
```

---

## 6. Edge cases

| Case | Expected behavior |
|---|---|
| A provider returns 0 concepts | Valid. The other 2 providers' concepts have max consensus 2/3. |
| Two concepts differ only by whitespace ("inter run" vs "inter  run") | Normalized to same string → exact match |
| Levenshtein threshold = 1.0 | Only exact matches (after normalization). Near-exact disabled. |
| Levenshtein threshold = 0.0 | Everything matches everything → single group. Degenerate but valid. |
| Category tie between 2 members | First encountered wins (deterministic given stable input order: claude, gpt, gemini). |

---

## 7. Constraints

- **Mechanical only** — no LLM calls. String operations only.
- **Deterministic** — same input always produces same output (given stable provider ordering).
- **Conservative** — only groups exact and near-exact. "consistency" and "reliability" remain separate. Semantic clustering is deferred to FusionInterAngle.

---

## 8. Integration

```typescript
// In pipeline orchestrator (Phase 3), for each angle:
const anglePasses = extraction.passes.filter(p => p.angle === angle);
let intraResult = FusionIntraAngle.fuse({
  angle,
  passes: anglePasses,
  levenshteinThreshold: config.levenshteinThreshold,
});
// Then pass intraResult.concepts to QualityController, then RelevanceController
```
