import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_ANGLES, CANONICAL_PROVIDERS } from "../src/domain/types.js";
import { runPipeline } from "../src/pipeline.js";
import { loadFixture } from "./helpers/fixture-loader.js";
import { createPipelineHarness } from "./helpers/pipeline-harness.js";
import { cleanupTempDir, createTempDir } from "./helpers/temp-dir.js";

describe("Contract invariants", () => {
	let baseDir: string;
	let runDir: string;

	beforeEach(async () => {
		baseDir = await createTempDir();
		const harness = createPipelineHarness();
		const result = await runPipeline(
			{ prompt: loadFixture("inputs/sample-vision.md") },
			{ ...harness, baseDir },
		);
		runDir = join(baseDir, "runs", result.runId);
	});
	afterEach(async () => {
		await cleanupTempDir(baseDir);
	});

	it("C-01: all JSON outputs are valid JSON", async () => {
		for (const sub of ["extraction", "fusion-intra", "fusion-inter"]) {
			const files = await readdir(join(runDir, sub));
			for (const f of files) {
				const raw = await readFile(join(runDir, sub, f), "utf-8");
				expect(() => JSON.parse(raw)).not.toThrow();
			}
		}
		const diag = await readFile(join(runDir, "diagnostics.json"), "utf-8");
		expect(() => JSON.parse(diag)).not.toThrow();
	});

	it("C-02: manifest.json has required fields", async () => {
		const m = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf-8"));
		expect(m.run_id).toBeDefined();
		expect(m.status).toBeDefined();
		expect(m.created_at).toBeDefined();
	});

	it("C-03: events.jsonl lines are valid JSON with required fields", async () => {
		const raw = await readFile(join(runDir, "events.jsonl"), "utf-8");
		for (const line of raw.trim().split("\n")) {
			const evt = JSON.parse(line);
			expect(evt.timestamp).toBeDefined();
			expect(evt.phase).toBeDefined();
			expect(evt.type).toBeDefined();
			expect(evt.payload).toBeDefined();
		}
	});

	it("C-04: 15 extraction files when completed", async () => {
		const files = await readdir(join(runDir, "extraction"));
		expect(files).toHaveLength(15);
	});

	it("C-05: diagnostics total_after_inter_angle === merged.json concept count", async () => {
		const diag = JSON.parse(await readFile(join(runDir, "diagnostics.json"), "utf-8"));
		// NIB-S-KCE §3.5 : merged.json is a MergedOutput wrapper, not a bare array.
		const merged = JSON.parse(await readFile(join(runDir, "fusion-inter", "merged.json"), "utf-8"));
		expect(diag.total_after_inter_angle).toBe(merged.concepts.length);
		expect(merged.metadata).toBeDefined();
		expect(merged.diagnostics).toEqual(diag);
	});

	it("C-06: angle IDs canonical in extraction filenames", async () => {
		const files = await readdir(join(runDir, "extraction"));
		for (const f of files) {
			const angle = f.split("-")[0]!;
			expect(CANONICAL_ANGLES as readonly string[]).toContain(angle);
		}
	});

	it("C-07: provider IDs canonical in extraction filenames", async () => {
		const files = await readdir(join(runDir, "extraction"));
		for (const f of files) {
			const provider = f.replace(".json", "").split("-").pop()!;
			expect(CANONICAL_PROVIDERS as readonly string[]).toContain(provider);
		}
	});
});
