import { describe, expect, it } from "vitest";
import { runExtraction } from "../src/domain/extraction-orchestrator.js";
import { TransientLLMError } from "../src/domain/errors.js";
import type { LLMRequest, LLMResponse, ProviderAdapter } from "../src/domain/ports.js";
import type { ProviderLongId } from "../src/domain/types.js";

// Minimal adapter that always returns the same canned JSON. Used to simulate
// LLM responses with valid / invalid concept entries — the rest of the
// pipeline isn't exercised here.
function adapterReturning(provider: ProviderLongId, json: string): ProviderAdapter {
	return {
		provider,
		async call(_req: LLMRequest): Promise<LLMResponse> {
			return { content: json, provider, model: "stub", latencyMs: 1 };
		},
	};
}

const VALID_CONCEPT = JSON.stringify({
	concepts: [
		{
			term: "alpha",
			category: "property",
			granularity: "system-level",
			explicit_in_source: true,
			justification: "test",
		},
	],
});

describe("extraction-orchestrator parser validation", () => {
	it("T-EO-CAT: rejects category outside NIB-S-KCE §3.14 closed set", async () => {
		const bad = JSON.stringify({
			concepts: [
				{
					term: "alpha",
					category: "weird-category",
					granularity: "system-level",
					explicit_in_source: true,
					justification: "test",
				},
			],
		});
		const adapters = {
			anthropic: adapterReturning("anthropic", bad),
			openai: adapterReturning("openai", VALID_CONCEPT),
			google: adapterReturning("google", VALID_CONCEPT),
		};
		await expect(runExtraction("ctx", { adapters })).rejects.toBeInstanceOf(TransientLLMError);
	});

	it("T-EO-GRAN: rejects granularity outside NIB-S-KCE §3.14 closed set", async () => {
		const bad = JSON.stringify({
			concepts: [
				{
					term: "alpha",
					category: "property",
					granularity: "ultra-fine",
					explicit_in_source: true,
					justification: "test",
				},
			],
		});
		const adapters = {
			anthropic: adapterReturning("anthropic", bad),
			openai: adapterReturning("openai", VALID_CONCEPT),
			google: adapterReturning("google", VALID_CONCEPT),
		};
		await expect(runExtraction("ctx", { adapters })).rejects.toBeInstanceOf(TransientLLMError);
	});
});
