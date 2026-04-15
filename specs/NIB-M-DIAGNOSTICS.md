---
id: NIB-M-DIAGNOSTICS
type: nib-module
version: "1.0.0"
scope: key-concepts-extractor/diagnostics-generator
status: approved
consumers: [claude-code]
superseded_by: []
---

---

## 1. Purpose

Computes the diagnostic report summarizing extraction effectiveness: contribution by angle, contribution by model, fragile/unanimous concept counts.

---

## 2. Inputs

```typescript
interface DiagnosticsInput {
  rawPasses: ExtractionPass[];              // 15 passes
  intraAngleResults: FusionIntraOutput[];   // 5 post-control
  finalConcepts: FinalConcept[];            // Post inter-angle + coverage
  coverageStats: { explicit: number; implicit: number; fragile: number };
}
```

---

## 3. Outputs

```typescript
interface DiagnosticsReport {
  total_raw: number;                        // Sum of concepts across 15 passes
  total_after_intra_angle: number;          // Sum across 5 intra-angle lists
  total_after_inter_angle: number;          // Final concept count
  unique_by_angle: Record<AngleId, number>; // Concepts found ONLY by this angle
  unique_by_model: Record<ProviderId, number>; // Concepts found ONLY by this model
  fragile_concepts: number;
  unanimous_concepts: number;               // 3+ angles AND consensus 3/3 on ≥1 angle
}
```

---

## 4. Algorithm

### 4.1 computeUniqueByAngle(finalConcepts)

```javascript
function computeUniqueByAngle(concepts: FinalConcept[]): Record<AngleId, number> {
  const result: Record<AngleId, number> = {
    extraction_directe: 0, etats_ideaux: 0,
    mecanismes_causaux: 0, taxonomie: 0, conditions_bord: 0,
  };
  for (const concept of concepts) {
    const angles = Object.keys(concept.angle_provenance) as AngleId[];
    if (angles.length === 1) {
      result[angles[0]]++;
    }
  }
  return result;
}
```

### 4.2 computeUniqueByModel(finalConcepts)

```javascript
function computeUniqueByModel(concepts: FinalConcept[]): Record<ProviderId, number> {
  const result: Record<ProviderId, number> = { claude: 0, gpt: 0, gemini: 0 };
  for (const concept of concepts) {
    // Collect all models that found this concept across all angles
    const allModels = new Set<ProviderId>();
    for (const prov of Object.values(concept.angle_provenance)) {
      for (const model of prov.models) {
        allModels.add(model);
      }
    }
    if (allModels.size === 1) {
      result[[...allModels][0]]++;
    }
  }
  return result;
}
```

### 4.3 countUnanimous(finalConcepts)

```javascript
function countUnanimous(concepts: FinalConcept[]): number {
  return concepts.filter(c => {
    const angles = Object.keys(c.angle_provenance);
    const has3PlusAngles = angles.length >= 3;
    const has3on3 = Object.values(c.angle_provenance).some(p => p.consensus === '3/3');
    return has3PlusAngles && has3on3;
  }).length;
}
```

### 4.4 generate(input) — main entry point

```javascript
function generate(input: DiagnosticsInput): DiagnosticsReport {
  return {
    total_raw: input.rawPasses.reduce((sum, p) => sum + p.concepts.length, 0),
    total_after_intra_angle: input.intraAngleResults.reduce((sum, a) => sum + a.concepts.length, 0),
    total_after_inter_angle: input.finalConcepts.length,
    unique_by_angle: computeUniqueByAngle(input.finalConcepts),
    unique_by_model: computeUniqueByModel(input.finalConcepts),
    fragile_concepts: input.coverageStats.fragile,
    unanimous_concepts: countUnanimous(input.finalConcepts),
  };
}
```

---

## 5. Constraints

- **No LLM calls** — purely mechanical computation.
- **Deterministic.**
- **Read-only** — does not modify input data.
