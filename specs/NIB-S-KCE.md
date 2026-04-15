---
id: NIB-S-KCE
type: nib-system
version: "1.0.0"
scope: key-concepts-extractor
status: approved
consumers: [claude-code]
superseded_by: []
---

---

## 1. System objective

Extract the most complete possible list of key concepts from a research corpus and/or a research prompt, using a multi-LLM × multi-angle matrix (3 models × 5 angles = 15 passes), with adversarial quality and relevance controls, producing a deduplicated, clustered, and scored concept list ready for downstream query generation (Module 2 of the literature review pipeline).

---

## 2. Pipeline architecture

The pipeline executes 6 sequential phases. No phase begins before the previous phase completes entirely.

```javascript
Phase 1: INPUT PROCESSING
    │
    ▼
Phase 2: EXTRACTION (5 angles × 3 providers = 15 passes)
    │
    ▼
Phase 3: FUSION INTRA-ANGLE (×5, each with quality + relevance controls)
    │
    ▼
Phase 4: FUSION INTER-ANGLE (×1, with quality + relevance controls)
    │
    ▼
Phase 5: COVERAGE VERIFICATION
    │
    ▼
Phase 6: DIAGNOSTICS & FINALIZATION
```

**Execution within Phase 2:** Angles are processed **sequentially** (angle 1, then angle 2, etc.). Within each angle, the 3 provider calls execute in **parallel**. Maximum 3 concurrent API calls at any time.

**Execution within Phase 3:** The 5 angles are processed **sequentially**. For each angle, the intra-angle fusion runs, then the quality control (§8.5), then the relevance control (§8.6). An angle is fully validated before the next angle begins.

---

## 3. Module boundaries

### 3.1 InputProcessor

```typescript
// Input
interface InputProcessorInput {
  prompt?: string;            // Free-text research prompt
  files?: InputFile[];        // .md and .txt files
}
interface InputFile {
  name: string;               // Original filename
  content: string;            // File content as UTF-8 string
}
// Output
interface InputProcessorOutput {
  context: string;            // Concatenated context (prompt + files)
  inputFiles: InputFileMeta[];// Metadata for persistence
  prompt: string | null;      // Original prompt (null if not provided)
}
interface InputFileMeta {
  originalName: string;
  normalizedName: string;     // doc-{NNN}.{ext}
  sizeBytes: number;
}
```

**Constraint:** At least one of `prompt` or `files` must be provided. If both, prompt is prefixed to the concatenated file content.

### 3.2 ProviderAdapter

```typescript
// Input
interface LLMRequest {
  systemPrompt: string;
  userPrompt: string;
  provider: ProviderLongId;       // 'anthropic' | 'openai' | 'google'
}
// Output
interface LLMResponse {
  content: string;            // Raw JSON string from the LLM
  provider: ProviderLongId;
  model: string;              // Actual model used
  latencyMs: number;
}
// Error
interface LLMError {
  provider: ProviderLongId;
  error: string;
  retriesExhausted: boolean;
}
```

**Contract:** Each adapter handles retry (3 attempts, backoff 5s/15s/45s) and timeout (120s) internally. After 3 failed retries, throws a fatal `LLMError` with `retriesExhausted: true`.

### 3.3 ExtractionOrchestrator

```typescript
// Input
interface ExtractionInput {
  context: string;                    // From InputProcessor
}
// Output
interface ExtractionOutput {
  passes: ExtractionPass[];           // 15 passes
}
interface ExtractionPass {
  angle: AngleId;                     // See §3.14
  provider: ProviderId;          // 'claude' | 'gpt' | 'gemini'
  concepts: RawConcept[];
}
interface RawConcept {
  term: string;                       // 1-4 words, academic English
  category: ConceptCategory;
  granularity: GranularityLevel;
  explicit_in_source: boolean;
  justification: string;              // One sentence
}
```

### 3.4 FusionIntraAngle

