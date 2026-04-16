import type { LLMRequest, LLMResponse, ProviderAdapter } from "../domain/ports.js";
import {
	classifyHttp,
	composeSignal,
	type ProviderAdapterConfig,
	runWithRetry,
} from "./provider-shared.js";

const DEFAULT_ENDPOINT = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

// Claude with extended thinking often wraps JSON in ```json ... ``` fences
// despite explicit "no markdown" system instructions. Strip them defensively.
const FENCE_RE = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/;
function stripJsonFence(text: string): string {
	const m = text.match(FENCE_RE);
	return m?.[1] !== undefined ? m[1] : text;
}

interface AnthropicTextBlock {
	type: "text";
	text: string;
}
interface AnthropicThinkingBlock {
	type: "thinking";
	thinking: string;
}
type AnthropicBlock = AnthropicTextBlock | AnthropicThinkingBlock;

export function createAnthropicAdapter(config: ProviderAdapterConfig): ProviderAdapter {
	const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;

	return {
		provider: "anthropic",
		async call(request: LLMRequest): Promise<LLMResponse> {
			const { content, latencyMs } = await runWithRetry(
				"anthropic",
				async () => {
					const res = await fetch(`${endpoint}/v1/messages`, {
						method: "POST",
						headers: {
							"x-api-key": config.apiKey,
							"anthropic-version": API_VERSION,
							"content-type": "application/json",
						},
						body: JSON.stringify({
							model: config.model,
							max_tokens: 16384,
							thinking: { type: "enabled", budget_tokens: 10000 },
							system: request.systemPrompt,
							messages: [{ role: "user", content: request.userPrompt }],
						}),
						signal: composeSignal(request.signal),
					});
					if (!res.ok) {
						throw classifyHttp(res.status, await res.text());
					}
					const data = (await res.json()) as { content: AnthropicBlock[] };
					const textBlock = data.content.find((b): b is AnthropicTextBlock => b.type === "text");
					if (!textBlock) {
						throw new Error("No text block in Anthropic response");
					}
					return stripJsonFence(textBlock.text);
				},
				request.signal,
			);
			return {
				content,
				provider: "anthropic",
				model: config.model,
				latencyMs,
			};
		},
	};
}
