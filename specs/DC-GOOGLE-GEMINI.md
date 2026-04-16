---
id: DC-GOOGLE-GEMINI
type: dependency-contract
version: "1.0.0"
dependency_version: "v1beta"
scope: google-gemini-api
status: approved
validates: [src/infra/google-adapter.ts, src/infra/provider-shared.ts, tests/contracts.test.ts]
consumers: [claude-code]
referenced_by: [NIB-M-PROVIDER-ADAPTERS]
superseded_by: []
---

---

## 0. Identity

- **Component:** Google Gemini API (generateContent)
- **Version:** v1beta
- **Source:** `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- **Role:** Provider adapter for Gemini (extraction only — never used in controls)

---

## 1. Interface

### 1.1 Request

```typescript
// POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent

interface GeminiRequest {
  system_instruction: {
    parts: [{ text: string }];       // System prompt
  };
  contents: [{
    role: 'user';
    parts: [{ text: string }];       // User prompt
  }];
  generationConfig: {
    thinking_config: {
      thinking_level: 'HIGH';        // Policy P1
    };
  };
}

// Headers
// x-goog-api-key: {apiKey}
// Content-Type: application/json
```

### 1.2 Response

```typescript
interface GeminiResponse {
  candidates: [{
    content: {
      parts: Array<
        | { text: string; thought?: false }    // Content part (EXTRACT)
        | { text: string; thought: true }       // Thinking part (SKIP)
      >;
      role: 'model';
    };
    finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'OTHER';
  }];
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}
```

---

## 2. Behavioral contract

### 2.1 Success path

- Response status 200.
- `response.candidates[0].content.parts` may contain thinking and content parts.
- **Extract text from parts where `thought` is falsy or absent.** Skip parts with `thought: true`.
- Concatenate if multiple content parts (rare but possible).

### 2.2 Failure paths

- **400** — malformed request. Non-retriable (implementation bug).
- **401/403** — invalid API key. Non-retriable.
- **429** — rate limit. Retriable.
- **500/503** — server error. Retriable.
- **Timeout** — retriable.

---

## 3. Error semantics

| HTTP Status | Retriable | Action |
|---|---|---|
| 400 | No | Fatal (bug) |
| 401/403 | No | Fatal |
| 429 | Yes | Backoff |
| 500/503 | Yes | Backoff |
| Timeout | Yes | Backoff |

Error body:

```typescript
interface GeminiError {
  error: { code: number; message: string; status: string };
}
```

---

## 4. Integration patterns

```typescript
const url = `${endpoint}/v1beta/models/${config.model}:generateContent`;
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'x-goog-api-key': config.apiKey,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    system_instruction: { parts: [{ text: request.systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: request.userPrompt }] }],
    generationConfig: { thinking_config: { thinking_level: 'HIGH' } },
  }),
  signal: AbortSignal.timeout(600000),
});

const data = await response.json();
const contentParts = data.candidates[0].content.parts.filter(p => !p.thought);
return contentParts.map(p => p.text).join('');
```

---

## 5. Consumer constraints

- Model name goes in the URL path, not the request body.
- `thinking_config` requires a model that supports thinking (Gemini 2.5+).
- `system_instruction` is separate from `contents` (not a message role).
- `finishReason: 'MAX_TOKENS'` → truncated output → retriable error.
- `finishReason: 'SAFETY'` → content blocked → log and treat as fatal for this pass.

---

## 6. Known limitations

- Thinking increases latency significantly.
- v1beta API may change. Pin to known-working model versions.
- Some models don't support `thinking_config` — will return 400.