```typescript
// Input
interface FusionIntraInput {
  angle: AngleId;
  passes: ExtractionPass[];           // 3 passes (one per provider) for this angle
  levenshteinThreshold: number;       // Default 0.9
}
// Output
interface FusionIntraOutput {
  angle: AngleId;
  concepts: IntraAngleConcept[];
}
interface IntraAngleConcept {
  term: string;
  consensus: '1/3' | '2/3' | '3/3';
  found_by_models: ProviderId[];
  category: ConceptCategory;
  granularity: GranularityLevel;
  explicit_in_source: boolean;
  justifications: Record<ProviderId, string>;
}
```

### 3.5 FusionInterAngle

```typescript
// Input
interface FusionInterInput {
  angleLists: FusionIntraOutput[];    // 5 angle lists (post-controls)
  embeddingThreshold: number;         // Default 0.85
}
// Output
interface FusionInterOutput {
  concepts: FinalConcept[];
}
interface FinalConcept {
  canonical_term: string;
  variants: string[];
  category: ConceptCategory;
  granularity: GranularityLevel;
  explicit_in_source: boolean;
  angle_provenance: Record<AngleId, {
    consensus: '1/3' | '2/3' | '3/3';
    models: ProviderId[];
  }>;
  angles_count: AnglesCount;          // '1/5' | '2/5' | '3/5' | '4/5' | '5/5'
  justifications: string[];
}
// Persisted format for merged.json (wraps FinalConcept[] with metadata)
interface MergedOutput {
  metadata: {
    models: ProviderId[];          // ['claude', 'gpt', 'gemini']
    angles: readonly AngleId[];         // All 5 angle IDs (frozen via CANONICAL_ANGLES)
    total_passes: number;               // 15
    fusion_similarity_threshold: number; // The embedding threshold used
    date: string;                       // ISO 8601 date (YYYY-MM-DD)
  };
  concepts: FinalConcept[];
  diagnostics: DiagnosticsReport;
}
```

### 3.6 QualityController

```typescript
// Input
interface QualityControlInput {
  mergedList: IntraAngleConcept[] | FinalConcept[];  // Polymorphic
  context: string;
  scope: ControlScope;                // 'angle:{angleId}' | 'inter_angle'
}
// Output
interface QualityControlOutput {
  correctedList: typeof input.mergedList; // Same type as input, corrected
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
  // Required non-null for abusive_merge (≥2 distinct terms, none === target).
  // Validated fail-closed in QC before applyCorrections — see NIB-M-QUALITY-CONTROLLER §3, §4.4.
  suggested_split: string[] | null;
  flagged_by: 'claude' | 'gpt';
  confirmed_by: 'claude' | 'gpt' | null;
  justification: string;
}
```

### 3.7 RelevanceController

```typescript
// Input
interface RelevanceControlInput {
  mergedList: IntraAngleConcept[] | FinalConcept[];
  context: string;
  scope: ControlScope;
}
// Output
interface RelevanceControlOutput {
  filteredList: typeof input.mergedList; // Same type, some items removed
  report: RelevanceReport;
}
interface RelevanceReport {
  review_rounds: number;              // 1-3
  concepts_flagged: number;
  concepts_removed: number;
  concepts_retained_after_dispute: number;
  removed: RelevanceRemoval[];
  retained_after_dispute: RelevanceRetention[];
}
// Field naming follows NIB-M-LLM-PAYLOADS (`target`/`reason`) — the LLM
// schema dictates the wire shape, propagated unchanged through the parser.
// `confirmed_by` is nullable for the no-round-3 path (GPT-only flag retained).
interface RelevanceRemoval {
  target: string;
  reason: string;
  flagged_by: 'claude' | 'gpt';
  confirmed_by: 'claude' | 'gpt' | null;
}
// Minimal shape: only the audit signal (which term, how it was defended) is
// kept. Per-round provenance can be recovered from events.jsonl if needed.
interface RelevanceRetention {
  target: string;
  defense: string;
}
```

