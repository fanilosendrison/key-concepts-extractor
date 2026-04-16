import { FatalLLMError } from "../domain/errors.js";
import type { EmbeddingAdapter } from "../domain/ports.js";
import {
	classifyHttp,
	composeSignal,
	MAX_OPERATION_DURATION_MS_EMBEDDING,
	MAX_TOTAL_DURATION_MS_EMBEDDING,
	runWithRetry,
	TIMEOUT_MS_EMBEDDING,
} from "./provider-shared.js";

const DEFAULT_ENDPOINT = "https://api.openai.com";
// DC-OPENAI-EMBEDDINGS §5: max 100 texts per request, batch internally if more.
const EMBEDDING_BATCH_SIZE = 100;

export interface OpenAIEmbeddingAdapterConfig {
	apiKey: string;
	model: string;
	endpoint?: string;
}

interface EmbeddingResponse {
	data: Array<{ embedding: number[]; index: number }>;
}

export function createOpenAIEmbeddingAdapter(cfg: OpenAIEmbeddingAdapterConfig): EmbeddingAdapter {
	const endpoint = cfg.endpoint ?? DEFAULT_ENDPOINT;

	async function embedBatch(batch: string[], signal?: AbortSignal): Promise<number[][]> {
		const { content } = await runWithRetry(
			"openai",
			async () => {
				const res = await fetch(`${endpoint}/v1/embeddings`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${cfg.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: cfg.model,
						input: batch,
						encoding_format: "float",
					}),
					signal: composeSignal(signal, TIMEOUT_MS_EMBEDDING),
				});
				if (!res.ok) throw classifyHttp(res.status, await res.text());
				return await res.text();
			},
			{
				signal,
				maxTotalDurationMs: MAX_TOTAL_DURATION_MS_EMBEDDING,
			},
		);
		const data = JSON.parse(content) as EmbeddingResponse;
		// DC-OPENAI-EMBEDDINGS §5: response order may not match input — sort by `index`.
		return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
	}

	return {
		async embed(texts, options) {
			// Short-circuit empty input: the API would reject with 400 (§2.2), but
			// [] is the neutral answer our consumer (fusion-inter) expects when no
			// concepts were extracted — no point paying a round-trip to learn that.
			if (texts.length === 0) return [];
			// Sequential, with a cumulative wallclock ceiling across all batches.
			// Per-batch budget still applies; this cap catches a runaway multi-
			// batch call (e.g. thousands of concepts + congestion) without relying
			// solely on the caller's abort signal.
			const all: number[][] = [];
			const startedAt = Date.now();
			for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
				if (i > 0 && Date.now() - startedAt >= MAX_OPERATION_DURATION_MS_EMBEDDING) {
					throw new FatalLLMError(
						`openai-embedding: operation exceeded ${MAX_OPERATION_DURATION_MS_EMBEDDING}ms wallclock after ${i} of ${texts.length} inputs`,
					);
				}
				const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
				const vectors = await embedBatch(batch, options?.signal);
				all.push(...vectors);
			}
			return all;
		},
	};
}
