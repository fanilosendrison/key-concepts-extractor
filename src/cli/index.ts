export interface ParsedCli {
	command: "run" | "history" | "show" | "help";
	options?: {
		prompt?: string;
		files?: string[];
		runId?: string;
	};
	exitCode?: number;
	usage?: string;
}

const USAGE = `usage: kce <command> [options]

Commands:
  run       Launch extraction from a prompt and/or files
            --prompt "<text>"     Research prompt
            --files <path> [...]  Input files (.md or .txt)
  history   List past runs (antéchronologique)
  show <run_id>  Print the run details and event log`;

export function parseCli(argv: string[]): ParsedCli {
	const args = argv.slice(2);
	const command = args[0];

	if (!command) {
		return { command: "help", exitCode: 1, usage: USAGE };
	}

	if (command === "history") {
		return { command: "history" };
	}

	if (command === "show") {
		const runId = args[1];
		if (!runId) {
			return { command: "help", exitCode: 1, usage: USAGE };
		}
		return { command: "show", options: { runId } };
	}

	if (command === "run") {
		const KNOWN_FLAGS = new Set(["--prompt", "--files", "--help"]);
		let prompt: string | undefined;
		const files: string[] = [];
		let i = 1;
		while (i < args.length) {
			const arg = args[i];
			if (arg === "--prompt") {
				const next = args[i + 1];
				if (next === undefined || KNOWN_FLAGS.has(next)) {
					return { command: "help", exitCode: 1, usage: USAGE };
				}
				prompt = next;
				i += 2;
			} else if (arg === "--files") {
				i++;
				while (i < args.length && args[i] !== undefined && !KNOWN_FLAGS.has(args[i] as string)) {
					const p = args[i];
					if (p) files.push(p);
					i++;
				}
			} else {
				i++;
			}
		}
		const options: { prompt?: string; files?: string[] } = {};
		if (prompt !== undefined) options.prompt = prompt;
		if (files.length > 0) options.files = files;
		return { command: "run", options };
	}

	return { command: "help", exitCode: 1, usage: USAGE };
}
