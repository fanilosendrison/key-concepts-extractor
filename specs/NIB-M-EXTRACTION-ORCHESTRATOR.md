---
id: NIB-M-EXTRACTION-ORCHESTRATOR
type: nib-module
version: "1.0.0"
scope: key-concepts-extractor/extraction-orchestrator
status: approved
consumers: [claude-code]
superseded_by: []
---

---

## 1. Purpose

Orchestrates the 15 extraction passes (5 angles × 3 providers). For each angle, builds the provider-specific prompts from LLM Payloads v0.2 Type 1 templates, dispatches 3 parallel provider calls, collects and validates the JSON responses, and persists each pass to disk.

---

## 2. Inputs

```typescript
interface ExtractionInput {
  context: string;                              // From InputProcessor
}
// Also receives (injected):
//   adapters: Record<ProviderLongId, ProviderAdapter>
//   emitter: EventEmitter
//   runManager: RunManager
```

---

## 3. Outputs

```typescript
interface ExtractionOutput {
  passes: ExtractionPass[];                     // Exactly 15 passes
}
interface ExtractionPass {
  angle: AngleId;
  provider: ProviderId;
  concepts: RawConcept[];
}
```

Consumed by: FusionIntraAngle (grouped by angle), DiagnosticsGenerator (all 15 passes).

---

## 4. Algorithm

### 4.1 Angle prompt templates

The 5 angle prompts are loaded from a constant map. The values are the exact strings from LLM Payloads v0.2, Angle variants section:

```typescript
const ANGLE_PROMPTS: Record<AngleId, string> = {
  extraction_directe: 'What phenomena, methods, techniques, architectures, and metrics does this document explicitly mention? Extract each concept using the exact term found in the text. Do not infer anything — extract only what is named.',
  etats_ideaux: 'What ideal properties is the described system trying to achieve? What pathological states is it trying to avoid? Extract the names of these properties and states, including the opposites and contraries of what is explicitly described. If the document describes a problem, name the targeted solution. If the document describes a solution, name the problem being fought.',
  mecanismes_causaux: 'Analyze this document as a network of causes and effects. What concepts act as independent variables (levers that influence the result)? What concepts are intermediate mechanisms (mediators between cause and effect)? What concepts are confounding factors (sources of noise)? Extract the names of these variables, mediators, and factors, even if they are not named as such in the text.',
  taxonomie: 'If this document were to be indexed in a scientific encyclopedia, under which categories, subcategories, and cross-cutting disciplines would it be classified? For each identifiable concept in this document, what canonical terms does the academic literature use to designate the same phenomenon? Extract both parent categories (disciplines, fields) and academic synonyms.',
  conditions_bord: 'What operational constraints, starting assumptions, environmental conditions, and system limitations are described or implied in this document? What concepts related to deployment, scaling, compatibility, or usage context are present or implied?',
};
```

### 4.2 System prompt (constant)

The system prompt is the exact Type 1 system prompt from LLM Payloads v0.2. It is a constant string with one placeholder: `{angle_prompt}`.

### 4.3 User prompt (constant)

The user prompt is the exact Type 1 user prompt from LLM Payloads v0.2. It has one placeholder: `{context}`.

### 4.4 buildRequest(context, angle, provider)

```javascript
function buildRequest(context: string, angle: AngleId, provider: ProviderLongId): LLMRequest {
  const systemPrompt = TYPE1_SYSTEM_PROMPT.replace('{angle_prompt}', ANGLE_PROMPTS[angle]);
  const userPrompt = TYPE1_USER_PROMPT.replace('{context}', context);
  return { systemPrompt, userPrompt, provider };
}
```

### 4.5 validateExtractionResponse(json, angle, provider)

```javascript
function validateExtractionResponse(raw: string): RawConcept[] {
  const parsed = JSON.parse(raw);  // Already validated as JSON by ProviderAdapter
  // Validate schema:
  //   parsed.concepts must be an array
  //   Each element must have: term (string), category (valid ConceptCategory),
  //   granularity (valid GranularityLevel), explicit_in_source (boolean),
  //   justification (string)
  // On validation failure: throw RetriableError (will trigger retry in ProviderAdapter)
  // Note: this validation is called by the orchestrator AFTER receiving the response.
  // If validation fails, the orchestrator wraps it as a retriable error and re-calls
  // the adapter (within the retry budget).
  return parsed.concepts;
}
```

