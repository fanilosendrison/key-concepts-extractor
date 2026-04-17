import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FatalLLMError } from "../src/domain/errors.js";
import type { LLMRequest, LLMResponse, ProviderAdapter } from "../src/domain/ports.js";
import { DEFAULT_RUN_CONFIG, type PipelineEvent, type RunConfig } from "../src/domain/types.js";
import { createEventLogger } from "../src/infra/event-logger.js";
import { createRunManager } from "../src/infra/run-manager.js";
import { runPipeline } from "../src/pipeline.js";
import { loadFixture } from "./helpers/fixture-loader.js";
import { createMockEmbedding } from "./helpers/mock-embedding.js";
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

	// Terminal events (run_complete/run_error/run_stopped) must reach stdout
	// subscribers before runPipeline resolves — otherwise the CLI exits before
	// the subscriber sees them. Regression guard against the fire-and-forget bug.
	describe("T-INT-TERMINAL: subscriber sees terminal event before runPipeline resolves", () => {
		async function collectTerminal(
			run: () => Promise<{ runId: string }>,
			runDir: string,
		): Promise<PipelineEvent | null> {
			const eventLogger = createEventLogger(runDir);
			let terminal: PipelineEvent | null = null;
			const unsubscribe = eventLogger.subscribe((event: PipelineEvent) => {
				if (event.phase === "run" && terminal === null) {
					terminal = event;
				}
			});
			try {
				await run();
				return terminal;
			} finally {
				unsubscribe();
			}
		}

		it("delivers run_complete on success with NIB-S-KCE §7 payload (total_concepts + output_dir)", async () => {
			const runManager = createRunManager(join(baseDir, "runs"));
			const harness = createPipelineHarness();
			const terminal = await collectTerminal(
				() =>
					runPipeline(
						{ prompt: loadFixture("inputs/sample-vision.md") },
						{ ...harness, baseDir, runManager },
					),
				runManager.runDir,
			);
			// Explicit non-null guard: null would make every subsequent
			// `terminal?.payload.x` throw an opaque TypeError instead of a
			// clear "terminal event never arrived" diagnostic — the exact
			// fire-and-forget regression this suite guards against.
			expect(terminal).not.toBeNull();
			expect(terminal?.type).toBe("run_complete");
			// NIB-S-KCE §7 line 608 : payload carries { total_concepts, output_dir }.
			// Pin both keys AND the shape (non-negative integer, not NaN/∞) so
			// a rename OR a regression turning the field into `undefined + 0`
			// fails this test instead of silently drifting.
			const total = terminal?.payload.total_concepts;
			expect(typeof total).toBe("number");
			expect(Number.isInteger(total)).toBe(true);
			expect(total as number).toBeGreaterThanOrEqual(0);
			expect(terminal?.payload.output_dir).toBe(runManager.runDir);
		});

		it("delivers run_error on fatal failure with { error, fatal } payload", async () => {
			const runManager = createRunManager(join(baseDir, "runs"));
			const throwing: ProviderAdapter = {
				provider: "anthropic",
				async call(): Promise<LLMResponse> {
					throw new FatalLLMError("bad");
				},
			};
			const harness = createPipelineHarness();
			const terminal = await collectTerminal(
				() =>
					runPipeline({ prompt: "test" }, { ...harness, anthropic: throwing, baseDir, runManager }),
				runManager.runDir,
			);
			expect(terminal).not.toBeNull();
			expect(terminal?.type).toBe("run_error");
			// Pin the payload keys consumed by WS/UI (format-event.ts :86-89) and
			// by the `fatal` boolean surfacing. A regression that dropped `fatal`
			// would break downstream telemetry without flagging it here otherwise.
			expect(typeof terminal?.payload.error).toBe("string");
			expect(terminal?.payload.fatal).toBe(true);
		});

		it("delivers run_stopped on abort", async () => {
			const runManager = createRunManager(join(baseDir, "runs"));
			const controller = new AbortController();
			const makeSlow = (p: "anthropic" | "openai" | "google"): ProviderAdapter => ({
				provider: p,
				async call(): Promise<LLMResponse> {
					await new Promise((r) => setTimeout(r, 50));
					return { content: "[]", provider: p, model: "slow", latencyMs: 50 };
				},
			});
			setTimeout(() => controller.abort(), 30);
			const terminal = await collectTerminal(
				() =>
					runPipeline(
						{ prompt: "test" },
						{
							anthropic: makeSlow("anthropic"),
							openai: makeSlow("openai"),
							google: makeSlow("google"),
							embeddings: createMockEmbedding([]),
							baseDir,
							runManager,
							signal: controller.signal,
						},
					),
				runManager.runDir,
			);
			expect(terminal).not.toBeNull();
			expect(terminal?.type).toBe("run_stopped");
			// pipeline.ts:108 emits `{ reason: "user_requested" }` on graceful abort.
			// Lock the reason so a future variant (e.g. "timeout") can be added
			// without silently replacing the existing one.
			expect(terminal?.payload.reason).toBe("user_requested");
		});
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
