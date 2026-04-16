// NIB-M-CLI §2.2 — `kce history` lists past runs (anti-chronological).
import { join } from "node:path";
import { listRuns } from "../../infra/run-manager.js";

export async function historyCommand(baseDir: string): Promise<number> {
	const runsDir = join(baseDir, "runs");
	const runs = await listRuns(runsDir);
	if (runs.length === 0) {
		console.log("No runs yet.");
		return 0;
	}
	for (const m of runs) {
		const date = m.created_at.slice(0, 19).replace("T", " ");
		const concepts = m.results?.total_concepts ?? "-";
		const preview = m.input_files.length > 0 ? m.input_files.join(",") : "(no inputs)";
		console.log(`${m.run_id}  ${date}  ${m.status}  ${concepts}  ${preview.slice(0, 60)}`);
	}
	return 0;
}