**Retry on schema validation failure:** If the JSON is valid but doesn't match the expected schema, the orchestrator treats it as a retriable error. It re-invokes `adapter.call()` which manages the retry count. This means schema validation failures consume from the same 3-retry budget as network errors. This is acceptable because schema failures are rare and indicate the LLM misunderstood the prompt.

### 4.6 run(input) — main entry point

```javascript
async function run(input: ExtractionInput): Promise<ExtractionOutput> {
  const allPasses: ExtractionPass[] = [];

  for (const angle of ANGLES) {  // Sequential angles
    emitter.emit(extractionProgress(allPasses.length, 15));

    // 3 providers in parallel for this angle
    const anglePasses = await Promise.all(
      PROVIDERS.map(async ({ id: providerId, shortId }) => {
        emitter.emit(extractionStart(angle, shortId));

        const request = buildRequest(input.context, angle, providerId);

        // Retry loop includes schema validation
        let concepts: RawConcept[];
        let response: LLMResponse;
        let retriesForSchema = 0;
        const maxSchemaRetries = 3;

        while (true) {
          response = await adapters[providerId].call(request);
          try {
            concepts = validateExtractionResponse(response.content);
            break;
          } catch (validationError) {
            retriesForSchema++;
            if (retriesForSchema >= maxSchemaRetries) {
              throw new FatalLLMError({
                provider: providerId,
                error: `Schema validation failed after ${maxSchemaRetries} attempts: ${validationError.message}`,
                retriesExhausted: true,
              });
            }
            emitter.emit(extractionError(angle, shortId, `Schema validation failed, retrying (${retriesForSchema}/${maxSchemaRetries})`));
          }
        }

        emitter.emit(extractionComplete(angle, shortId, concepts.length));
        runManager.persistExtractionPass(angle, shortId, concepts);

        return { angle, provider: shortId, concepts };
      })
    );

    allPasses.push(...anglePasses);
  }

  emitter.emit(extractionProgress(15, 15));
  return { passes: allPasses };
}
```

---

## 5. Examples

### 5.1 Normal execution flow

```javascript
Angle 1 (extraction_directe):
  claude: 18 concepts  |  gpt: 22 concepts  |  gemini: 15 concepts   [parallel]
Angle 2 (etats_ideaux):
  claude: 14 concepts  |  gpt: 19 concepts  |  gemini: 17 concepts   [parallel]
... (3 more angles)
Total: 15 passes, 247 raw concepts
```

### 5.2 Schema validation retry

```javascript
Angle 3, provider gpt:
  Call 1 → valid JSON but missing 'category' field → schema retry 1/3
  Call 2 → valid response → success
```

---

## 6. Edge cases

| Case | Expected behavior |
|---|---|
| Provider returns empty concepts array `{"concepts": []}` | Valid — 0 concepts for this pass. Logged but not an error. |
| Provider returns concepts with unknown category | Schema validation failure → retry |
| One provider fails fatally, others succeed | Fatal error → pipeline stops. Partial results for other providers of same angle are NOT persisted (Promise.all rejects all). |
| Context is very large (>100k tokens) | Not this module's concern. Provider adapters handle token limits via their APIs. If the provider rejects for token limit, it's a retriable error. |

---

## 7. Constraints

- **Prompt templates are constants** — loaded from LLM Payloads v0.2 at compile time. No runtime prompt modification.
- **Max 3 concurrent API calls** — enforced by the sequential-angle + parallel-provider structure.
- **All 15 passes required** — no partial extraction. If any pass fails fatally, the entire extraction fails.

---

## 8. Integration

```typescript
// In pipeline orchestrator:
const extraction = await extractionOrchestrator.run({ context });
// extraction.passes has exactly 15 entries
// Group by angle for Phase 3:
for (const angle of ANGLES) {
  const anglePasses = extraction.passes.filter(p => p.angle === angle);
  // anglePasses has exactly 3 entries (claude, gpt, gemini)
}
```