### 3.8 CoverageVerifier

```typescript
// Input
interface CoverageInput {
  concepts: FinalConcept[];
  sourceText: string;                 // Raw concatenated source text
}
// Output
interface CoverageOutput {
  concepts: FinalConcept[];           // With explicit_in_source updated
  stats: {
    explicit: number;
    implicit: number;
    fragile: number;                  // implicit + 1 angle + consensus 1/3
  };
}
```

### 3.9 DiagnosticsGenerator

```typescript
// Input
interface DiagnosticsInput {
  rawPasses: ExtractionPass[];        // 15 passes
  intraAngleResults: FusionIntraOutput[];  // 5 post-control
  finalConcepts: FinalConcept[];
  coverageStats: CoverageOutput['stats'];
}
// Output
interface DiagnosticsReport {
  total_raw: number;
  total_after_intra_angle: number;
  total_after_inter_angle: number;
  unique_by_angle: Record<AngleId, number>;
  unique_by_model: Record<ProviderId, number>;
  fragile_concepts: number;
  unanimous_concepts: number;
}
```

### 3.10 RunManager

```typescript
// Manages
interface RunManifest {
  run_id: string;                     // Format: YYYYMMDD-HHmmss-{4hex}
  status: 'running' | 'completed' | 'failed' | 'stopped';
  created_at: string;                 // ISO 8601
  finished_at?: string;               // ISO 8601, set on terminal status
  source: 'cli' | 'web';
  // Prompt content lives in inputs/prompt.txt (kept out of manifest to
  // avoid bloating the index file with potentially large payloads).
  input_files: string[];              // Normalized names; content under inputs/
  config: RunConfig;
  results?: {
    total_concepts: number;
    fragile_concepts: number;
    unanimous_concepts: number;
  };
}
interface RunConfig {
  models: Record<ProviderLongId, string>;
  embedding_model: string;
  levenshtein_threshold: number;
  embedding_threshold: number;
}
```

**Filesystem contract:** see §7 for the exact directory structure.

### 3.11 EventLogger

```typescript
interface PipelineEvent {
  timestamp: string;                  // ISO 8601 with ms
  phase: 'input' | 'extraction' | 'fusion_intra' | 'fusion_inter' | 'diagnostics' | 'run';
  type: string;                       // See Spec v1.5 §13 for all event types
  payload: Record<string, unknown>;
}
```

**Contract:** Append-only to `events.jsonl`. One JSON line per event. Events are emitted by each module via a shared emitter injected at construction.

### 3.12 CLI

```typescript
// Commands
// kce run --prompt "..." --files <path> [<path> ...]
// kce history
// kce show <run_id>
// Ctrl+C → graceful stop
```

### 3.13 WebServer + WebUI

```typescript
// WebServer: HTTP + WebSocket
// - POST /api/runs → start a run
// - DELETE /api/runs/:id → stop a run
// - GET /api/runs → list runs
// - GET /api/runs/:id → get run details
// - GET /api/runs/:id/files/:path → get result file
// - WebSocket /ws/runs/:id → real-time event stream
// WebUI: SPA served by WebServer, consumes the API above.
```

### 3.14 Shared types

```typescript
type AngleId = 'extraction_directe' | 'etats_ideaux' | 'mecanismes_causaux' | 'taxonomie' | 'conditions_bord';
type ProviderLongId = 'anthropic' | 'openai' | 'google';
type ProviderId = 'claude' | 'gpt' | 'gemini';
type ConceptCategory = 'phenomenon' | 'method' | 'metric' | 'property' | 'architecture' | 'tool' | 'constraint' | 'context';
type GranularityLevel = 'token-level' | 'model-level' | 'system-level' | 'pipeline-level' | 'domain-level';
type ControlScope = `angle:${AngleId}` | 'inter_angle';
type AnglesCount = '1/5' | '2/5' | '3/5' | '4/5' | '5/5';

const ANGLES: AngleId[] = ['extraction_directe', 'etats_ideaux', 'mecanismes_causaux', 'taxonomie', 'conditions_bord'];
const PROVIDERS: { id: ProviderLongId; shortId: ProviderId }[] = [
  { id: 'anthropic', shortId: 'claude' },
  { id: 'openai', shortId: 'gpt' },
  { id: 'google', shortId: 'gemini' },
];
```

