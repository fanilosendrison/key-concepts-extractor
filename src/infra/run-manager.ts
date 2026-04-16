import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	AngleId,
	DiagnosticsReport,
	MergedConcept,
	MergedOutput,
	ProviderId,
	QualityReport,
	RawConcept,
	RelevanceReport,
	RunConfig,
	RunManifest,
	RunResults,
	RunSource,
} from "../domain/types.js";
import { logger } from "./logger.js";

export interface RunManager {
	readonly runId: string;
	readonly runDir: string;
	initRun(config: RunConfig, source: RunSource): Promise<void>;
	setInputFiles(normalizedNames: string[]): Promise<void>;
	persistExtractionPass(
		angle: AngleId,
		provider: ProviderId,
		concepts: RawConcept[],
	): Promise<void>;
	persistIntraAngle(angle: AngleId, concepts: MergedConcept[]): Promise<void>;
	persistIntraAngleQuality(angle: AngleId, report: QualityReport): Promise<void>;
	persistIntraAngleRelevance(angle: AngleId, report: RelevanceReport): Promise<void>;
	persistInterAngle(merged: MergedOutput): Promise<void>;
	persistInterAngleQuality(report: QualityReport): Promise<void>;
	persistInterAngleRelevance(report: RelevanceReport): Promise<void>;
	persistDiagnostics(report: DiagnosticsReport): Promise<void>;
	persistPromptFile(prompt: string): Promise<void>;
	persistInputFile(normalizedName: string, content: string): Promise<void>;
	finalizeRun(results: RunResults): Promise<void>;
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
	// Atomic write: a concurrent reader (listRuns, updateManifest) must never
	// see a partial JSON. Write to a unique temp then rename — rename is atomic
	// on POSIX filesystems for paths on the same device. The randomBytes suffix
	// prevents tmp-path collision when two writeJson calls land in the same
	// millisecond (T-WS-04 race: pipeline manifest update vs DELETE stopRun).
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
	try {
		await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
		await rename(tmp, path);
	} catch (err) {
		// On writeFile/rename failure, the tmp file may have been partially
		// created. Clean up so runDir doesn't accumulate .tmp.* orphans across
		// retry loops or crash-recovery flows.
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf-8")) as T;
}

// Backfill defaults for fields added after a manifest was first persisted.
// Old run dirs (pre-source/input_files) should still load cleanly so the
// history view doesn't crash on `undefined.length` or similar accesses.
function backfillManifest(raw: Partial<RunManifest> & { results?: unknown }): RunManifest {
	const filled = { source: "cli", input_files: [], ...raw } as RunManifest;
	// Drop legacy `results` payloads that don't match the strict RunResults
	// shape; the type contract would otherwise lie at runtime.
	if (filled.results !== undefined) {
		const r = filled.results as Partial<RunManifest["results"]>;
		if (
			!r ||
			typeof r.total_concepts !== "number" ||
			typeof r.fragile_concepts !== "number" ||
			typeof r.unanimous_concepts !== "number"
		) {
			delete filled.results;
		}
	}
	return filled;
}

export function createRunManager(baseDir: string, runId?: string): RunManager {
	const id = runId ?? generateRunId();
	const runDir = join(baseDir, id);
	const manifestPath = join(runDir, "manifest.json");

	const updateManifest = async (patch: Partial<RunManifest>): Promise<void> => {
		const current = await readJson<RunManifest>(manifestPath);
		await writeJson(manifestPath, { ...current, ...patch });
	};

	const isTerminal = (status: RunManifest["status"]): boolean =>
		status === "completed" || status === "failed" || status === "stopped";

	return {
		runId: id,
		runDir,

		// Idempotent: safe to call twice on the same runDir. Returns early if a
		// manifest already exists so callers don't have to guard ordering.
		async initRun(config, source) {
			if (existsSync(manifestPath)) return;
			await mkdir(runDir, { recursive: true });
			for (const sub of SUBDIRS) {
				await mkdir(join(runDir, sub), { recursive: true });
			}
			// NIB-M-RUN-MANAGER §4.2 : persist resolved config + source + empty
			// input_files (filled by setInputFiles after persistInputFile loop) so
			// the history view can render runs from manifest.json alone.
			const manifest: RunManifest = {
				run_id: id,
				status: "running",
				created_at: new Date().toISOString(),
				source,
				input_files: [],
				config: { ...config, models: { ...config.models } },
			};
			await writeJson(manifestPath, manifest);
		},

		async setInputFiles(normalizedNames) {
			await updateManifest({ input_files: [...normalizedNames] });
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
			// NIB-S-KCE §3.5 + NIB-M-RUN-MANAGER §4.5c: persist MergedOutput wrapper with
			// metadata; diagnostics is filled in a second pass by persistDiagnostics.
			await writeJson(join(runDir, "fusion-inter", "merged.json"), merged);
		},

		async persistInterAngleQuality(report) {
			await writeJson(join(runDir, "fusion-inter", "quality.json"), report);
		},

		async persistInterAngleRelevance(report) {
			await writeJson(join(runDir, "fusion-inter", "relevance.json"), report);
		},

		async persistDiagnostics(report) {
			// NIB-M-RUN-MANAGER §4.5d: write diagnostics.json, then re-read merged.json and
			// fill the `diagnostics` field of the MergedOutput wrapper.
			await writeJson(join(runDir, "diagnostics.json"), report);
			const mergedPath = join(runDir, "fusion-inter", "merged.json");
			if (existsSync(mergedPath)) {
				const merged = await readJson<MergedOutput>(mergedPath);
				merged.diagnostics = report;
				await writeJson(mergedPath, merged);
			} else {
				// Invariant: persistInterAngle must run before persistDiagnostics. Hitting this
				// branch means the pipeline ordering broke or merged.json was deleted — surface
				// it so the gap doesn't stay silent.
				logger.warn(
					{ runId: id, mergedPath },
					"persistDiagnostics: merged.json missing; diagnostics written to diagnostics.json only",
				);
			}
		},

		async persistPromptFile(prompt) {
			await writeFile(join(runDir, "inputs", "prompt.txt"), prompt, "utf-8");
		},

		async persistInputFile(normalizedName, content) {
			await writeFile(join(runDir, "inputs", normalizedName), content, "utf-8");
		},

		// finalize/fail/stop are idempotent: once a run reaches a terminal status,
		// later calls are no-ops so we never overwrite a `stopped` with a `completed`
		// (e.g. pipeline still writing after DELETE) or double-fail on error paths.
		async finalizeRun(results) {
			const current = await readJson<RunManifest>(manifestPath);
			if (isTerminal(current.status)) return;
			await updateManifest({
				status: "completed",
				finished_at: new Date().toISOString(),
				results,
			});
		},

		async failRun(error) {
			const current = await readJson<RunManifest>(manifestPath);
			if (isTerminal(current.status)) return;
			await updateManifest({
				status: "failed",
				finished_at: new Date().toISOString(),
				error: error.message,
			});
		},

		async stopRun() {
			const current = await readJson<RunManifest>(manifestPath);
			if (isTerminal(current.status)) return;
			await updateManifest({
				status: "stopped",
				finished_at: new Date().toISOString(),
			});
		},

		async getManifest() {
			return backfillManifest(await readJson<Partial<RunManifest>>(manifestPath));
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
			manifests.push(backfillManifest(await readJson<Partial<RunManifest>>(manifestPath)));
		} catch {
			// Skip corrupted manifests — per NIB-M-RUN-MANAGER §5
		}
	}
	manifests.sort((a, b) => b.created_at.localeCompare(a.created_at));
	return manifests;
}
