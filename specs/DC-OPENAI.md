---
id: DC-OPENAI
type: dependency-contract
version: "1.0.0"
dependency_version: "v1 (chat completions)"
scope: openai-chat-api
status: approved
validates: [src/infra/openai-adapter.ts, src/infra/provider-shared.ts, tests/contracts.test.ts]
consumers: [claude-code]
referenced_by: [NIB-M-PROVIDER-ADAPTERS]
superseded_by: []
---

---

## 0. Identity

- **Component:** OpenAI Chat Completions API
- **Version:** v1
- **Source:** `https://api.openai.com/v1/chat/completions`
- **Role:** Provider adapter for GPT (extraction + quality/relevance control round 2)

---

## 1. Interface

### 1.1 Request

```typescript
// POST https://api.openai.com/v1/chat/completions

interface OpenAIRequest {
  model: string;                    // e.g. "gpt-5.4"
  reasoning_effort: 'high';         // Policy P1
  messages: Array<
    | { role: 'system'; content: string }
    | { role: 'user'; content: string }
  >;
}

// Headers
// Authorization: Bearer {apiKey}
// Content-Type: application/json
```

### 1.2 Response

```typescript
interface OpenAIResponse {
  id: string;
  object: 'chat.completion';
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;              // The response text (EXTRACT this)
    };
    finish_reason: 'stop' | 'length' | 'content_filter';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
```

---

## 2. Behavioral contract

### 2.1 Success path

- Response status 200.
- Extract `response.choices[0].message.content`.
- Content should be valid JSON per our system prompt.

### 2.2 Failure paths

- **401** — invalid API key. Non-retriable.
- **403** — permission denied. Non-retriable.
- **429** — rate limit. Retriable. Check `retry-after` header.
- **500 / 502 / 503** — server error. Retriable.
- **Timeout** — retriable.

---

## 3. Error semantics

| HTTP Status | Retriable | Action |
|---|---|---|
| 401 | No | Fatal |
| 403 | No | Fatal |
| 429 | Yes | Backoff |
| 500/502/503 | Yes | Backoff |
| Timeout | Yes | Backoff |

Error body:

```typescript
interface OpenAIError {
  error: { message: string; type: string; code: string | null };
}
```

---

## 4. Integration patterns

```typescript
const response = await fetch(endpoint + '/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: config.model,
    reasoning_effort: 'high',
    messages: [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ],
  }),
  signal: AbortSignal.timeout(300000),
});

const data = await response.json();
return data.choices[0].message.content;
```

---

## 5. Consumer constraints

- `reasoning_effort: 'high'` is required (policy P1). Only works with reasoning-capable models.
- No separate `max_tokens` needed — reasoning models manage output length.
- `finish_reason: 'length'` means output was truncated → treat as retriable error.
- `finish_reason: 'content_filter'` means content was refused → log and treat as fatal for this pass.

---

## 6. Known limitations

- Reasoning models may have higher latency (15-60s+).
- `reasoning_effort` parameter availability depends on model.
