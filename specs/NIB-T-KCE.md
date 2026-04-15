---
id: NIB-T-KCE
type: nib-tddtests
version: "1.0.0"
scope: key-concepts-extractor
status: approved
consumers: [claude-code]
superseded_by: []
---

---

## 1. Fixture organization

```javascript
tests/
├── fixtures/
│   ├── inputs/
│   │   ├── sample-vision.md            # Realistic research document
│   │   ├── sample-notes.txt            # Additional notes
│   │   └── sample-prompt.txt           # Research prompt
│   ├── extraction/
│   │   ├── angle1-claude.json          # Mocked extraction responses
│   │   ├── angle1-gpt.json
│   │   ├── angle1-gemini.json
│   │   └── ...                         # 15 files total
│   ├── controls/
│   │   ├── quality-r1-response.json    # Mocked control responses
│   │   ├── quality-r2-response.json
│   │   ├── quality-r3-response.json
│   │   ├── relevance-r1-response.json
│   │   ├── relevance-r2-response.json
│   │   └── relevance-r3-response.json
│   └── expected/
│       ├── intra-angle1.json           # Expected fusion outputs
│       ├── inter-merged.json
│       └── diagnostics.json
├── unit/                                  # Emerge during GREEN
├── input-processor.test.ts
├── extraction-orchestrator.test.ts
├── fusion-intra.test.ts
├── fusion-inter.test.ts
├── quality-controller.test.ts
├── relevance-controller.test.ts
├── coverage-verifier.test.ts
├── diagnostics.test.ts
├── run-manager.test.ts
├── event-logger.test.ts
├── cli.test.ts
├── web-server.test.ts
├── pipeline-integration.test.ts
└── helpers/
    ├── mock-provider.ts               # Mock LLM provider adapter
    ├── mock-embedding.ts              # Mock embedding adapter
    ├── temp-dir.ts                    # Temp directory for run tests
    └── fixture-loader.ts              # Load fixture files
```

---

## 2. Test vectors — InputProcessor

### T-IP-01: Prompt only

```javascript
Input:  { prompt: "Variance inter-run", files: undefined }
Expect: { context: "Variance inter-run", prompt: "Variance inter-run", inputFiles: [] }
```

### T-IP-02: Files only

```javascript
Input:  { files: [{ name: "a.md", content: "AAA" }, { name: "b.txt", content: "BBB" }] }
Expect: {
  context: "AAA\n\n---\n\nBBB",
  prompt: null,
  inputFiles: [
    { originalName: "a.md", normalizedName: "doc-001.md", sizeBytes: 3 },
    { originalName: "b.txt", normalizedName: "doc-002.txt", sizeBytes: 3 }
  ]
}
```

### T-IP-03: Both prompt and files

```javascript
Input:  { prompt: "Focus", files: [{ name: "c.md", content: "CCC" }] }
Expect: context starts with "Focus", contains separator, ends with "CCC"
```

### T-IP-04: Validation — no input

```javascript
Input:  { prompt: undefined, files: undefined }
Expect: throws ValidationError
```

### T-IP-05: Validation — empty prompt

```javascript
Input:  { prompt: "", files: undefined }
Expect: throws ValidationError
```

### T-IP-06: Validation — unsupported file type

```javascript
Input:  { files: [{ name: "doc.pdf", content: "..." }] }
Expect: throws ValidationError mentioning ".pdf"
```

### T-IP-07: Validation — empty file

```javascript
Input:  { files: [{ name: "empty.md", content: "" }] }
Expect: throws ValidationError
```

### T-IP-08: Whitespace-only prompt

```javascript
Input:  { prompt: "   ", files: undefined }
Expect: throws ValidationError
```

---

## 3. Test vectors — FusionIntraAngle

### T-FI-01: Exact dedup, 3/3 consensus

```javascript
Input: 3 passes, all contain { term: "consistency" }
Expect: single concept, consensus "3/3", found_by_models: ["claude", "gpt", "gemini"]
```

### T-FI-02: Case-insensitive dedup

```javascript
Input: claude: "Consistency", gpt: "consistency", gemini: "CONSISTENCY"
Expect: single concept, consensus "3/3"
```

