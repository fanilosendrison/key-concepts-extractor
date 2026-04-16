// NIB-M-CLI §2.2 — `kce history` lists past runs (anti-chronological).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../infra/logger.js";
import { listRuns } from "../../infra/run-manager.js";

// Grapheme-aware truncation. String.prototype.slice operates on UTF-16 code
// units, which splits surrogate pairs (emoji) and base+combining-mark
// sequences mid-codepoint, yielding U+FFFD at the render boundary. Segment
// into graphemes and rejoin up to the limit so the preview stays legible.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function truncateGraphemes(s: string, max: number): string {
	let out = "";
	let count = 0;
	for (const { segment } of graphemeSegmenter.segment(s)) {
		if (count >= max) break;
		out += segment;
		count += 1;
	}
	return out;
}

// NIB-M-CLI §2.2: prompt_preview = first 60 chars of prompt, or filenames if no prompt.
async function buildPromptPreview(
	runsDir: string,
	runId: string,
	inputFiles: string[],
): Promise<string> {
	try {
		const prompt = await readFile(join(runsDir, runId, "inputs", "prompt.txt"), "utf-8");
		const trimmed = prompt.trim();
		if (trimmed.length > 0) return truncateGraphemes(trimmed, 60);
	} catch (err) {
		// ENOENT is the expected "no prompt for this run" case → silent fallback.
		// Other errors (EACCES, ELOOP, EMFILE, EISDIR) indicate a real fs issue
		// that should surface — degrading to filename-fallback silently would
		// hide corruption or permission problems.
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			logger.warn({ runId, code, err }, "history: failed to read prompt.txt for preview");
		}
	}
	return inputFiles.length > 0 ? truncateGraphemes(inputFiles.join(","), 60) : "(no inputs)";
}

export async function historyCommand(baseDir: string): Promise<number> {
	const runsDir = join(baseDir, "runs");
	const runs = await listRuns(runsDir);
	if (runs.length === 0) {
		console.log("No runs yet.");
		return 0;
	}
	// Parallel preview reads — each run is one fs.readFile, independent of the
	// others. Sequential loop was O(N) wall time for N runs.
	const previews = await Promise.all(
		runs.map((m) => buildPromptPreview(runsDir, m.run_id, m.input_files)),
	);
	for (let i = 0; i < runs.length; i += 1) {
		const m = runs[i];
		if (!m) continue;
		const date = m.created_at.slice(0, 19).replace("T", " ");
		const concepts = m.results?.total_concepts ?? "-";
		console.log(`${m.run_id}  ${date}  ${m.status}  ${concepts}  ${previews[i]}`);
	}
	return 0;
}
