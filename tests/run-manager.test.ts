import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUN_CONFIG } from "../src/domain/types.js";
import { createRunManager, listRuns } from "../src/infra/run-manager.js";
import { cleanupTempDir, createTempDir } from "./helpers/temp-dir.js";

describe("RunManager", () => {
	let baseDir: string;

	beforeEach(async () => {
		baseDir = await createTempDir();
	});
	afterEach(async () => {
		await cleanupTempDir(baseDir);
	});

	it("T-RM-01: directory structure created", async () => {
		const rm = createRunManager(baseDir);
		await rm.initRun(DEFAULT_RUN_CONFIG);
		for (const sub of ["inputs", "extraction", "fusion-intra", "fusion-inter"]) {
			expect(existsSync(join(rm.runDir, sub))).toBe(true);
		}
	});

	it("T-RM-02: manifest lifecycle", async () => {
		const rm = createRunManager(baseDir);
		await rm.initRun(DEFAULT_RUN_CONFIG);
		let manifest = await rm.getManifest();
		expect(manifest.status).toBe("running");

		await rm.finalizeRun({ total: 10 });
		manifest = await rm.getManifest();
		expect(manifest.status).toBe("completed");
		expect(manifest.finished_at).toBeDefined();
		expect(manifest.results).toEqual({ total: 10 });
	});

	it("T-RM-03: persist extraction pass", async () => {
		const rm = createRunManager(baseDir);
		await rm.initRun(DEFAULT_RUN_CONFIG);
		const concepts = [{ term: "a", category: "property", explicit_in_source: true }];
		await rm.persistExtractionPass("etats_ideaux", "claude", concepts);
		const file = join(rm.runDir, "extraction", "etats_ideaux-claude.json");
		expect(existsSync(file)).toBe(true);
		const content = JSON.parse(await readFile(file, "utf-8"));
		expect(content).toEqual(concepts);
	});

	it("T-RM-04: listRuns antéchronologique", async () => {
		const r1 = createRunManager(baseDir);
		await r1.initRun(DEFAULT_RUN_CONFIG);
		await new Promise((r) => setTimeout(r, 10));
		const r2 = createRunManager(baseDir);
		await r2.initRun(DEFAULT_RUN_CONFIG);
		await new Promise((r) => setTimeout(r, 10));
		const r3 = createRunManager(baseDir);
		await r3.initRun(DEFAULT_RUN_CONFIG);

		const list = await listRuns(baseDir);
		expect(list).toHaveLength(3);
		expect(list[0]?.run_id).toBe(r3.runId);
		expect(list[2]?.run_id).toBe(r1.runId);
	});

	it("T-RM-05: failRun sets status", async () => {
		const rm = createRunManager(baseDir);
		await rm.initRun(DEFAULT_RUN_CONFIG);
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
		await rm.initRun(customConfig);
		const manifest = await rm.getManifest();
		expect(manifest.config).toEqual({
			models: { anthropic: "claude-x", openai: "gpt-x", google: "gemini-x" },
			embedding_model: DEFAULT_RUN_CONFIG.embedding_model,
			levenshtein_threshold: DEFAULT_RUN_CONFIG.levenshtein_threshold,
			embedding_threshold: 0.7,
		});
	});

	it("P-05: isolation between runs", async () => {
		const r1 = createRunManager(baseDir);
		const r2 = createRunManager(baseDir);
		expect(r1.runDir).not.toBe(r2.runDir);
	});
});
