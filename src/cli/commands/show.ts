// NIB-M-CLI §2.3 — `kce show <run_id>` prints run details + event log.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunManifest } from "../../domain/types.js";
import { formatEvent, parseEventLine } from "../format-event.js";

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
			// events.jsonl is appended non-atomically; a partial line from a
			// SIGKILL'd pipeline is a realistic scenario precisely on the runs
			// `show` is most useful for. parseEventLine validates the full
			// envelope via zod — returns null on JSON or schema failure rather
			// than crashing.
			const ev = parseEventLine(line);
			if (ev === null) {
				console.error(`(malformed event skipped: ${line.slice(0, 80)})`);
				continue;
			}
			console.log(formatEvent(ev));
		}
	} else {
		console.log("(no events.jsonl)");
	}
	return 0;
}
