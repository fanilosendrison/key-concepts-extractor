---
id: NIB-M-RELEVANCE-CONTROLLER
type: nib-module
version: "1.0.0"
scope: key-concepts-extractor/relevance-controller
status: approved
consumers: [claude-code]
superseded_by: []
---

---

## 1. Purpose

Verifies the pertinence of concepts via a 3-round adversarial protocol between Claude (R1 + R3) and GPT (R2). Identifies and removes manifestly off-topic concepts. Decision rule: **doubt = retain.** Asymmetric mandate biased toward keeping concepts.

---

## 2. Inputs

```typescript
interface RelevanceControlInput {
  mergedList: IntraAngleConcept[] | FinalConcept[];
  context: string;
  scope: ControlScope;
}
```

---

## 3. Outputs

```typescript
interface RelevanceControlOutput {
  filteredList: (IntraAngleConcept | FinalConcept)[];  // Input minus removed concepts
  report: RelevanceReport;
}
interface RelevanceReport {
  review_rounds: number;
  concepts_flagged: number;
  concepts_removed: number;
  concepts_retained_after_dispute: number;
  removed: RelevanceRemoval[];
  retained_after_dispute: RelevanceRetention[];
}
```

---

## 4. Algorithm

### 4.1 Prompt construction

All prompts from LLM Payloads v0.2:
- **Round 1 (Claude):** Type 5. Placeholders: `{context}`, `{merged_list}`.
- **Round 2 (GPT):** Type 6. Placeholders: `{context}`, `{merged_list}`, `{claude_findings}`.
- **Round 3 (Claude):** Type 7. Placeholders: `{context}`, `{merged_list}`, `{claude_findings}`, `{gpt_findings}`.

### 4.2 run(input) — main entry point

```javascript
async function run(input: RelevanceControlInput): Promise<RelevanceControlOutput> {
  const mergedListJson = JSON.stringify(input.mergedList);

  // Round 1 — Claude flags off-topic
  emitter.emit(controlStart('relevance', 1, 'claude', input.scope));
  const r1Request = buildType5Request(input.context, mergedListJson);
  const r1Response = await adapters.anthropic.call(r1Request);
  const r1Findings = parseAndValidate<RelevanceR1Output>(r1Response.content);
  emitter.emit(controlComplete('relevance', 1, 'claude', input.scope, r1Findings.flagged_off_topic.length));

  // If no flags in Round 1, skip Rounds 2 and 3
  if (r1Findings.flagged_off_topic.length === 0) {
    return {
      filteredList: input.mergedList,
      report: { review_rounds: 1, concepts_flagged: 0, concepts_removed: 0, concepts_retained_after_dispute: 0, removed: [], retained_after_dispute: [] },
    };
  }

  // Round 2 — GPT reviews
  emitter.emit(controlStart('relevance', 2, 'gpt', input.scope));
  const r2Request = buildType6Request(input.context, mergedListJson, JSON.stringify(r1Findings));
  const r2Response = await adapters.openai.call(r2Request);
  const r2Findings = parseAndValidate<RelevanceR2Output>(r2Response.content);
  emitter.emit(controlComplete('relevance', 2, 'gpt', input.scope, r2Findings.reviews_of_claude.length + r2Findings.additional_flags.length));

  // Determine if Round 3 is needed
  const hasDisagreement = r2Findings.reviews_of_claude.some(r => r.verdict === 'defended');
  const hasAdditional = r2Findings.additional_flags.length > 0;

  let finalDecisions: RelevanceR3Output | null = null;

  if (hasDisagreement || hasAdditional) {
    emitter.emit(controlStart('relevance', 3, 'claude', input.scope));
    const r3Request = buildType7Request(input.context, mergedListJson, JSON.stringify(r1Findings), JSON.stringify(r2Findings));
    const r3Response = await adapters.anthropic.call(r3Request);
    finalDecisions = parseAndValidate<RelevanceR3Output>(r3Response.content);
    emitter.emit(controlComplete('relevance', 3, 'claude', input.scope, finalDecisions.final_decisions.length));
  }

  // Apply decisions
  const { removed, retained, filteredList } = applyRelevanceDecisions(
    input.mergedList, r1Findings, r2Findings, finalDecisions
  );
  const roundsUsed = finalDecisions ? 3 : 2;

  emitter.emit(controlResult('relevance', input.scope, roundsUsed, removed.length));

  return {
    filteredList,
    report: {
      review_rounds: roundsUsed,
      concepts_flagged: removed.length + retained.length,
      concepts_removed: removed.length,
      concepts_retained_after_dispute: retained.length,
      removed,
      retained_after_dispute: retained,
    },
  };
}
```

### 4.3 applyRelevanceDecisions — core decision logic

