import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FatalLLMError } from "../src/domain/errors.js";
import type { LLMRequest, LLMResponse, ProviderAdapter } from "../src/domain/ports.js";
import { DEFAULT_RUN_CONFIG, type RunConfig } from "../src/domain/types.js";
import { runPipeline } from "../src/pipeline.js";
import { loadFixture } from "./helpers/fixture-loader.js";
import { createMockEmbedding } from "./helpers/mock-embedding.js";
import { createMockProvider } from "./helpers/mock-provider.js";
import { createPipelineHarness } from "./helpers/pipeline-harness.js";
import { cleanupTempDir, createTempDir } from "./helpers/temp-dir.js";

describe("Pipeline integration", () => {
	let baseDir: string;

	beforeEach(async () => {
		baseDir = await createTempDir();
	});
	afterEach(async () => {
		await cleanupTempDir(baseDir);
	});

	it("T-INT-01: full pipeline with fixture-backed providers", async () => {
		const harness = createPipelineHarness();
		const result = await runPipeline(
			{ prompt: loadFixture("inputs/sample-vision.md") },
			{ ...harness, baseDir },
		);
		expect(result.status).toBe("completed");

		const runDir = join(baseDir, "runs", result.runId);
		const extractionFiles = await readdir(join(runDir, "extraction"));
		expect(extractionFiles).toHaveLength(15);

		expect(existsSync(join(runDir, "diagnostics.json"))).toBe(true);
		expect(existsSync(join(runDir, "events.jsonl"))).toBe(true);

		const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf-8"));
		expect(manifest.status).toBe("completed");

		const merged = JSON.parse(await readFile(join(runDir, "fusion-inter", "merged.json"), "utf-8"));
		expect(merged.concepts.length).toBeGreaterThan(0);
		expect(merged.metadata.models).toEqual(["claude", "gpt", "gemini"]);
		expect(merged.metadata.angles).toHaveLength(5);
		expect(merged.metadata.total_passes).toBe(15);
	});

	it("T-INT-CONFIG: custom config flows to manifest + merged.metadata", async () => {
		const harness = createPipelineHarness();
		const config: RunConfig = {
			...DEFAULT_RUN_CONFIG,
			embedding_threshold: 0.7,
			models: { anthropic: "claude-x", openai: "gpt-x", google: "gemini-x" },
		};
		const result = await runPipeline(
			{ prompt: loadFixture("inputs/sample-vision.md") },
			{ ...harness, baseDir, config },
		);
		expect(result.status).toBe("completed");
		const runDir = join(baseDir, "runs", result.runId);
		const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf-8"));
		expect(manifest.config.embedding_threshold).toBe(0.7);
		expect(manifest.config.models.anthropic).toBe("claude-x");
		const merged = JSON.parse(await readFile(join(runDir, "fusion-inter", "merged.json"), "utf-8"));
		expect(merged.metadata.fusion_similarity_threshold).toBe(0.7);
	});

	it("T-INT-02: fatal error stops pipeline", async () => {
		const throwing: ProviderAdapter = {
			provider: "anthropic",
			async call(_req: LLMRequest): Promise<LLMResponse> {
				throw new FatalLLMError("bad");
			},
		};
		const harness = createPipelineHarness();
		const result = await runPipeline(
			{ prompt: "test" },
			{ ...harness, anthropic: throwing, baseDir },
		);
		expect(result.status).toBe("failed");
	});

	it("T-INT-03: graceful stop via AbortSignal", async () => {
		const controller = new AbortController();
		const makeSlow = (p: "anthropic" | "openai" | "google"): ProviderAdapter => ({
			provider: p,
			async call(): Promise<LLMResponse> {
				await new Promise((r) => setTimeout(r, 50));
				return { content: "[]", provider: p, model: "slow", latencyMs: 50 };
			},
		});
		setTimeout(() => controller.abort(), 30);
		const result = await runPipeline(
			{ prompt: "test" },
			{
				anthropic: makeSlow("anthropic"),
				openai: makeSlow("openai"),
				google: makeSlow("google"),
				embeddings: createMockEmbedding([]),
				baseDir,
				signal: controller.signal,
			},
		);
		expect(result.status).toBe("stopped");
	});

	it.each([
		["anthropic" as const],
		["openai" as const],
		["google" as const],
	])("P-06: fail-closed when %s throws FatalLLMError", async (which) => {
		const throwing: ProviderAdapter = {
			provider: which,
			async call(): Promise<LLMResponse> {
				throw new FatalLLMError("bad");
			},
		};
		const harness = createPipelineHarness();
		const result = await runPipeline(
			{ prompt: "test" },
			{ ...harness, [which]: throwing, baseDir },
		);
		expect(result.status).toBe("failed");
	});
});
