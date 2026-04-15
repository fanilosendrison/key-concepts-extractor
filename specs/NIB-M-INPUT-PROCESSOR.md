---
id: NIB-M-INPUT-PROCESSOR
type: nib-module
version: "1.0.0"
scope: key-concepts-extractor/input-processor
status: approved
consumers: [claude-code]
superseded_by: []
---

---

## 1. Purpose

Reads the user-provided prompt and/or files, validates that at least one input is present, normalizes file names, and produces a single concatenated context string consumed by all downstream modules.

---

## 2. Inputs

```typescript
interface InputProcessorInput {
  prompt?: string;       // Free-text research prompt (from CLI --prompt or web form)
  files?: InputFile[];   // From CLI --files or web drag-and-drop
}
interface InputFile {
  name: string;          // Original filename (e.g. "my notes.md")
  content: string;       // File content as UTF-8 string
}
```

Provenance: CLI parses `--prompt` and reads `--files` from filesystem. WebServer reads prompt from POST body and files from multipart upload. Both produce `InputProcessorInput`.

---

## 3. Outputs

```typescript
interface InputProcessorOutput {
  context: string;            // Concatenated context for LLM calls
  prompt: string | null;      // Original prompt, null if not provided
  inputFiles: InputFileMeta[];
}
interface InputFileMeta {
  originalName: string;       // "my notes.md"
  normalizedName: string;     // "doc-001.md"
  sizeBytes: number;          // Byte length of content (UTF-8)
}
```

Consumed by: ExtractionOrchestrator (context), RunManager (prompt, inputFiles for persistence).

---

## 4. Algorithm

### 4.1 validate(input)

```javascript
function validate(input: InputProcessorInput): void {
  if (!input.prompt && (!input.files || input.files.length === 0)) {
    throw new ValidationError('At least one of prompt or files must be provided');
  }
  if (input.files) {
    for (const file of input.files) {
      const ext = extname(file.name).toLowerCase();
      if (ext !== '.md' && ext !== '.txt') {
        throw new ValidationError(`Unsupported file type: ${ext}. Only .md and .txt are accepted.`);
      }
      if (file.content.length === 0) {
        throw new ValidationError(`File ${file.name} is empty.`);
      }
    }
  }
  if (input.prompt !== undefined && input.prompt.trim().length === 0) {
    throw new ValidationError('Prompt cannot be empty when provided.');
  }
}
```

### 4.2 normalizeFiles(files)

```javascript
function normalizeFiles(files: InputFile[]): { normalized: InputFileMeta[], contents: string[] } {
  const result = files.map((file, index) => {
    const ext = extname(file.name).toLowerCase();
    const paddedIndex = String(index + 1).padStart(3, '0');
    return {
      meta: {
        originalName: file.name,
        normalizedName: `doc-${paddedIndex}${ext}`,
        sizeBytes: Buffer.byteLength(file.content, 'utf-8'),
      },
      content: file.content,
    };
  });
  return {
    normalized: result.map(r => r.meta),
    contents: result.map(r => r.content),
  };
}
```

### 4.3 buildContext(prompt, fileContents)

```javascript
function buildContext(prompt: string | null, fileContents: string[]): string {
  const parts: string[] = [];
  if (prompt) {
    parts.push(prompt);
  }
  for (const content of fileContents) {
    parts.push(content);
  }
  return parts.join('\n\n---\n\n');
}
```

The separator `\n\n---\n\n` ensures clear visual separation between prompt and documents, and between documents. The prompt always comes first (directional framing, per Spec v1.5 §6).

### 4.4 process(input) — main entry point

```javascript
function process(input: InputProcessorInput): InputProcessorOutput {
  validate(input);

  const prompt = input.prompt?.trim() ?? null;
  let inputFiles: InputFileMeta[] = [];
  let fileContents: string[] = [];

  if (input.files && input.files.length > 0) {
    const { normalized, contents } = normalizeFiles(input.files);
    inputFiles = normalized;
    fileContents = contents;
  }

  const context = buildContext(prompt, fileContents);

  return { context, prompt, inputFiles };
}
```

---

## 5. Examples

### 5.1 Prompt only

```javascript
Input:  { prompt: "Variance inter-run des systèmes LLM", files: undefined }
Output: {
  context: "Variance inter-run des systèmes LLM",
  prompt: "Variance inter-run des systèmes LLM",
  inputFiles: []
}
```

### 5.2 Files only

```javascript
Input:  { prompt: undefined, files: [
  { name: "vision.md", content: "# Research Vision\nContent..." },
  { name: "notes.txt", content: "Additional notes..." }
]}
Output: {
  context: "# Research Vision\nContent...\n\n---\n\n Additional notes...",
  prompt: null,
  inputFiles: [
    { originalName: "vision.md", normalizedName: "doc-001.md", sizeBytes: 28 },
    { originalName: "notes.txt", normalizedName: "doc-002.txt", sizeBytes: 21 }
  ]
}
```

### 5.3 Both prompt and files

```javascript
Input:  { prompt: "Focus on architectural constraints", files: [
  { name: "paper.md", content: "Content of paper..." }
]}
Output: {
  context: "Focus on architectural constraints\n\n---\n\nContent of paper...",
  prompt: "Focus on architectural constraints",
  inputFiles: [
    { originalName: "paper.md", normalizedName: "doc-001.md", sizeBytes: 19 }
  ]
}
```

---

## 6. Edge cases

| Case | Expected behavior |
|---|---|
| No prompt, no files | `ValidationError` thrown |
| Empty prompt string `""` | `ValidationError` (empty when provided) |
| Whitespace-only prompt `"  "` | `ValidationError` (empty after trim) |
| File with `.pdf` extension | `ValidationError` (unsupported type) |
| File with empty content | `ValidationError` |
| Prompt with leading/trailing whitespace | Trimmed in output |
| Single file, no prompt | Context = file content only, no separator |
| Files with non-ASCII names | originalName preserved, normalizedName uses doc-NNN pattern |

---

## 7. Constraints

- **Pure function** — no side effects, no filesystem access. File reading is done by the caller (CLI or WebServer). InputProcessor receives content strings.
- **No LLM calls** — this is a mechanical module.
- **Deterministic** — same input always produces same output.

---

## 8. Integration

```typescript
// In pipeline orchestrator:
const { context, inputFiles, prompt } = InputProcessor.process(input);
runManager.persistInputs(prompt, inputFiles, input.files);
// context is passed to ExtractionOrchestrator and all control phases
```
