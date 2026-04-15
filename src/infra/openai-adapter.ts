import { FatalLLMError, TransientLLMError } from "../domain/errors.js";
import type { LLMRequest, LLMResponse, ProviderAdapter } from "../domain/ports.js";
import {
	classifyHttp,
	type ProviderAdapterConfig,
	runWithRetry,
	TIMEOUT_MS,
} from "./provider-shared.js";

const DEFAULT_ENDPOINT = "https://api.openai.com";

interface OpenAIResponse {
	choices: Array<{
		message: { content: string };
		finish_reason: string;
	}>;
}

export function createOpenAIAdapter(config: ProviderAdapterConfig): ProviderAdapter {
	const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;

	return {
		provider: "openai",
		async call(request: LLMRequest): Promise<LLMResponse> {
			const { content, latencyMs } = await runWithRetry("openai", async () => {
				const res = await fetch(`${endpoint}/v1/chat/completions`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${config.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: config.model,
						reasoning_effort: "high",
						messages: [
							{ role: "system", content: request.systemPrompt },
							{ role: "user", content: request.userPrompt },
						],
					}),
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
				if (!res.ok) {
					throw classifyHttp(res.status, await res.text());
				}
				const data = (await res.json()) as OpenAIResponse;
				const choice = data.choices[0];
				if (!choice) throw new Error("No choice in OpenAI response");
				// DC-OPENAI §5: truncated output is retriable
				if (choice.finish_reason === "length") {
					throw new TransientLLMError("OpenAI output truncated (finish_reason=length)");
				}
				if (choice.finish_reason === "content_filter") {
					throw new FatalLLMError("OpenAI refused content (finish_reason=content_filter)");
				}
				return choice.message.content;
			});
			return {
				content,
				provider: "openai",
				model: config.model,
				latencyMs,
			};
		},
	};
}
