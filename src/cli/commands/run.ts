// NIB-M-CLI §2.1 — `kce run --prompt "..." --files <path> ...`

import { join } from "node:path";
import type { PipelineEvent } from "../../domain/types.js";
import { createAnthropicAdapter } from "../../infra/anthropic-adapter.js";
import type { ResolvedStartupConfig } from "../../infra/config-loader.js";
import { createEventLogger } from "../../infra/event-logger.js";
import { createGoogleAdapter } from "../../infra/google-adapter.js";
import { loadInputFiles } from "../../infra/load-input-files.js";
import { createOpenAIAdapter } from "../../infra/openai-adapter.js";
import { createOpenAIEmbeddingAdapter } from "../../infra/openai-embedding-adapter.js";
import { acquireRunLock } from "../../infra/run-lock.js";
import { createRunManager } from "../../infra/run-manager.js";
import { runPipeline } from "../../pipeline.js";

export interface RunCommandArgs {
	prompt?: string;
	files?: string[];
}

// NIB-M-CLI §3.3 + §5 : one line per event, horodated, structured stdout.
function formatEvent(event: PipelineEvent): string {
	const time = event.timestamp.slice(11, 23);
	return `[${time}] ${event.phase} — ${event.type} ${JSON.stringify(event.payload)}`;
}

export async function runCommand(
	args: RunCommandArgs,
	startup: ResolvedStartupConfig,
): Promise<number> {
	if (!args.prompt && (!args.files || args.files.length === 0)) {
		console.error("kce run requires --prompt or --files");
		return 1;
	}

	const lock = await acquireRunLock(startup.baseDir);
	const ctrl = new AbortController();
	const onSigint = () => ctrl.abort();
	process.on("SIGINT", onSigint);

	// Pre-create RunManager so we know runDir before runPipeline starts, and can
	// subscribe to live events for stdout streaming (NIB-M-CLI §2.1).
	const runManager = createRunManager(join(startup.baseDir, "runs"));
	const logger = createEventLogger(runManager.runDir);
	const unsubscribe = logger.subscribe((event) => {
		console.log(formatEvent(event));
	});
	console.log(`Run ${runManager.runId} — started`);

	try {
		const files = args.files ? await loadInputFiles(args.files) : [];
		const { runConfig, secrets, baseDir } = startup;
		const pipelineInput: { prompt?: string; files?: typeof files } = { files };
		if (args.prompt !== undefined) pipelineInput.prompt = args.prompt;
		const result = await runPipeline(pipelineInput, {
			anthropic: createAnthropicAdapter({
				apiKey: secrets.anthropicApiKey,
				model: runConfig.models.anthropic,
			}),
			openai: createOpenAIAdapter({
				apiKey: secrets.openaiApiKey,
				model: runConfig.models.openai,
			}),
			google: createGoogleAdapter({
				apiKey: secrets.googleApiKey,
				model: runConfig.models.google,
			}),
			embeddings: createOpenAIEmbeddingAdapter({
				apiKey: secrets.openaiApiKey,
				model: runConfig.embedding_model,
			}),
			baseDir,
			runManager,
			config: runConfig,
			signal: ctrl.signal,
			source: "cli",
		});
		console.log(`Run ${result.runId} — ${result.status}`);
		// NIB-M-CLI §2.1: 0=success, 130=user interruption (Ctrl+C), 1=fatal.
		if (result.status === "completed") return 0;
		if (result.status === "stopped") return 130;
		return 1;
	} finally {
		unsubscribe();
		process.off("SIGINT", onSigint);
		await lock.release();
	}
}