### 3.15 PipelineConfig

Consolidated configuration interface. Resolved at startup and injected into all modules. No module reads configuration from environment variables directly (policy P6).

```typescript
interface PipelineConfig {
  // Provider credentials
  anthropic: { apiKey: string; model: string; endpoint: string };
  openai: { apiKey: string; model: string; endpoint: string };
  google: { apiKey: string; model: string; endpoint: string };

  // Embedding
  embeddingModel: string;

  // Fusion thresholds
  levenshteinThreshold: number;
  embeddingThreshold: number;

  // Storage
  runsDir: string;

  // Server (web mode only)
  port: number;
}
```

**Defaults:**

| Parameter | Default |
|---|---|
| anthropic.model | claude-opus-4-6 |
| anthropic.endpoint | https://api.anthropic.com |
| openai.model | gpt-5.4 |
| openai.endpoint | https://api.openai.com |
| google.model | gemini-3.1-pro-preview |
| google.endpoint | https://generativelanguage.googleapis.com |
| embeddingModel | text-embedding-3-small |
| levenshteinThreshold | 0.9 |
| embeddingThreshold | 0.85 |
| runsDir | ~/.kce/runs/ |
| port | 3000 |

**API keys have no default** — the pipeline must fail at startup if any key is missing.

**Constants (not configurable, hardcoded):**
- Reasoning level: always "high" (P1)
- Number of models: 3
- Number of angles: 5
- Max control rounds: 3
- Timeout per call: 120s
- Max retries: 3
- Backoff sequence: [5000, 15000, 45000] ms

---

## 4. Global invariants

**INV-1 — Fail-closed on API failure.** Any API call that exhausts 3 retries is a fatal error. The pipeline stops. No partial fusion proceeds with missing data. A missing provider corrupts consensus scores.

**INV-2 — Sequential angles, parallel providers.** Within Phase 2, angles are sequential. Within each angle, provider calls are parallel (max 3 concurrent). This invariant also holds for control phases.

**INV-3 — Immutable intermediate artifacts.** Once a phase produces its output (files on disk), the files are never modified by subsequent phases. Each phase reads its inputs and writes new files.

**INV-4 — 87 API calls maximum.** 15 extraction + 72 controls (6 control points × 12 calls max per point). The pipeline never exceeds this bound.

**INV-5 — Event completeness.** Every phase transition and every API call (start, complete, error) produces an event in events.jsonl. The event log is sufficient to reconstruct the full execution history.

**INV-6 — Run isolation.** Each run has its own directory. Runs never share state. Concurrent runs are not supported (enforced by both CLI and WebServer).

**INV-7 — Graceful stop.** On user interruption (Ctrl+C or API call), the pipeline finishes the current API call, persists partial results, and records the run as 'stopped'.

---

## 5. Cross-cutting policies

**P1 — Reasoning level: always "high".** All LLM calls use the highest reasoning mode: adaptive thinking (Anthropic), reasoning.effort "high" (OpenAI), thinking_level "high" (Google). This is hardcoded, not configurable.

**P2 — Control roles are provider-bound.** Quality and relevance controls use Claude (Anthropic) and GPT (OpenAI) only. Gemini never participates in controls. Roles: Claude = Round 1 + Round 3, GPT = Round 2. This is hardcoded regardless of which models are configured.

**P3 — All LLM outputs are strict JSON.** No markdown, no preamble, no commentary. Every LLM call includes this instruction. Response parsing must validate JSON and report parse errors as retriable failures.

