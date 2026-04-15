---
id: DC-OPENAI-EMBEDDINGS
type: dependency-contract
version: "1.0.0"
dependency_version: "v1"
scope: openai-embeddings-api
status: approved
validates: [src/infra/openai-adapter.ts, src/infra/provider-shared.ts, tests/contracts.test.ts]
consumers: [claude-code]
referenced_by: [NIB-M-FUSION-INTER]
superseded_by: []
---

---

## 0. Identity

- **Component:** OpenAI Embeddings API
- **Version:** v1
- **Source:** `https://api.openai.com/v1/embeddings`
- **Role:** Provides vector embeddings for semantic clustering in FusionInterAngle

---

## 1. Interface

### 1.1 Request

```typescript
// POST https://api.openai.com/v1/embeddings

interface EmbeddingRequest {
  model: string;              // Default: "text-embedding-3-small"
  input: string[];            // Array of texts to embed (batch)
  encoding_format?: 'float';  // Default, returns float arrays
}

// Headers
// Authorization: Bearer {apiKey}  (same key as chat completions)
// Content-Type: application/json
```

### 1.2 Response

```typescript
interface EmbeddingResponse {
  object: 'list';
  data: Array<{
    object: 'embedding';
    index: number;            // Corresponds to position in input array
    embedding: number[];      // Vector (1536 dims for text-embedding-3-small)
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}
```

---

## 2. Behavioral contract

### 2.1 Success path

- Response status 200.
- `response.data` contains one embedding per input text, in the same order (by `index`).
- Each `embedding` is a float array. Dimension depends on model (1536 for `text-embedding-3-small`).

### 2.2 Failure paths

- Same error semantics as OpenAI Chat API (see DC-OPENAI §3).
- Additionally: **400** if `input` array is empty or exceeds batch limit.

---

## 3. Error semantics

Identical to DC-OPENAI §3 (401 = fatal, 429 = retry, 500 = retry, etc.).

---

## 4. Integration patterns

```typescript
class OpenAIEmbeddingAdapter implements EmbeddingAdapter {
  constructor(private config: { apiKey: string; model: string; endpoint?: string }) {}

  async embed(texts: string[]): Promise<number[][]> {
    // Batch in chunks of 100 (API limit)
    const allEmbeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      const response = await fetch(this.endpoint + '/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          input: batch,
          encoding_format: 'float',
        }),
      });
      const data = await response.json();
      // Sort by index to guarantee order
      const sorted = data.data.sort((a, b) => a.index - b.index);
      allEmbeddings.push(...sorted.map(d => d.embedding));
    }
    return allEmbeddings;
  }
}
```

---

## 5. Consumer constraints

- Uses the **same API key** as OpenAI Chat (no separate key).
- **Batch limit:** max 100 texts per request. Batch internally if more.
- **Input text limit:** each text should be under 8191 tokens (for `text-embedding-3-small`). Concept terms are 1-4 words, well within limit.
- Response `data` array may not be in input order — **always sort by `index`**.
- **Retry policy:** same as other provider adapters (3 retries, exponential backoff).

---

## 6. Known limitations

- Embedding dimensions fixed per model. Cannot be changed at request time.
- Embeddings are not normalized by default (cosine similarity still works correctly).
- Cost: ~$0.02 per 1M tokens. For 100-200 concept terms, cost is negligible.
