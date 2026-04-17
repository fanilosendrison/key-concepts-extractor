import type { LLMRequest, LLMResponse, ProviderAdapter } from "../domain/ports.js";
import {
	checkFinishReason,
	classifyHttp,
	composeSignal,
	type ProviderAdapterConfig,
	resolveEndpoint,
	runWithRetry,
} from "./provider-shared.js";

interface OpenAIResponse {
	choices: Array<{
		message: { content: string };
		finish_reason: string;
	}>;
}

export function createOpenAIAdapter(config: ProviderAdapterConfig): ProviderAdapter {
	const endpoint = resolveEndpoint("openai", config.endpoint);

	return {
		provider: "openai",
		async call(request: LLMRequest): Promise<LLMResponse> {
			const { content, latencyMs } = await runWithRetry(
				"openai",
				async () => {
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
						signal: composeSignal(request.signal),
					});
					if (!res.ok) {
						throw classifyHttp(res.status, await res.text());
					}
					const data = (await res.json()) as OpenAIResponse;
					const choice = data.choices[0];
					if (!choice) throw new Error("No choice in OpenAI response");
					// DC-OPENAI §5: truncation retriable, content_filter fatal.
					checkFinishReason("openai", choice.finish_reason, {
						truncation: "length",
						safety: "content_filter",
					});
					return choice.message.content;
				},
				{ signal: request.signal },
			);
			return {
				content,
				provider: "openai",
				model: config.model,
				latencyMs,
			};
		},
	};
}