**P4 — Retry policy: uniform.** 120s timeout, 3 retries, backoff 5s/15s/45s. Applies to all API calls (extraction and controls). JSON parse failure counts as a retriable error.

**P5 — Event emission via shared emitter.** All modules receive an `EventEmitter` at construction. Events are defined in Spec v1.5 §13. The emitter writes to events.jsonl AND forwards to WebSocket clients (if any).

**P6 — Configuration is external.** No module reads configuration from environment variables directly. All configuration is resolved at startup and injected into modules as typed config objects.

---

## 6. Output contract

The system produces the directory structure defined in Spec v1.5 §12:

```javascript
{runs_dir}/{run_id}/
├── manifest.json          → RunManifest
├── inputs/
│   ├── prompt.txt         → Original prompt (if provided)
│   ├── doc-001.md         → Normalized copies of input files
│   └── doc-002.txt
├── extraction/
│   ├── extraction_directe-claude.json   → RawConcept[]
│   ├── extraction_directe-gpt.json
│   ├── extraction_directe-gemini.json
│   └── ... (15 files)
├── fusion-intra/
│   ├── extraction_directe.json          → IntraAngleConcept[]
│   ├── extraction_directe-quality.json  → QualityReport
│   ├── extraction_directe-relevance.json→ RelevanceReport
│   └── ... (15 files: 5 × 3)
├── fusion-inter/
│   ├── merged.json                      → MergedOutput (see below)
│   ├── quality.json                     → QualityReport
│   └── relevance.json                   → RelevanceReport
├── diagnostics.json                     → DiagnosticsReport
└── events.jsonl                         → PipelineEvent[]
```

---

## 7. Orchestration pseudocode