```javascript
function applyRelevanceDecisions(list, r1, r2, r3) {
  const removed: RelevanceRemoval[] = [];
  const retained: RelevanceRetention[] = [];
  const termsToRemove = new Set<string>();

  // Process Claude's R1 flags
  for (const flag of r1.flagged_off_topic) {
    const review = r2.reviews_of_claude.find(r => r.term === flag.term);

    if (review?.verdict === 'confirmed_off_topic') {
      // Flagged by Claude + confirmed by GPT → REMOVE
      termsToRemove.add(flag.term.toLowerCase());
      removed.push({
        term: flag.term,
        flagged_by: 'claude',
        confirmed_by: 'gpt',
        justification_flagger: flag.justification,
        justification_confirmer: review.justification,
      });
    } else if (review?.verdict === 'defended') {
      // Flagged by Claude + defended by GPT → RETAIN (disagreement = retention)
      retained.push({
        term: flag.term,
        flagged_by: 'claude',
        defended_by: 'gpt',
        justification_flagger: flag.justification,
        counter_argument_defender: review.justification,
        final_decision: 'retained (désaccord = maintien)',
      });
    } else {
      // No GPT review for this flag (shouldn't happen, but defensive) → RETAIN
      retained.push({
        term: flag.term,
        flagged_by: 'claude',
        defended_by: 'gpt',
        justification_flagger: flag.justification,
        counter_argument_defender: 'No review from GPT',
        final_decision: 'retained (désaccord = maintien)',
      });
    }
  }

  // Process GPT's additional flags (Round 2)
  for (const flag of r2.additional_flags) {
    if (r3) {
      const decision = r3.final_decisions.find(d => d.term === flag.term);
      if (decision?.decision === 'removed') {
        termsToRemove.add(flag.term.toLowerCase());
        removed.push({
          term: flag.term,
          flagged_by: 'gpt',
          confirmed_by: 'claude',
          justification_flagger: flag.justification,
          justification_confirmer: decision.reasoning,
        });
      } else {
        // Claude defends or doubts → RETAIN
        retained.push({
          term: flag.term,
          flagged_by: 'gpt',
          defended_by: 'claude',
          justification_flagger: flag.justification,
          counter_argument_defender: decision?.reasoning ?? 'Doubt = retention',
          final_decision: 'retained (désaccord = maintien)',
        });
      }
    } else {
      // No R3 (shouldn't happen if GPT added flags) → RETAIN
      retained.push({
        term: flag.term,
        flagged_by: 'gpt',
        defended_by: 'claude',
        justification_flagger: flag.justification,
        counter_argument_defender: 'No Round 3',
        final_decision: 'retained (désaccord = maintien)',
      });
    }
  }

  // Filter the list
  const filteredList = list.filter(concept => {
    const term = ('canonical_term' in concept ? concept.canonical_term : concept.term).toLowerCase();
    return !termsToRemove.has(term);
  });

  return { removed, retained, filteredList };
}
```

---

## 5. Examples

### 5.1 Concept removed (both agree)

```javascript
R1 Claude: flags "blockchain" as off-topic
R2 GPT: confirmed_off_topic
Result: "blockchain" removed, 2 rounds
```

### 5.2 Concept retained (disagreement)

```javascript
R1 Claude: flags "caching" as off-topic
R2 GPT: defended ("caching affects output consistency")
Result: "caching" retained, 2 rounds
```

### 5.3 No flags

```javascript
R1 Claude: flagged_off_topic = [], not_flagged_count = 22
Result: list unchanged, 1 round
```

---

## 6. Edge cases

| Case | Expected behavior |
|---|---|
| Claude flags 0 | Return immediately, 1 round |
| GPT defends all Claude flags + adds nothing | 2 rounds, 0 removed, all retained |
| GPT confirms all Claude flags + adds own | 3 rounds needed (additional flags trigger R3) |
| Removal target not found in list (term mismatch) | Skip removal, log warning |
| Same concept flagged by both in different rounds | De-duplicate by term, process once |

---

## 7. Constraints

- **Max 6 LLM calls per invocation** (3 rounds × 2 models).
- **Decision rule: doubt = retain** — inverse of QualityController.
- **Asymmetric mandate** — Claude cannot override GPT's defense. Disagreement always resolves in favor of retention.
- **Claude = Anthropic, GPT = OpenAI** — hardcoded.

---

## 8. Integration

```typescript
// After QualityController (per angle or inter-angle):
const relevanceResult = await RelevanceController.run({
  mergedList: qualityResult.correctedList,
  context,
  scope: `angle:${angle}`,  // or 'inter_angle'
});
// Use relevanceResult.filteredList as the final list for this scope
```