### T-FI-03: Near-exact dedup (Levenshtein)

```javascript
Input: claude: "output consistency", gpt: "output-consistency" (similarity ~0.94)
Expect: single group, consensus "2/3" (threshold 0.9)
```

### T-FI-04: Distinct concepts remain separate

```javascript
Input: claude: "consistency", gpt: "reliability" (similarity ~0.3)
Expect: two separate concepts, each consensus "1/3"
```

### T-FI-05: explicit_in_source OR logic

```javascript
Input: claude: { explicit_in_source: false }, gpt: { explicit_in_source: true }, same term
Expect: merged concept has explicit_in_source: true
```

### T-FI-06: Empty provider output

```javascript
Input: claude: 5 concepts, gpt: 0 concepts, gemini: 3 concepts
Expect: max consensus is "2/3" for any concept
```

### T-FI-07: Category resolution (most frequent)

```javascript
Input: claude: { category: "property" }, gpt: { category: "property" }, gemini: { category: "method" }
Expect: merged category = "property"
```

---

## 4. Test vectors — FusionInterAngle

### T-FN-01: Semantic merge

```javascript
Input: angle1 has "consistency", angle2 has "output consistency"
Mock embeddings: cosine similarity = 0.92 (> 0.85)
Expect: single FinalConcept with both in variants, angles_count "2/5"
```

### T-FN-02: Distinct concepts

```javascript
Input: "consistency" and "reliability"
Mock embeddings: cosine similarity = 0.78 (< 0.85)
Expect: two separate FinalConcepts
```

### T-FN-03: Canonical term = most frequent

```javascript
Input: "consistency" appears in 3 angles, "output consistency" in 1
Expect: canonical_term = "consistency"
```

### T-FN-04: Angle provenance preserved

```javascript
Input: angle etats_ideaux has concept with consensus 3/3, angle taxonomie has same concept with consensus 2/3
Expect: angle_provenance has both angles with respective consensus values
```

---

## 5. Test vectors — QualityController

### T-QC-01: No errors → 1 round

```javascript
Mock R1 (Claude): { errors_found: [], no_error_count: 10 }
Expect: report.review_rounds = 1, corrections = [], list unchanged
```

### T-QC-02: Error flagged and confirmed → 2 rounds

```javascript
Mock R1: flags abusive_merge on "consistency+reliability"
Mock R2: verdict = "confirmed"
Expect: 2 rounds, 1 correction applied, concepts split
```

### T-QC-03: Error flagged, contested, resolved in R3 → 3 rounds

```javascript
Mock R1: flags incorrect_categorization on "temperature"
Mock R2: verdict = "contested"
Mock R3: decision = "corrected" (doubt = correct)
Expect: 3 rounds, correction applied
```

### T-QC-04: GPT additional error confirmed by Claude in R3

```javascript
Mock R1: no errors
Mock R2: additional_errors: [{ target: "caching", error_type: "incorrect_categorization" }]
Mock R3: decision = "corrected"
Expect: 3 rounds, 1 correction
```

---

## 6. Test vectors — RelevanceController

### T-RC-01: No flags → 1 round

```javascript
Mock R1: { flagged_off_topic: [], not_flagged_count: 10 }
Expect: 1 round, 0 removed, list unchanged
```

### T-RC-02: Flagged and confirmed → removed

```javascript
Mock R1: flags "blockchain"
Mock R2: confirmed_off_topic
Expect: 2 rounds, "blockchain" removed from list
```

### T-RC-03: Flagged but defended → retained

```javascript
Mock R1: flags "caching"
Mock R2: defended ("caching affects consistency")
Expect: 2 rounds, "caching" retained, appears in retained_after_dispute
```

### T-RC-04: Disagreement always retains

```javascript
Mock R1: flags 3 concepts
Mock R2: confirms 1, defends 2
Expect: 1 removed, 2 retained
```

---

## 7. Test vectors — CoverageVerifier

### T-CV-01: Explicit term

```javascript
Source text: "the variance of outputs"
Concept: { canonical_term: "variance" }
Expect: explicit_in_source = true
```

### T-CV-02: Implicit term

