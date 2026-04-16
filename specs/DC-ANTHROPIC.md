---
id: DC-ANTHROPIC
type: dependency-contract
version: "1.0.0"
dependency_version: "2023-06-01 (API version header)"
scope: anthropic-api
status: approved
validates: [src/infra/anthropic-adapter.ts, src/infra/provider-shared.ts, tests/contracts.test.ts]
consumers: [claude-code]
referenced_by: [NIB-M-PROVIDER-ADAPTERS]
superseded_by: []
---

---

## 0. Identity

- **Component:** Anthropic Messages API
- **Version:** API version `2023-06-01` (set via `anthropic-version` header)
- **Source:** `https://api.anthropic.com/v1/messages`
- **Role:** Provider adapter for Claude (extraction + quality/relevance control rounds 1 & 3)

---

## 1. Interface

### 1.1 Request

```typescript
// POST https://api.anthropic.com/v1/messages
// (or custom endpoint from config)

interface AnthropicRequest {
  model: string;                    // e.g. "claude-opus-4-6"
  max_tokens: number;               // 16384
  thinking: {
    type: 'enabled';
    budget_tokens: number;          // 10000
  };
  system: string;                   // System prompt
  messages: Array<{
    role: 'user';
    content: string;                // User prompt
  }>;
}

// Headers
// x-api-key: {apiKey}
// anthropic-version: 2023-06-01
// content-type: application/json
```

### 1.2 Response

```typescript
interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<
    | { type: 'thinking'; thinking: string }    // Thinking block (SKIP)
    | { type: 'text'; text: string }            // Content block (EXTRACT)
  >;
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence';
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}
```

---

## 2. Behavioral contract

### 2.1 Success path

- Response status 200.
- `response.content` contains one or more blocks.
- **Extract the `text` field from the first block with `type: 'text'`.** Skip all `type: 'thinking'` blocks.
- The extracted text should be valid JSON (per our system prompt instructions).

### 2.2 Failure paths

- **401 Unauthorized** — invalid API key. Non-retriable.
- **403 Forbidden** — account suspended or permission denied. Non-retriable.
- **429 Too Many Requests** — rate limit. Retriable. `retry-after` header may be present.
- **500 Internal Server Error** — Anthropic server error. Retriable.
- **529 Overloaded** — API overloaded. Retriable.
- **Network timeout** — no response within 120s. Retriable.

---

## 3. Error semantics

| HTTP Status | Error type | Retriable | Action |
|---|---|---|---|
| 401 | `authentication_error` | No | Fatal: invalid API key |
| 403 | `permission_error` | No | Fatal: account issue |
| 429 | `rate_limit_error` | Yes | Backoff + retry |
| 500 | `api_error` | Yes | Backoff + retry |
| 529 | `overloaded_error` | Yes | Backoff + retry |
| Timeout | N/A | Yes | Backoff + retry |

Error response body shape:

```typescript
interface AnthropicError {
  type: 'error';
  error: { type: string; message: string };
}
```

---

## 4. Integration patterns

```typescript
const response = await fetch(endpoint + '/v1/messages', {
  method: 'POST',
  headers: {
    'x-api-key': config.apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model: config.model,
    max_tokens: 16384,
    thinking: { type: 'enabled', budget_tokens: 10000 },
    system: request.systemPrompt,
    messages: [{ role: 'user', content: request.userPrompt }],
  }),
  signal: AbortSignal.timeout(300000),
});

if (!response.ok) {
  const error = await response.json();
  throw categorizeError(response.status, error);
}

const data = await response.json();
const textBlock = data.content.find(block => block.type === 'text');
if (!textBlock) throw new Error('No text block in Anthropic response');
return textBlock.text;
```

---

## 5. Consumer constraints

- `anthropic-version` header is **required**.
- `thinking.type` must be `'enabled'` and `budget_tokens` must be positive (policy P1: reasoning always "high").
- `max_tokens` does not include thinking tokens — it caps only the visible output.
- `system` must be a string (not an array of content blocks).
- The response may contain **multiple text blocks** — use the **first** one.

---

## 6. Known limitations

- Extended thinking increases latency significantly (10-30s+ depending on complexity).
- `budget_tokens` is a soft cap — actual thinking may be shorter.
- If `stop_reason` is `max_tokens`, the JSON output may be truncated. Treat as retriable error.