```typescript
async function runPipeline(input: InputProcessorInput, config: PipelineConfig): Promise<void> {
  const runId = generateRunId();
  const runManager = new RunManager(config.runsDir, runId);
  const emitter = new EventEmitter(runManager, wsClients);

  try {
    runManager.initRun(input, config);

    // Phase 1 — Input Processing
    const { context, inputFiles, prompt } = InputProcessor.process(input);
    runManager.persistInputs(prompt, inputFiles);

    // Phase 2 — Extraction (15 passes)
    const allPasses: ExtractionPass[] = [];
    for (const angle of ANGLES) {
      emitter.emit({ phase: 'extraction', type: 'extraction_progress', payload: { completed: allPasses.length, total: 15 } });

      // 3 providers in parallel for this angle
      const anglePasses = await Promise.all(
        PROVIDERS.map(async (provider) => {
          emitter.emit({ phase: 'extraction', type: 'extraction_start', payload: { angle, model: provider.shortId } });
          const request = buildExtractionRequest(context, angle);  // Uses LLM Payloads Type 1
          const response = await providerAdapters[provider.id].call(request);
          const concepts = parseAndValidate<RawConcept[]>(response.content);
          emitter.emit({ phase: 'extraction', type: 'extraction_complete', payload: { angle, model: provider.shortId, concepts_count: concepts.length } });
          runManager.persistExtractionPass(angle, provider.shortId, concepts);
          return { angle, provider: provider.shortId, concepts };
        })
      );
      allPasses.push(...anglePasses);
    }

    // Phase 3 — Fusion Intra-Angle (×5, each with controls)
    const intraResults: FusionIntraOutput[] = [];
    for (const angle of ANGLES) {
      const anglePasses = allPasses.filter(p => p.angle === angle);

      // 3a. Mechanical fusion
      let intraResult = FusionIntraAngle.fuse({ angle, passes: anglePasses, levenshteinThreshold: config.levenshteinThreshold });
      emitter.emit({ phase: 'fusion_intra', type: 'fusion_intra_complete', payload: { angle, output_count: intraResult.concepts.length } });

      // 3b. Quality control
      const qualityResult = await QualityController.run({ mergedList: intraResult.concepts, context, scope: `angle:${angle}` });
      intraResult = { ...intraResult, concepts: qualityResult.correctedList };
      runManager.persistIntraAngle(angle, intraResult, qualityResult.report);

      // 3c. Relevance control
      const relevanceResult = await RelevanceController.run({ mergedList: intraResult.concepts, context, scope: `angle:${angle}` });
      intraResult = { ...intraResult, concepts: relevanceResult.filteredList };
      runManager.persistIntraAngleRelevance(angle, relevanceResult.report);

      intraResults.push(intraResult);
    }

    // Phase 4 — Fusion Inter-Angle (with controls)
    let interResult = await FusionInterAngle.fuse({ angleLists: intraResults, embeddingThreshold: config.embeddingThreshold });
    emitter.emit({ phase: 'fusion_inter', type: 'fusion_inter_complete', payload: { clusters: interResult.concepts.length, concepts_final: interResult.concepts.length } });

    const interQuality = await QualityController.run({ mergedList: interResult.concepts, context, scope: 'inter_angle' });
    interResult = { concepts: interQuality.correctedList as FinalConcept[] };

    const interRelevance = await RelevanceController.run({ mergedList: interResult.concepts, context, scope: 'inter_angle' });
    interResult = { concepts: interRelevance.filteredList as FinalConcept[] };
    runManager.persistInterAngle(interResult, interQuality.report, interRelevance.report);

    // Phase 5 — Coverage Verification
    const coverage = CoverageVerifier.verify({ concepts: interResult.concepts, sourceText: context });
    emitter.emit({ phase: 'finalization', type: 'coverage_complete', payload: coverage.stats });

    // Phase 6 — Diagnostics & Finalization
    const diagnostics = DiagnosticsGenerator.generate({
      rawPasses: allPasses,
      intraAngleResults: intraResults,
      finalConcepts: coverage.concepts,
      coverageStats: coverage.stats,
    });
    runManager.persistDiagnostics(diagnostics);
    runManager.finalizeRun(coverage.concepts.length, coverage.stats.fragile, diagnostics.unanimous_concepts);
    emitter.emit({ phase: 'finalization', type: 'run_complete', payload: { total_concepts: coverage.concepts.length, output_dir: runManager.runDir } });

  } catch (error) {
    runManager.failRun(error);
    emitter.emit({ phase: 'finalization', type: 'run_error', payload: { error: error.message, fatal: true } });
    throw error;
  }
}
```

---

## 8. Module dependency graph

```javascript
InputProcessor ──────► ExtractionOrchestrator ──► FusionIntraAngle ──► QualityController
                              │                         │                    │
                       ProviderAdapters                  │              RelevanceController
                              │                         │                    │
                              ▼                         ▼                    ▼
                       (uses DC-ANTHROPIC,        FusionInterAngle ──► QualityController
                        DC-OPENAI,                      │                    │
                        DC-GOOGLE-GEMINI)                │              RelevanceController
                                                        ▼                    │
                                                  CoverageVerifier           │
                                                        │                   │
                                                        ▼                   │
                                                  DiagnosticsGenerator      │
                                                                            │
                       RunManager ◄──── all modules (persistence)           │
                       EventLogger ◄──── all modules (events)              │
                       CLI ──────────► Pipeline orchestrator                │
                       WebServer ────► Pipeline orchestrator                │
                       WebUI ────────► WebServer (HTTP + WS)               │
```

No circular dependencies. Data flows strictly left-to-right / top-to-bottom.

---

## 9. References

- **Spec v1.5** — key-concepts-extractor Spécification v1.5 (normative)
- **LLM Payloads v0.2** — all LLM prompts (normative for implementation)
- **Interface Spec v1.0** — CLI and Web interface (normative for Modules 12-14)

---

*VegaCorp — Implicit-Free Execution (IFE) — "Reliability precedes intelligence."*