```javascript
Source text: "the variance of outputs"
Concept: { canonical_term: "consistency" }
Expect: explicit_in_source = false
```

### T-CV-03: Variant match

```javascript
Source text: "output variance was measured"
Concept: { canonical_term: "variance", variants: ["variance", "output variance"] }
Expect: explicit_in_source = true (variant matches)
```

### T-CV-04: Fragile detection

```javascript
Concept: { explicit_in_source: false, angle_provenance: { conditions_bord: { consensus: "1/3" } } }
Expect: counted in stats.fragile
```

---

## 8. Test vectors — DiagnosticsGenerator

### T-DG-01: Unique by angle

```javascript
Input: concept A found only by extraction_directe, concept B found by 3 angles
Expect: unique_by_angle.extraction_directe = 1, concept B not counted as unique
```

### T-DG-02: Unique by model

```javascript
Input: concept C found only by gemini (across all its angles)
Expect: unique_by_model.gemini includes concept C
```

### T-DG-03: Unanimous

```javascript
Input: concept with 3+ angles AND consensus "3/3" on at least one angle
Expect: counted in unanimous_concepts
```

---

## 9. Test vectors — RunManager

### T-RM-01: Directory structure created

```javascript
After initRun: verify dirs exist (inputs/, extraction/, fusion-intra/, fusion-inter/)
```

### T-RM-02: Manifest lifecycle

```javascript
initRun → status: 'running'
finalizeRun → status: 'completed', finished_at set, results populated
```

### T-RM-03: Persist extraction pass

```javascript
persistExtractionPass('etats_ideaux', 'claude', concepts)
Verify: file exists at extraction/etats_ideaux-claude.json, content matches
```

### T-RM-04: listRuns returns antéchronologique

```javascript
Create 3 runs with different timestamps
Expect: listRuns returns newest first
```

### T-RM-05: failRun sets status

```javascript
failRun(new Error('test'))
Expect: manifest.status = 'failed', finished_at set
```

---

## 10. Test vectors — EventLogger

### T-EL-01: Emit writes to file

```javascript
emit({ phase: 'extraction', type: 'extraction_start', payload: {} })
Verify: events.jsonl has 1 line, parseable as PipelineEvent, timestamp present
```

### T-EL-02: Multiple emits append

```javascript
emit 3 events
Verify: events.jsonl has 3 lines
```

### T-EL-03: getEvents returns all

```javascript
emit 5 events
getEvents() returns array of 5 PipelineEvents
```

---

## 11. Test vectors — CLI

### T-CLI-01: Parse run command

```javascript
Argv: ['node', 'kce', 'run', '--prompt', 'test query', '--files', 'a.md', 'b.txt']
Expect: { command: 'run', options: { prompt: 'test query', files: ['a.md', 'b.txt'] } }
```

### T-CLI-02: No args shows usage

```javascript
Argv: ['node', 'kce']
Expect: prints usage, exit code 1
```

### T-CLI-03: History command

```javascript
Argv: ['node', 'kce', 'history']
Expect: { command: 'history' }
```

---

## 12. Test vectors — WebServer

### T-WS-01: POST /api/runs starts a run

```javascript
POST /api/runs with prompt="test"
Expect: 201, body has run_id
```

### T-WS-02: POST /api/runs while running → 409

```javascript
Start a run, then POST /api/runs again
Expect: 409 { error: "A run is already in progress" }
```

### T-WS-03: GET /api/runs lists runs

```javascript
Create 2 runs
GET /api/runs
Expect: array of 2 RunManifests, newest first
```

### T-WS-04: DELETE /api/runs/:id stops run

```javascript
Start a run, DELETE /api/runs/:id
Expect: 200, run status becomes 'stopped'
```

### T-WS-05: WebSocket receives events

```javascript
Connect WS to /ws/runs/:id, start run
Expect: messages arrive matching PipelineEvent schema
```

---

## 13. Pipeline integration test

### T-INT-01: Full pipeline with mocked providers

