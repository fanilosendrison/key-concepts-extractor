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
