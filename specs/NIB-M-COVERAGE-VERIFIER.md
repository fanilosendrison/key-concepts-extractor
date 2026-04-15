---
id: NIB-M-COVERAGE-VERIFIER
type: nib-module
version: "1.0.0"
scope: key-concepts-extractor/coverage-verifier
status: approved
validates: [src/domain/coverage-verifier.ts, tests/coverage-verifier.test.ts]
consumers: [claude-code]
superseded_by: []
---

---

## 1. Purpose

Performs a mechanical string-matching verification of each final concept against the source text. Updates `explicit_in_source` and flags fragile concepts (implicit + single angle + consensus 1/3).

---

## 2. Inputs

```typescript
interface CoverageInput {
  concepts: FinalConcept[];
  sourceText: string;            // Raw concatenated source text (from InputProcessor)
}
```

---

## 3. Outputs

```typescript
interface CoverageOutput {
  concepts: FinalConcept[];      // With explicit_in_source updated
  stats: {
    explicit: number;            // Count where explicit_in_source = true
    implicit: number;            // Count where explicit_in_source = false
    fragile: number;             // Subset of implicit: 1 angle + consensus 1/3
  };
}
```

---

## 4. Algorithm

### 4.1 checkExplicit(term, sourceText)

```javascript
function checkExplicit(term: string, sourceText: string): boolean {
  // Case-insensitive search for the exact term in the source text
  return sourceText.toLowerCase().includes(term.toLowerCase());
}
```

### 4.2 iFragile(concept)

```javascript
function isFragile(concept: FinalConcept): boolean {
  // Fragile = explicit_in_source is false
  //         AND found by exactly 1 angle
  //         AND that angle's consensus is 1/3
  if (concept.explicit_in_source) return false;
  const angles = Object.keys(concept.angle_provenance);
  if (angles.length !== 1) return false;
  return concept.angle_provenance[angles[0]].consensus === '1/3';
}
```

### 4.3 verify(input) — main entry point

```javascript
function verify(input: CoverageInput): CoverageOutput {
  const updatedConcepts = input.concepts.map(concept => {
    // Check canonical_term AND all variants against source
    const termsToCheck = [concept.canonical_term, ...concept.variants];
    const isExplicit = termsToCheck.some(term => checkExplicit(term, input.sourceText));

    return { ...concept, explicit_in_source: isExplicit };
  });

  const explicit = updatedConcepts.filter(c => c.explicit_in_source).length;
  const implicit = updatedConcepts.filter(c => !c.explicit_in_source).length;
  const fragile = updatedConcepts.filter(isFragile).length;

  return {
    concepts: updatedConcepts,
    stats: { explicit, implicit, fragile },
  };
}
```

---

## 5. Examples

```javascript
Source text: "...the variance of outputs across runs..."

concept { canonical_term: "variance", variants: ["variance", "output variance"] }
→ checkExplicit("variance", text) = true
→ explicit_in_source = true

concept { canonical_term: "consistency", variants: ["consistency"] }
→ checkExplicit("consistency", text) = false
→ explicit_in_source = false
→ if 1 angle + consensus 1/3 → flagged fragile
```

---

## 6. Edge cases

| Case | Expected behavior |
|---|---|
| Term is substring of a longer word ("run" in "running") | Matches. Simple `includes()`. Not word-boundary-aware. Known limitation v1. |
| Empty source text | All concepts = implicit. Valid but degenerate (prompt-only input). |
| Concept with 0 variants | Only canonical_term checked. |

---

## 7. Constraints

- **No LLM calls** — purely mechanical string matching.
- **Deterministic.**
- **Does not modify concepts beyond `explicit_in_source`** — no filtering, no reordering.
