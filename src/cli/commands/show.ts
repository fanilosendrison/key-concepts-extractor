// NIB-M-CLI §2.3 — `kce show <run_id>` prints run details + event log.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunManifest } from "../../domain/types.js";

export async function showCommand(runId: string, baseDir: string): Promise<number> {
	const runDir = join(baseDir, "runs", runId);
	const manifestPath = join(runDir, "manifest.json");
	if (!existsSync(manifestPath)) {
		console.error(`Run not found: ${runId}`);
		return 1;
	}
	const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as RunManifest;
	console.log(`Run ${manifest.run_id}  [${manifest.status}]  ${manifest.created_at}`);
	if (manifest.results) {
		console.log(
			`Total: ${manifest.results.total_concepts}  Fragile: ${manifest.results.fragile_concepts}  Unanimous: ${manifest.results.unanimous_concepts}`,
		);
	}
	const eventsPath = join(runDir, "events.jsonl");
	if (existsSync(eventsPath)) {
		const raw = await readFile(eventsPath, "utf-8");
		for (const line of raw.split("\n").filter(Boolean)) {
			const ev = JSON.parse(line) as { timestamp: string; type: string };
			console.log(`[${ev.timestamp.slice(11, 23)}] ${ev.type}`);
		}
	} else {
		console.log("(no events.jsonl)");
	}
	return 0;
}
