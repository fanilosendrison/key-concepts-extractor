import { FatalLLMError, TransientLLMError } from "../domain/errors.js";
import type { LLMRequest, LLMResponse, ProviderAdapter } from "../domain/ports.js";
import {
	classifyHttp,
	type ProviderAdapterConfig,
	runWithRetry,
	TIMEOUT_MS,
} from "./provider-shared.js";

const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com";

interface GeminiPart {
	text: string;
	thought?: boolean;
}
interface GeminiResponse {
	candidates: Array<{
		content: { parts: GeminiPart[]; role: "model" };
		finishReason: string;
	}>;
}

export function createGoogleAdapter(config: ProviderAdapterConfig): ProviderAdapter {
	const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;

	return {
		provider: "google",
		async call(request: LLMRequest): Promise<LLMResponse> {
			const { content, latencyMs } = await runWithRetry("google", async () => {
				const url = `${endpoint}/v1beta/models/${config.model}:generateContent`;
				const res = await fetch(url, {
					method: "POST",
					headers: {
						"x-goog-api-key": config.apiKey,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						system_instruction: { parts: [{ text: request.systemPrompt }] },
						contents: [{ role: "user", parts: [{ text: request.userPrompt }] }],
						generationConfig: { thinking_config: { thinking_level: "HIGH" } },
					}),
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
				if (!res.ok) {
					throw classifyHttp(res.status, await res.text());
				}
				const data = (await res.json()) as GeminiResponse;
				const candidate = data.candidates[0];
				if (!candidate) throw new Error("No candidate in Gemini response");
				// DC-GOOGLE-GEMINI §5: truncation retriable, safety block fatal
				if (candidate.finishReason === "MAX_TOKENS") {
					throw new TransientLLMError("Gemini output truncated (MAX_TOKENS)");
				}
				if (candidate.finishReason === "SAFETY") {
					throw new FatalLLMError("Gemini blocked content (SAFETY)");
				}
				const contentParts = candidate.content.parts.filter((p) => !p.thought);
				return contentParts.map((p) => p.text).join("");
			});
			return {
				content,
				provider: "google",
				model: config.model,
				latencyMs,
			};
		},
	};
}
