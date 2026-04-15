---
id: NIB-M-QUALITY-CONTROLLER
type: nib-module
version: "1.1.0"
scope: key-concepts-extractor/quality-controller
status: approved
consumers: [claude-code]
superseded_by: []
---

---

## 1. Purpose

Verifies the mechanical quality of a fusion result via a 3-round adversarial protocol between Claude (R1 + R3) and GPT (R2). Detects and corrects three error types: abusive merges, incorrect categorization, and justification/term incoherence. Decision rule: **doubt = separate/correct.**

---

## 2. Inputs

```typescript
interface QualityControlInput {
  mergedList: IntraAngleConcept[] | FinalConcept[];  // Polymorphic
  context: string;                                    // Source document
  scope: ControlScope;                                // 'angle:{id}' | 'inter_angle'
}
```

Provenance: FusionIntraAngle output (per angle) or FusionInterAngle output.

---

## 3. Outputs

```typescript
interface QualityControlOutput {
  correctedList: (IntraAngleConcept | FinalConcept)[];  // Same type as input, corrected
  report: QualityReport;
}
interface QualityReport {
  review_type: 'fusion_quality';
  review_rounds: number;              // 1-3
  errors_flagged: number;
  errors_corrected: number;
  corrections: QualityCorrection[];
}
interface QualityCorrection {
  error_type: 'abusive_merge' | 'incorrect_categorization' | 'justification_incoherence';
  target: string;
  correction: string;
  suggested_split: string[] | null;   // Required non-null for abusive_merge (≥2 distinct terms, none === target)
  flagged_by: 'claude' | 'gpt';
  confirmed_by: 'claude' | 'gpt' | null;
  justification: string;
}
```

---

## 4. Algorithm

### 4.1 Prompt construction

All prompts are defined in LLM Payloads v0.2:
- **Round 1 (Claude):** Type 2 — system prompt + user prompt. Placeholders: `{context}`, `{merged_list}`.
- **Round 2 (GPT):** Type 3 — system prompt + user prompt. Placeholders: `{context}`, `{merged_list}`, `{claude_findings}`.
- **Round 3 (Claude):** Type 4 — system prompt + user prompt. Placeholders: `{context}`, `{merged_list}`, `{claude_findings}`, `{gpt_findings}`.

### 4.2 run(input) — main entry point

```javascript
async function run(input: QualityControlInput): Promise<QualityControlOutput> {
  const mergedListJson = JSON.stringify(input.mergedList);

  // Round 1 — Claude flags errors
  emitter.emit(controlStart('quality', 1, 'claude', input.scope));
  const r1Request = buildType2Request(input.context, mergedListJson);
  const r1Response = await adapters.anthropic.call(r1Request);
  const r1Findings = parseAndValidate<QualityR1Output>(r1Response.content);
  emitter.emit(controlComplete('quality', 1, 'claude', input.scope, r1Findings.errors_found.length));

  // If no errors found in Round 1, skip Rounds 2 and 3
  if (r1Findings.errors_found.length === 0) {
    return {
      correctedList: input.mergedList,
      report: { review_type: 'fusion_quality', review_rounds: 1, errors_flagged: 0, errors_corrected: 0, corrections: [] },
    };
  }

  // Round 2 — GPT reviews Claude's findings + may add new ones
  emitter.emit(controlStart('quality', 2, 'gpt', input.scope));
  const r2Request = buildType3Request(input.context, mergedListJson, JSON.stringify(r1Findings));
  const r2Response = await adapters.openai.call(r2Request);
  const r2Findings = parseAndValidate<QualityR2Output>(r2Response.content);
  emitter.emit(controlComplete('quality', 2, 'gpt', input.scope, r2Findings.reviews_of_claude.length + r2Findings.additional_errors.length));

  // Determine if Round 3 is needed:
  // Needed if: any Claude error was contested by GPT, OR GPT found additional errors
  const hasDisagreement = r2Findings.reviews_of_claude.some(r => r.verdict === 'contested');
  const hasAdditional = r2Findings.additional_errors.length > 0;

  let finalDecisions: QualityR3Output | null = null;

  if (hasDisagreement || hasAdditional) {
    // Round 3 — Claude final arbiter
    emitter.emit(controlStart('quality', 3, 'claude', input.scope));
    const r3Request = buildType4Request(input.context, mergedListJson, JSON.stringify(r1Findings), JSON.stringify(r2Findings));
    const r3Response = await adapters.anthropic.call(r3Request);
    finalDecisions = parseAndValidate<QualityR3Output>(r3Response.content);
    emitter.emit(controlComplete('quality', 3, 'claude', input.scope, finalDecisions.final_decisions.length));
  }

  // Apply corrections
  const corrections = buildCorrections(r1Findings, r2Findings, finalDecisions);
  const correctedList = applyCorrections(input.mergedList, corrections);
  const roundsUsed = finalDecisions ? 3 : 2;

  emitter.emit(controlResult('quality', input.scope, roundsUsed, corrections.length));

  return {
    correctedList,
    report: {
      review_type: 'fusion_quality',
      review_rounds: roundsUsed,
      errors_flagged: corrections.length,
      errors_corrected: corrections.length,
      corrections,
    },
  };
}
```

### 4.3 buildCorrections(r1, r2, r3)

Applies the decision rule from Spec v1.5 §8.5:

