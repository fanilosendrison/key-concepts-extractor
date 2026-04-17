import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RUN_CONFIG } from "../src/domain/types.js";
import { logger } from "../src/infra/logger.js";
import { createRunManager, listRuns } from "../src/infra/run-manager.js";
import { rawConcept } from "./helpers/factories.js";
import { cleanupTempDir, createTempDir } from "./helpers/temp-dir.js";

describe("RunManager", () => {
	let baseDir: string;

	beforeEach(async () => {
		baseDir = await createTempDir();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await cleanupTempDir(baseDir);
	});

	it("T-RM-01: directory structure created", async () => {
		const rm = createRunManager(baseDir);
		await rm.initRun(DEFAULT_RUN_CONFIG, "cli");
		for (const sub of ["inputs", "extraction", "fusion-intra", "fusion-inter"]) {
			expect(existsSync(join(rm.runDir, sub))).toBe(true);
		}
	});

	it("T-RM-02: manifest lifecycle", async () => {
		const rm = createRunManager(baseDir);
		await rm.initRun(DEFAULT_RUN_CONFIG, "cli");
		let manifest = await rm.getManifest();
		expect(manifest.status).toBe("running");

		await rm.finalizeRun({ total_concepts: 10, fragile_concepts: 2, unanimous_concepts: 4 });
		manifest = await rm.getManifest();
		expect(manifest.status).toBe("completed");
		expect(manifest.finished_at).toBeDefined();
		expect(manifest.results).toEqual({
			total_concepts: 10,
			fragile_concepts: 2,
			unanimous_concepts: 4,
		});
	});

	it("T-RM-03: persist extraction pass", async () => {
		const rm = createRunManager(baseDir);
		await rm.initRun(DEFAULT_RUN_CONFIG, "cli");
		const concepts = [rawConcept({ term: "a" })];
		await rm.persistExtractionPass("etats_ideaux", "claude", concepts);
		const file = join(rm.runDir, "extraction", "etats_ideaux-claude.json");
		expect(existsSync(file)).toBe(true);
		const content = JSON.parse(await readFile(file, "utf-8"));
		expect(content).toEqual(concepts);
	});

	it("T-RM-04: listRuns antéchronologique", async () => {
		const r1 = createRunManager(baseDir);
		await r1.initRun(DEFAULT_RUN_CONFIG, "cli");
		await new Promise((r) => setTimeout(r, 10));
		const r2 = createRunManager(baseDir);
		await r2.initRun(DEFAULT_RUN_CONFIG, "cli");
		await new Promise((r) => setTimeout(r, 10));
		const r3 = createRunManager(baseDir);
		await r3.initRun(DEFAULT_RUN_CONFIG, "cli");

		const list = await listRuns(baseDir);
		expect(list).toHaveLength(3);
		expect(list[0]?.run_id).toBe(r3.runId);
		expect(list[2]?.run_id).toBe(r1.runId);
	});

	it("T-RM-05: failRun sets status", async () => {
		const rm = createRunManager(baseDir);
		await rm.initRun(DEFAULT_RUN_CONFIG, "cli");
		await rm.failRun(new Error("boom"));
		const manifest = await rm.getManifest();
		expect(manifest.status).toBe("failed");
		expect(manifest.finished_at).toBeDefined();
	});

	it("T-RM-CONFIG: initRun persists manifest.config from RunConfig", async () => {
		const rm = createRunManager(baseDir);
		const customConfig = {
			...DEFAULT_RUN_CONFIG,
			embedding_threshold: 0.7,
			models: { anthropic: "claude-x", openai: "gpt-x", google: "gemini-x" },
		};
		await rm.initRun(customConfig, "cli");
		const manifest = await rm.getManifest();
		expect(manifest.config).toEqual({
			models: { anthropic: "claude-x", openai: "gpt-x", google: "gemini-x" },
			embedding_model: DEFAULT_RUN_CONFIG.embedding_model,
			levenshtein_threshold: DEFAULT_RUN_CONFIG.levenshtein_threshold,
			embedding_threshold: 0.7,
		});
	});

	it("T-RM-SOURCE: initRun persists source and setInputFiles patches manifest", async () => {
		const rm = createRunManager(baseDir);
		await rm.initRun(DEFAULT_RUN_CONFIG, "web");
		let manifest = await rm.getManifest();
		expect(manifest.source).toBe("web");
		expect(manifest.input_files).toEqual([]);

		await rm.setInputFiles(["a.txt", "b.txt"]);
		manifest = await rm.getManifest();
		expect(manifest.input_files).toEqual(["a.txt", "b.txt"]);
		// Other fields preserved across the patch.
		expect(manifest.source).toBe("web");
		expect(manifest.status).toBe("running");
	});

	it("T-RM-BACKFILL: legacy manifests without source/input_files load with defaults", async () => {
		// Simulate a pre-fix manifest persisted before source/input_files existed.
		const rm = createRunManager(baseDir);
		await rm.initRun(DEFAULT_RUN_CONFIG, "cli");
		const { writeFile } = await import("node:fs/promises");
		const path = await import("node:path");
		const legacy = {
			run_id: rm.runId,
			status: "completed",
			created_at: new Date().toISOString(),
			finished_at: new Date().toISOString(),
			config: DEFAULT_RUN_CONFIG,
		};
		await writeFile(path.join(rm.runDir, "manifest.json"), JSON.stringify(legacy), "utf-8");

		const m = await rm.getManifest();
		expect(m.source).toBe("cli");
		expect(m.input_files).toEqual([]);

		const list = await listRuns(baseDir);
		const found = list.find((r) => r.run_id === rm.runId);
		expect(found?.source).toBe("cli");
		expect(found?.input_files).toEqual([]);
	});

	it("T-RM-DIAG-WARN: persistDiagnostics without prior persistInterAngle writes diagnostics.json and warns", async () => {
		const warnSpy = vi.spyOn(logger, "warn");
		const rm = createRunManager(baseDir);
		await rm.initRun(DEFAULT_RUN_CONFIG, "cli");
		const report = {
			unique_by_angle: {},
			unique_by_model: {},
			unanimous_concepts: 0,
			total_after_inter_angle: 0,
			fragile: 0,
		};
		await rm.persistDiagnostics(report);

		expect(existsSync(join(rm.runDir, "diagnostics.json"))).toBe(true);
		expect(existsSync(join(rm.runDir, "fusion-inter", "merged.json"))).toBe(false);
		const written = JSON.parse(await readFile(join(rm.runDir, "diagnostics.json"), "utf-8"));
		expect(written).toEqual(report);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: rm.runId,
				mergedPath: expect.stringContaining("merged.json"),
			}),
			expect.stringMatching(/merged\.json missing/),
		);
	});

	it("P-05: isolation between runs", async () => {
		const r1 = createRunManager(baseDir);
		const r2 = createRunManager(baseDir);
		expect(r1.runDir).not.toBe(r2.runDir);
	});
});
