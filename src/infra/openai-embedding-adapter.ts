import type { EmbeddingAdapter } from "../domain/ports.js";
import {
	classifyHttp,
	composeSignal,
	MAX_TOTAL_DURATION_MS_EMBEDDING,
	runWithRetry,
	TIMEOUT_MS_EMBEDDING,
} from "./provider-shared.js";

const DEFAULT_ENDPOINT = "https://api.openai.com";

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
	return {
		async embed(texts, options) {
			const { content } = await runWithRetry(
				"openai",
				async () => {
					const res = await fetch(`${endpoint}/v1/embeddings`, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${cfg.apiKey}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({ model: cfg.model, input: texts }),
						signal: composeSignal(options?.signal, TIMEOUT_MS_EMBEDDING),
					});
					if (!res.ok) throw classifyHttp(res.status, await res.text());
					return await res.text();
				},
				{
					signal: options?.signal,
					maxTotalDurationMs: MAX_TOTAL_DURATION_MS_EMBEDDING,
				},
			);
			const data = JSON.parse(content) as EmbeddingResponse;
			// DC-OPENAI-EMBEDDINGS: response order matches input order via `index`.
			return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
		},
	};
}
