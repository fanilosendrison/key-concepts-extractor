import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AngleId, ProviderId, RawConcept, RunManifest } from "../domain/types.js";

export interface RunManager {
	readonly runId: string;
	readonly runDir: string;
	initRun(): Promise<void>;
	persistExtractionPass(
		angle: AngleId,
		provider: ProviderId,
		concepts: RawConcept[],
	): Promise<void>;
	persistIntraAngle(angle: AngleId, payload: unknown): Promise<void>;
	persistIntraAngleQuality(angle: AngleId, report: unknown): Promise<void>;
	persistIntraAngleRelevance(angle: AngleId, report: unknown): Promise<void>;
	persistInterAngle(merged: unknown): Promise<void>;
	persistInterAngleQuality(report: unknown): Promise<void>;
	persistInterAngleRelevance(report: unknown): Promise<void>;
	persistDiagnostics(report: unknown): Promise<void>;
	persistPromptFile(prompt: string): Promise<void>;
	persistInputFile(normalizedName: string, content: string): Promise<void>;
	finalizeRun(results: Record<string, unknown>): Promise<void>;
	failRun(error: Error): Promise<void>;
	stopRun(): Promise<void>;
	getManifest(): Promise<RunManifest>;
}

const SUBDIRS = ["inputs", "extraction", "fusion-intra", "fusion-inter"] as const;

function generateRunId(): string {
	const now = new Date();
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	const date =
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const hex = randomBytes(2).toString("hex");
	return `${date}-${hex}`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf-8")) as T;
}

export function createRunManager(baseDir: string, runId?: string): RunManager {
	const id = runId ?? generateRunId();
	const runDir = join(baseDir, id);
	const manifestPath = join(runDir, "manifest.json");

	const updateManifest = async (patch: Partial<RunManifest>): Promise<void> => {
		const current = await readJson<RunManifest>(manifestPath);
		await writeJson(manifestPath, { ...current, ...patch });
	};

	return {
		runId: id,
		runDir,

		async initRun() {
			await mkdir(runDir, { recursive: true });
			for (const sub of SUBDIRS) {
				await mkdir(join(runDir, sub), { recursive: true });
			}
			const manifest: RunManifest = {
				run_id: id,
				status: "running",
				created_at: new Date().toISOString(),
			};
			await writeJson(manifestPath, manifest);
		},

		async persistExtractionPass(angle, provider, concepts) {
			await writeJson(join(runDir, "extraction", `${angle}-${provider}.json`), concepts);
		},

		async persistIntraAngle(angle, payload) {
			await writeJson(join(runDir, "fusion-intra", `${angle}.json`), payload);
		},

		async persistIntraAngleQuality(angle, report) {
			await writeJson(join(runDir, "fusion-intra", `${angle}-quality.json`), report);
		},

		async persistIntraAngleRelevance(angle, report) {
			await writeJson(join(runDir, "fusion-intra", `${angle}-relevance.json`), report);
		},

		async persistInterAngle(merged) {
			await writeJson(join(runDir, "fusion-inter", "merged.json"), merged);
		},

		async persistInterAngleQuality(report) {
			await writeJson(join(runDir, "fusion-inter", "quality.json"), report);
		},

		async persistInterAngleRelevance(report) {
			await writeJson(join(runDir, "fusion-inter", "relevance.json"), report);
		},

		async persistDiagnostics(report) {
			await writeJson(join(runDir, "diagnostics.json"), report);
		},

		async persistPromptFile(prompt) {
			await writeFile(join(runDir, "inputs", "prompt.txt"), prompt, "utf-8");
		},

		async persistInputFile(normalizedName, content) {
			await writeFile(join(runDir, "inputs", normalizedName), content, "utf-8");
		},

		async finalizeRun(results) {
			await updateManifest({
				status: "completed",
				finished_at: new Date().toISOString(),
				results,
			});
		},

		async failRun(error) {
			await updateManifest({
				status: "failed",
				finished_at: new Date().toISOString(),
				error: error.message,
			});
		},

		async stopRun() {
			await updateManifest({
				status: "stopped",
				finished_at: new Date().toISOString(),
			});
		},

		async getManifest() {
			return readJson<RunManifest>(manifestPath);
		},
	};
}

export async function listRuns(baseDir: string): Promise<RunManifest[]> {
	if (!existsSync(baseDir)) return [];
	const entries = await readdir(baseDir, { withFileTypes: true });
	const manifests: RunManifest[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const manifestPath = join(baseDir, entry.name, "manifest.json");
		if (!existsSync(manifestPath)) continue;
		try {
			manifests.push(await readJson<RunManifest>(manifestPath));
		} catch {
			// Skip corrupted manifests — per NIB-M-RUN-MANAGER §5
		}
	}
	manifests.sort((a, b) => b.created_at.localeCompare(a.created_at));
	return manifests;
}
