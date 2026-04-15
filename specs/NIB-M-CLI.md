---
id: NIB-M-CLI
type: nib-module
version: "1.0.0"
scope: key-concepts-extractor/cli
status: approved
validates: [src/cli/**, tests/cli.test.ts]
consumers: [claude-code]
superseded_by: []
---

---

## 1. Purpose

Provides the `kce` command-line interface with three commands: `run` (launch extraction), `history` (list past runs), `show` (inspect a past run). Handles argument parsing, file reading, graceful interruption, and formatted stdout output.

---

## 2. Commands

### 2.1 `kce run`

```javascript
kce run --prompt "..." --files <path> [<path> ...]
```

- At least one of `--prompt` or `--files` required.
- `--files` accepts one or more paths to `.md` / `.txt` files.
- Reads files from disk, builds `InputProcessorInput`, launches pipeline.
- During execution: prints events to stdout (one line per event, horodated).
- On completion: prints total concepts count + run directory path.
- Exit code: 0 = success, 1 = fatal error, 130 = user interruption (Ctrl+C).

### 2.2 `kce history`

```javascript
kce history
```

- Lists all runs from `RunManager.listRuns()`, antéchronologique.
- Each line: `{run_id}  {date}  {status}  {concepts_count}  {prompt_preview}`
- `prompt_preview` = first 60 chars of prompt, or filenames if no prompt.

### 2.3 `kce show <run_id>`

```javascript
kce show 20260415-143022-a7b3
```

- Prints the full event log (from events.jsonl) formatted for humans.
- Prints the results summary (from manifest.json).
- If run files are missing, indicates which files are absent.

---

## 3. Algorithm

### 3.1 Argument parsing

```javascript
function parseArgs(argv: string[]): { command: 'run' | 'history' | 'show'; options: any } {
  const command = argv[2];  // 'run', 'history', 'show'
  if (command === 'run') {
    // Parse --prompt and --files
    // --prompt: next arg is the prompt string
    // --files: all subsequent args until next flag or end
    return { command: 'run', options: { prompt, files } };
  }
  if (command === 'history') return { command: 'history', options: {} };
  if (command === 'show') return { command: 'show', options: { runId: argv[3] } };
  // Unknown command: print usage, exit 1
}
```

### 3.2 File reading (run command)

```javascript
function readInputFiles(paths: string[]): InputFile[] {
  return paths.map(path => {
    const content = readFileSync(path, 'utf-8');
    const name = basename(path);
    return { name, content };
  });
}
```

### 3.3 Event display

```javascript
function formatEvent(event: PipelineEvent): string {
  const time = event.timestamp.slice(11, 23);  // HH:mm:ss.SSS
  // Format based on event type:
  // extraction_start: "[14:30:22.451] Extraction — etats_ideaux / claude — started"
  // extraction_complete: "[14:30:30.892] Extraction — etats_ideaux / claude — 18 concepts"
  // extraction_progress: "[14:30:30.892] Extraction — 7/15 passes"
  // control_start: "[14:31:05.123] Quality control — angle:etats_ideaux — R1 claude"
  // run_complete: "[14:47:11.000] ✅ Complete — 42 concepts — /home/.../.kce/runs/..."
  // run_error: "[14:35:00.000] ❌ Fatal — Anthropic API key invalid"
}
```

### 3.4 Graceful interruption

```javascript
process.on('SIGINT', async () => {
  // Set a flag that the pipeline checks between phases
  // Pipeline finishes current API call, then:
  //   runManager.stopRun()
  //   emitter.emit(runStopped('user_requested', true))
  //   process.exit(130)
});
```

### 3.5 Single run enforcement

Before starting a run, check `RunManager.listRuns()` for any run with `status: 'running'`. If found, print error and exit.

---

## 4. Edge cases

| Case | Expected behavior |
|---|---|
| No arguments | Print usage, exit 1 |
| `--files` with non-existent path | Print error ("File not found: ..."), exit 1 |
| `--files` with unsupported extension | Caught by InputProcessor validation, print error, exit 1 |
| `kce show` with unknown run_id | Print "Run not found", exit 1 |
| Ctrl+C during retry backoff | Immediate stop (sleep is interruptible) |
| `kce run` while another run is active | Print "A run is already in progress", exit 1 |

---

## 5. Constraints

- **No interactive prompts** — all input via arguments.
- **Structured stdout** — one event per line, parseable by scripts.
- **Shares run storage** with WebServer (constraint from Interface Spec §9.1).
