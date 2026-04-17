import type { LLMRequest, LLMResponse, ProviderAdapter } from "../domain/ports.js";
import {
	checkFinishReason,
	classifyHttp,
	composeSignal,
	type FinishReasonMapping,
	type ProviderAdapterConfig,
	resolveEndpoint,
	runWithRetry,
} from "./provider-shared.js";

interface GeminiPart {
	text: string;
	thought?: boolean;
}
// DC-GOOGLE-GEMINI §1.2 — finishReason enum. Narrowed to the wire-spec union
// so a typo in the mapping passed to checkFinishReason fails at compile time.
type GeminiFinishReason = "STOP" | "MAX_TOKENS" | "SAFETY" | "OTHER";
interface GeminiResponse {
	candidates: Array<{
		content: { parts: GeminiPart[]; role: "model" };
		finishReason: GeminiFinishReason;
	}>;
}

export function createGoogleAdapter(config: ProviderAdapterConfig): ProviderAdapter {
	const endpoint = resolveEndpoint("google", config.endpoint);

	return {
		provider: "google",
		async call(request: LLMRequest): Promise<LLMResponse> {
			const { content, latencyMs } = await runWithRetry(
				"google",
				async () => {
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
						signal: composeSignal(request.signal),
					});
					if (!res.ok) {
						throw classifyHttp(res.status, await res.text());
					}
					const data = (await res.json()) as GeminiResponse;
					const candidate = data.candidates[0];
					if (!candidate) throw new Error("No candidate in Gemini response");
					// DC-GOOGLE-GEMINI §5: truncation retriable, safety block fatal.
					// `satisfies` with the narrow union catches typos (e.g. "MAX_TOKEN")
					// at compile time without forcing callsites elsewhere to narrow.
					checkFinishReason("google", candidate.finishReason, {
						truncation: "MAX_TOKENS",
						safety: "SAFETY",
					} satisfies FinishReasonMapping<GeminiFinishReason>);
					const contentParts = candidate.content.parts.filter((p) => !p.thought);
					return contentParts.map((p) => p.text).join("");
				},
				{ signal: request.signal },
			);
			return {
				content,
				provider: "google",
				model: config.model,
				latencyMs,
			};
		},
	};
}
