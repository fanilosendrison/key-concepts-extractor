// NIB-M-CLI §2.2 — `kce history` lists past runs (anti-chronological).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listRuns } from "../../infra/run-manager.js";

// NIB-M-CLI §2.2: prompt_preview = first 60 chars of prompt, or filenames if no prompt.
async function buildPromptPreview(
	runsDir: string,
	runId: string,
	inputFiles: string[],
): Promise<string> {
	try {
		const prompt = await readFile(join(runsDir, runId, "inputs", "prompt.txt"), "utf-8");
		const trimmed = prompt.trim();
		if (trimmed.length > 0) return trimmed.slice(0, 60);
	} catch {
		// No prompt file — fall through to filenames.
	}
	return inputFiles.length > 0 ? inputFiles.join(",").slice(0, 60) : "(no inputs)";
}

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
		const preview = await buildPromptPreview(runsDir, m.run_id, m.input_files);
		console.log(`${m.run_id}  ${date}  ${m.status}  ${concepts}  ${preview}`);
	}
	return 0;
}