```javascript
Setup:
  - Mock all 3 provider adapters to return fixture extraction data
  - Mock embedding adapter to return predetermined vectors
  - Mock control responses (quality + relevance)

Run full pipeline with sample-vision.md

Verify:
  - 15 extraction files exist
  - 5 intra-angle files + 10 control reports (5 quality + 5 relevance)
  - 1 inter-angle merged file + 2 control reports
  - diagnostics.json exists and is valid
  - manifest.json status = 'completed'
  - events.jsonl has events from all 4 phases
  - Total concepts > 0
```

### T-INT-02: Fatal error stops pipeline

```javascript
Setup: Mock anthropic adapter to always throw FatalLLMError
Run pipeline
Verify: manifest.status = 'failed', events.jsonl contains run_error event
```

### T-INT-03: Graceful stop

```javascript
Setup: Mock adapters with delay. Trigger stop after 3 extraction passes.
Verify: manifest.status = 'stopped', partial extraction files exist, events.jsonl contains run_stopped
```

---

## 14. Property tests (anti-cheat)

### P-01: FusionIntraAngle is deterministic

```javascript
Property: fuse(input) called twice with identical input produces identical output
```

### P-02: FusionIntraAngle consensus bounds

```javascript
Property: for any input, every concept has consensus in {'1/3', '2/3', '3/3'}
```

### P-03: CoverageVerifier is idempotent

```javascript
Property: verify(verify(input).concepts, sourceText) produces identical output
```

### P-04: EventLogger append-only

```javascript
Property: getEvents().length after N emits === N. No events disappear.
```

### P-05: RunManager isolation

```javascript
Property: two RunManagers with different runIds never write to the same directory
```

### P-06: Pipeline fail-closed

```javascript
Property: if any provider adapter throws FatalLLMError, pipeline status = 'failed'
```

### P-07: Relevance controller never adds concepts

```javascript
Property: filteredList.length <= input.mergedList.length (only removes, never adds)
```

### P-08: Quality controller preserves concept count (or increases via splits)

```javascript
Property: correctedList.length >= input.mergedList.length (splits increase, never decrease)
```

---

## 15. Contract invariants (transversal)

### C-01: All JSON outputs are valid JSON

```javascript
Every file in extraction/, fusion-intra/, fusion-inter/, and diagnostics.json must be parseable JSON.
```

### C-02: manifest.json always has required fields

```javascript
run_id, status, created_at are never null or missing.
```

### C-03: events.jsonl lines are valid JSON

```javascript
Every line in events.jsonl, split by \n, is a valid JSON object with timestamp, phase, type, payload.
```

### C-04: 15 extraction files when pipeline completes

```javascript
If status = 'completed', extraction/ contains exactly 15 files matching {angle}-{provider}.json.
```

### C-05: Concept count consistency

```javascript
diagnostics.total_after_inter_angle === length of fusion-inter/merged.json concepts array.
```

### C-06: Angle IDs are canonical

```javascript
All angle IDs in any output file are from the set: extraction_directe, etats_ideaux, mecanismes_causaux, taxonomie, conditions_bord.
```

### C-07: Provider IDs are canonical

```javascript
All provider short IDs in any output file are from the set: claude, gpt, gemini.
```

---

## 16. Test helpers

### mock-provider.ts

```typescript
// Creates a ProviderAdapter that returns predetermined responses
// based on (angle, provider) key.
function createMockProvider(
  responses: Record<string, string>  // key: "{angle}-{provider}", value: JSON string
): ProviderAdapter;
```

### mock-embedding.ts

```typescript
// Creates an EmbeddingAdapter that returns predetermined vectors.
// Uses a simple mapping: similar terms get similar vectors.
function createMockEmbedding(
  similarPairs: Array<[string, string, number]>  // [term1, term2, similarity]
): EmbeddingAdapter;
```

### temp-dir.ts

```typescript
// Creates a temp directory for a test, returns path, cleans up after test.
function withTempDir(fn: (dir: string) => Promise<void>): () => Promise<void>;
```

### fixture-loader.ts

```typescript
// Loads fixture files from tests/fixtures/
function loadFixture(relativePath: string): string;
function loadJsonFixture<T>(relativePath: string): T;
```

---

*VegaCorp — Implicit-Free Execution (IFE) — "Reliability precedes intelligence."*