```javascript
function buildCorrections(r1, r2, r3): QualityCorrection[] {
  const corrections: QualityCorrection[] = [];

  for (const error of r1.errors_found) {
    const review = r2.reviews_of_claude.find(r => r.target === error.target);

    if (!review || review.verdict === 'confirmed') {
      // Flagged by Claude, confirmed by GPT (or GPT didn't contest) → corrected
      corrections.push(makeCorrection(error, 'claude', review ? 'gpt' : null));
    } else {
      // Contested by GPT → Rule: doubt = correct anyway
      // But if R3 exists, check R3 decision
      if (r3) {
        const decision = r3.final_decisions.find(d => d.target === error.target);
        // R3 always corrects when in doubt (per prompt instruction)
        corrections.push(makeCorrection(error, 'claude', null, decision?.reasoning));
      } else {
        // No R3 (shouldn't happen if there's disagreement, but defensive)
        corrections.push(makeCorrection(error, 'claude', null));
      }
    }
  }

  // Additional errors from GPT (Round 2)
  for (const error of r2.additional_errors) {
    if (r3) {
      const decision = r3.final_decisions.find(d => d.target === error.target);
      if (decision?.decision === 'corrected') {
        corrections.push(makeCorrection(error, 'gpt', 'claude'));
      }
      // If R3 says 'maintained', don't correct. But per rule, doubt = correct.
    } else {
      // No R3 = this shouldn't happen (additional errors trigger R3)
      corrections.push(makeCorrection(error, 'gpt', null));
    }
  }

  return corrections;
}
```

### 4.4 applyCorrections(list, corrections)

```javascript
function applyCorrections(list, corrections): typeof list {
  let result = [...list];

  for (const correction of corrections) {
    switch (correction.error_type) {
      case 'abusive_merge':
        // Replace the target concept with N split concepts built from suggested_split.
        // Each split concept inherits `category`, `granularity`, `explicit_in_source`,
        // and `justifications` from the target. `term` and `variants` come from suggested_split.
        // QC may re-flag on subsequent pass if inherited category/granularity is incorrect.
        result = splitCluster(result, correction);
        break;
      case 'incorrect_categorization':
        // Update category and/or granularity of the target concept
        result = updateCategorization(result, correction);
        break;
      case 'justification_incoherence':
        // Update justification of the target concept
        result = updateJustification(result, correction);
        break;
    }
  }

  return result;
}
```

**Inheritance rule for splits** : a concept resulting from `splitCluster` inherits from the target :
- `category`
- `granularity` (when present, i.e. for `FinalConcept`)
- `explicit_in_source`
- `justifications`

Only `term` and `variants` are overridden from `suggested_split`. Other fields follow the domain type (e.g. `found_by_models`, `consensus`, `angle_provenance`) are inherited as-is.

**Schema validation** : before applying a correction with `error_type === "abusive_merge"`, the controller MUST validate that `suggested_split` is a non-empty array with at least 2 distinct strings, none of which equals `target`. On validation failure → **fail-closed** : raise a schema violation error, do not apply any subsequent correction, run status = `failed`. See §6.

---

## 5. Examples

### 5.1 Error flagged by Claude, confirmed by GPT (2 rounds)

```javascript
R1 Claude: flags "consistency" + "reliability" as abusive_merge
R2 GPT: verdict = "confirmed"
Result: split into 2 concepts, 2 rounds used
```

### 5.2 Error flagged by Claude, contested by GPT (3 rounds)

```javascript
R1 Claude: flags "temperature" as incorrect_categorization (property → constraint)
R2 GPT: verdict = "contested" ("temperature IS a property")
R3 Claude: decision = "corrected" (doubt = correct)
Result: temperature recategorized, 3 rounds used
```

### 5.3 No errors

```javascript
R1 Claude: errors_found = [], no_error_count = 22
Result: list unchanged, 1 round used
```

---

## 6. Edge cases

| Case | Expected behavior |
|---|---|
| Claude flags 0 errors | Return immediately, 1 round, no corrections |
| GPT confirms all Claude errors | 2 rounds, all corrections applied |
| GPT contests all + adds nothing | 3 rounds needed (disagreement triggers R3) |
| Correction target not found in list | Skip correction, log warning (data lookup miss, non-fatal) |
| Split produces concept already in list | Keep both (dedup is not this module's job) |
| `abusive_merge` correction missing `suggested_split` (null, empty, < 2 items, duplicates, or contains target) | **Fail-closed** : raise schema violation, abort run, mark `status = failed`. Distinct from "target not found" above — this is a contract violation by the LLM, not a data miss. |

---

## 7. Constraints

- **Max 6 LLM calls per invocation** (3 rounds × 2 models). Often fewer (1-4).
- **Claude = Anthropic, GPT = OpenAI** — hardcoded role assignment regardless of configured models.
- **Decision rule: doubt = correct** — inverse of RelevanceController.
- **Gemini never participates** in controls.

---

## 8. Integration

```typescript
// After FusionIntraAngle (per angle):
const qualityResult = await QualityController.run({
  mergedList: intraResult.concepts,
  context,
  scope: `angle:${angle}`,
});
intraResult = { ...intraResult, concepts: qualityResult.correctedList };
runManager.persistQualityReport(angle, qualityResult.report);

// After FusionInterAngle:
const interQuality = await QualityController.run({
  mergedList: interResult.concepts,
  context,
  scope: 'inter_angle',
});
```
