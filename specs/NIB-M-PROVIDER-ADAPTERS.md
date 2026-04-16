---
id: NIB-M-PROVIDER-ADAPTERS
type: nib-module
version: "1.0.0"
scope: key-concepts-extractor/provider-adapters
status: approved
validates: [src/infra/anthropic-adapter.ts, src/infra/openai-adapter.ts, src/infra/google-adapter.ts, src/infra/provider-shared.ts, src/domain/ports.ts, tests/contracts.test.ts]
consumers: [claude-code]
superseded_by: []
---

---

## 1. Purpose

Abstracts the three LLM provider APIs (Anthropic, OpenAI, Google) behind a uniform interface. Handles authentication, request formatting, response parsing, retry with exponential backoff, and timeout. Each adapter transforms a generic `LLMRequest` into the provider-specific wire format and normalizes the response.

---

## 2. Inputs

```typescript
interface LLMRequest {
  systemPrompt: string;
  userPrompt: string;
  provider: ProviderLongId;         // 'anthropic' | 'openai' | 'google'
}

interface ProviderConfig {
  anthropic: { apiKey: string; model: string; endpoint?: string };
  openai: { apiKey: string; model: string; endpoint?: string };
  google: { apiKey: string; model: string; endpoint?: string };
}
```

Provenance: `LLMRequest` is built by ExtractionOrchestrator, QualityController, and RelevanceController using templates from LLM Payloads v0.2. `ProviderConfig` is resolved at startup from external configuration.

---

## 3. Outputs

```typescript
interface LLMResponse {
  content: string;              // Raw response body (expected: valid JSON string)
  provider: ProviderLongId;
  model: string;                // Actual model identifier used
  latencyMs: number;            // Wall-clock time of the successful call
}
```

Consumed by: ExtractionOrchestrator (parses as RawConcept[]), QualityController/RelevanceController (parses as control-specific schemas).

---

## 4. Algorithm

### 4.1 ProviderAdapter interface

```typescript
interface ProviderAdapter {
  readonly provider: ProviderLongId;        // 'anthropic' | 'openai' | 'google'
  call(request: LLMRequest): Promise<LLMResponse>;
}
```

Three concrete implementations: `AnthropicAdapter`, `OpenAIAdapter`, `GoogleAdapter`.

### 4.2 call(request) — common flow (all adapters)

```javascript
async function call(request: LLMRequest): Promise<LLMResponse> {
  const maxRetries = 3;
  const backoffMs = [5000, 15000, 45000];
  const timeoutMs = 600000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(backoffMs[attempt - 1]);
      emitter.emit(retryEvent(request, attempt));
    }

    try {
      const start = Date.now();
      const rawResponse = await withTimeout(
        this.callProvider(request),  // Provider-specific implementation
        timeoutMs
      );
      const latencyMs = Date.now() - start;

      // Validate that response is parseable JSON
      try {
        JSON.parse(rawResponse);
      } catch {
        throw new RetriableError(`Invalid JSON in response from ${request.provider}`);
      }

      return {
        content: rawResponse,
        provider: request.provider,
        model: this.config.model,
        latencyMs,
      };
    } catch (error) {
      if (attempt === maxRetries) {
        throw new FatalLLMError({
          provider: request.provider,
          error: error.message,
          retriesExhausted: true,
        });
      }
      // Retriable: timeout, network error, 429, 5xx, invalid JSON
      // Non-retriable (throw immediately): 401, 403, invalid API key
      if (isNonRetriable(error)) {
        throw new FatalLLMError({
          provider: request.provider,
          error: error.message,
          retriesExhausted: false,
        });
      }
    }
  }
}
```

### 4.3 AnthropicAdapter.callProvider(request)

```javascript
async function callProvider(request: LLMRequest): Promise<string> {
  // POST to /v1/messages
  // Headers: x-api-key, anthropic-version, content-type
  // Body:
  //   model: config.model
  //   max_tokens: 16384
  //   thinking: { type: "enabled", budget_tokens: 10000 }
  //   system: request.systemPrompt
  //   messages: [{ role: "user", content: request.userPrompt }]
  //
  // Extract: response.content → find block with type="text" → return .text
  // (Skip thinking blocks with type="thinking")
}
```

