// NIB-M-CLI — route a parsed CLI invocation to the matching command handler.
import type { ResolvedStartupConfig } from "../infra/config-loader.js";
import { historyCommand } from "./commands/history.js";
import { runCommand } from "./commands/run.js";
import { showCommand } from "./commands/show.js";
import type { ParsedCli } from "./types.js";

export async function dispatch(parsed: ParsedCli, startup: ResolvedStartupConfig): Promise<number> {
	switch (parsed.command) {
		case "help":
			if (parsed.usage) console.log(parsed.usage);
			return parsed.exitCode ?? 0;
		case "history":
			return historyCommand(startup.baseDir);
		case "show": {
			const runId = parsed.options?.runId;
			if (!runId) return 1;
			return showCommand(runId, startup.baseDir);
		}
		case "run": {
			const args: { prompt?: string; files?: string[] } = {};
			if (parsed.options?.prompt !== undefined) args.prompt = parsed.options.prompt;
			if (parsed.options?.files !== undefined) args.files = parsed.options.files;
			return runCommand(args, startup);
		}
	}
}
