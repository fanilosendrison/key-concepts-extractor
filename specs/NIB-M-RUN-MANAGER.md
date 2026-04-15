---
id: NIB-M-RUN-MANAGER
type: nib-module
version: "1.0.0"
scope: key-concepts-extractor/run-manager
status: approved
consumers: [claude-code]
superseded_by: []
---

---

## 1. Purpose

Manages the lifecycle and filesystem persistence of a single run. Creates the directory structure, writes intermediate and final artifacts, maintains the manifest, and provides history/retrieval for past runs.

---

## 2. Inputs / Dependencies

```typescript
interface RunManagerConfig {
  runsDir: string;     // Absolute path, default ~/.kce/runs/
}
```

---

## 3. Interface

```typescript
class RunManager {
  readonly runId: string;
  readonly runDir: string;                  // {runsDir}/{runId}/

  constructor(config: RunManagerConfig, runId: string);

  // Lifecycle
  initRun(input: InputProcessorInput, pipelineConfig: PipelineConfig, source: 'cli' | 'web'): void;
  finalizeRun(totalConcepts: number, fragileConcepts: number, unanimousConcepts: number): void;
  failRun(error: Error): void;
  stopRun(): void;

  // Persistence
  persistInputs(prompt: string | null, files: InputFileMeta[], fileContents: InputFile[]): void;
  persistExtractionPass(angle: AngleId, provider: ProviderShortId, concepts: RawConcept[]): void;
  persistIntraAngle(angle: AngleId, result: FusionIntraOutput, qualityReport: QualityReport): void;
  persistIntraAngleRelevance(angle: AngleId, relevanceReport: RelevanceReport): void;
  persistInterAngle(result: FusionInterOutput, qualityReport: QualityReport, relevanceReport: RelevanceReport): void;
  persistDiagnostics(report: DiagnosticsReport): void;

  // History (static)
  static listRuns(runsDir: string): RunManifest[];
  static getRun(runsDir: string, runId: string): { manifest: RunManifest; events: PipelineEvent[] };
  static getRunFile(runsDir: string, runId: string, relativePath: string): string;
}
```

---

## 4. Algorithm

### 4.1 generateRunId()

```javascript
function generateRunId(): string {
  const now = new Date();
  const date = format(now, 'yyyyMMdd-HHmmss');
  const hex = randomBytes(2).toString('hex');  // 4 hex chars
  return `${date}-${hex}`;
}
// Example: "20260415-143022-a7b3"
```

### 4.2 initRun(input, config, source)

```javascript
function initRun(input, config, source): void {
  // Create directory structure
  mkdirSync(this.runDir);
  mkdirSync(join(this.runDir, 'inputs'));
  mkdirSync(join(this.runDir, 'extraction'));
  mkdirSync(join(this.runDir, 'fusion-intra'));
  mkdirSync(join(this.runDir, 'fusion-inter'));

  // Write initial manifest
  const manifest: RunManifest = {
    run_id: this.runId,
    status: 'running',
    created_at: new Date().toISOString(),
    finished_at: null,
    source,
    prompt: input.prompt ?? null,
    input_files: [],  // Filled by persistInputs
    config: {
      models: { anthropic: config.anthropic.model, openai: config.openai.model, google: config.google.model },
      embedding_model: config.embeddingModel,
      levenshtein_threshold: config.levenshteinThreshold,
      embedding_threshold: config.embeddingThreshold,
    },
    results: null,
  };
  writeJsonSync(join(this.runDir, 'manifest.json'), manifest);
}
```

### 4.3 persistInputs(prompt, files, fileContents)

```javascript
function persistInputs(prompt, files, fileContents): void {
  if (prompt) {
    writeFileSync(join(this.runDir, 'inputs', 'prompt.txt'), prompt);
  }
  for (let i = 0; i < files.length; i++) {
    writeFileSync(join(this.runDir, 'inputs', files[i].normalizedName), fileContents[i].content);
  }
  // Update manifest.input_files
  this.updateManifest({ input_files: files.map(f => f.normalizedName) });
}
```

### 4.4 persistExtractionPass(angle, provider, concepts)