See DC-ANTHROPIC for full interface contract, error semantics, and thinking block handling.

### 4.4 OpenAIAdapter.callProvider(request)

```javascript
async function callProvider(request: LLMRequest): Promise<string> {
  // POST to /v1/chat/completions
  // Headers: Authorization: Bearer {apiKey}, content-type
  // Body:
  //   model: config.model
  //   reasoning_effort: "high"
  //   messages: [
  //     { role: "system", content: request.systemPrompt },
  //     { role: "user", content: request.userPrompt }
  //   ]
  //
  // Extract: response.choices[0].message.content
}
```

See DC-OPENAI for full interface contract and error semantics.

### 4.5 GoogleAdapter.callProvider(request)

```javascript
async function callProvider(request: LLMRequest): Promise<string> {
  // POST to /v1beta/models/{model}:generateContent
  // Headers: x-goog-api-key, content-type
  // Body:
  //   system_instruction: { parts: [{ text: request.systemPrompt }] }
  //   contents: [{ role: "user", parts: [{ text: request.userPrompt }] }]
  //   generationConfig: { thinking_config: { thinking_level: "HIGH" } }
  //
  // Extract: response.candidates[0].content.parts → find part without thought:true → return .text
}
```

See DC-GOOGLE-GEMINI for full interface contract, thinking part handling, and error semantics.

### 4.6 Error classification

```typescript
function isNonRetriable(error: Error): boolean {
  // Non-retriable: authentication errors (401, 403), invalid API key,
  // model not found, account suspended
  // Retriable: timeout, network error, rate limit (429), server error (5xx),
  // invalid JSON response
}
```

---

## 5. Examples

### 5.1 Successful call

```javascript
Input: {
  systemPrompt: "You are a key concept extractor...",
  userPrompt: "SOURCE DOCUMENT: ...",
  provider: 'anthropic'
}
Output: {
  content: '{"concepts": [{"term": "consistency", ...}]}',
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  latencyMs: 8432
}
```

### 5.2 Retry then success

```javascript
Call 1: timeout after 600s → wait 5s
Call 2: 429 rate limit → wait 15s
Call 3: success → return LLMResponse
```

### 5.3 Fatal after exhausted retries

```javascript
Call 1: 500 → wait 5s
Call 2: timeout → wait 15s
Call 3: timeout → wait 45s
Call 4: 500 → throw FatalLLMError({ provider: 'google', error: '500 Internal Server Error', retriesExhausted: true })
```

---

## 6. Edge cases

| Case | Expected behavior |
|---|---|
| 401 Unauthorized | Immediate FatalLLMError (non-retriable), retriesExhausted: false |
| Response is valid HTTP but not valid JSON | RetriableError, retry up to 3 times |
| Response is valid JSON but wrong schema | Not this module's concern — caller validates schema |
| Timeout at exactly 600s | Treated as timeout, retriable |
| Empty response body | Treated as invalid JSON, retriable |
| Network error (DNS, connection refused) | Retriable |
| Provider returns thinking blocks mixed with content | Extract text blocks only (see DC for each provider) |

---

## 7. Constraints

- **No schema validation** — this module ensures the response is valid JSON. Schema validation (RawConcept[], QualityReport, etc.) is the caller's responsibility.
- **No prompt construction** — this module receives complete system/user prompts. Prompt building is the caller's responsibility using LLM Payloads v0.2.
- **Stateless** — no request history, no caching. Each call is independent.
- **Event emission** — emits retry events only. Start/complete events are emitted by the caller (ExtractionOrchestrator, controllers).

---

## 8. Integration

```typescript
// At startup:
const adapters: Record<ProviderLongId, ProviderAdapter> = {
  anthropic: new AnthropicAdapter(config.anthropic, emitter),
  openai: new OpenAIAdapter(config.openai, emitter),
  google: new GoogleAdapter(config.google, emitter),
};

// In ExtractionOrchestrator:
const response = await adapters[provider.id].call(request);
const concepts = parseAndValidate<RawConcept[]>(response.content);
```