```javascript
function persistExtractionPass(angle, provider, concepts): void {
  const filename = `${angle}-${provider}.json`;
  writeJsonSync(join(this.runDir, 'extraction', filename), concepts);
}
```

### 4.5 persistIntraAngle(angle, result, qualityReport)

```javascript
function persistIntraAngle(angle, result, qualityReport): void {
  writeJsonSync(join(this.runDir, 'fusion-intra', `${angle}.json`), result.concepts);
  writeJsonSync(join(this.runDir, 'fusion-intra', `${angle}-quality.json`), qualityReport);
}
```

### 4.5b persistIntraAngleRelevance(angle, relevanceReport)

```javascript
function persistIntraAngleRelevance(angle, relevanceReport): void {
  writeJsonSync(join(this.runDir, 'fusion-intra', `${angle}-relevance.json`), relevanceReport);
}
```

### 4.5c persistInterAngle(result, qualityReport, relevanceReport)

Builds the `MergedOutput` wrapper defined in NIB-S §3.5 before writing `merged.json`.

```javascript
function persistInterAngle(result, qualityReport, relevanceReport): void {
  const manifest = readJsonSync(join(this.runDir, 'manifest.json'));
  const mergedOutput: MergedOutput = {
    metadata: {
      models: ['claude', 'gpt', 'gemini'],
      angles: ANGLES,
      total_passes: 15,
      fusion_similarity_threshold: manifest.config.embedding_threshold,
      date: new Date().toISOString().slice(0, 10),  // YYYY-MM-DD
    },
    concepts: result.concepts,
    diagnostics: null,  // Filled by persistDiagnostics
  };
  writeJsonSync(join(this.runDir, 'fusion-inter', 'merged.json'), mergedOutput);
  writeJsonSync(join(this.runDir, 'fusion-inter', 'quality.json'), qualityReport);
  writeJsonSync(join(this.runDir, 'fusion-inter', 'relevance.json'), relevanceReport);
}
```

### 4.5d persistDiagnostics(report)

```javascript
function persistDiagnostics(report): void {
  writeJsonSync(join(this.runDir, 'diagnostics.json'), report);
  // Also update merged.json with the diagnostics
  const merged = readJsonSync(join(this.runDir, 'fusion-inter', 'merged.json'));
  merged.diagnostics = report;
  writeJsonSync(join(this.runDir, 'fusion-inter', 'merged.json'), merged);
}
```

### 4.6 finalizeRun / failRun / stopRun

```javascript
function finalizeRun(totalConcepts, fragile, unanimous): void {
  this.updateManifest({
    status: 'completed',
    finished_at: new Date().toISOString(),
    results: { total_concepts: totalConcepts, fragile_concepts: fragile, unanimous_concepts: unanimous },
  });
}
function failRun(error): void {
  this.updateManifest({ status: 'failed', finished_at: new Date().toISOString() });
}
function stopRun(): void {
  this.updateManifest({ status: 'stopped', finished_at: new Date().toISOString() });
}
```

### 4.7 updateManifest(partial)

```javascript
function updateManifest(partial: Partial<RunManifest>): void {
  const manifest = readJsonSync(join(this.runDir, 'manifest.json'));
  Object.assign(manifest, partial);
  writeJsonSync(join(this.runDir, 'manifest.json'), manifest);
}
```

### 4.8 static listRuns(runsDir)

```javascript
function listRuns(runsDir): RunManifest[] {
  // Read all subdirectories of runsDir
  // For each, read manifest.json
  // Sort by created_at descending (antéchronologique)
  // Return array
}
```

---

## 5. Edge cases

| Case | Expected behavior |
|---|---|
| runsDir does not exist | Create it (mkdirp) on first initRun |
| Concurrent initRun (should not happen) | Not supported. Single run enforced by CLI/WebServer. |
| manifest.json corrupted | listRuns skips that run with a warning |
| Run directory partially deleted | getRun returns what exists, missing files reported |

---

## 6. Constraints

- **Synchronous writes** for manifest updates (atomic with respect to crash).
- **JSON pretty-printed** (2-space indent) for human readability.
- **No cleanup** — RunManager never deletes files. Cleanup is manual.
