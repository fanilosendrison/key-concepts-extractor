import { destination, pino } from "pino";

// Process-wide structured logger for diagnostic output. Writes synchronously
// to stderr (fd 2) so CLI event streaming on stdout (NIB-M-CLI §3.3) stays
// line-clean AND so the diagnostic line is flushed before process.exit —
// the emitTerminal fallback path (pipeline.ts) can only fire immediately
// before the CLI exits with a non-zero code, so an async SonicBoom would
// drop the line at the exact moment we need it. sync:true is the right
// tradeoff at our low log volume. Tests may override the level via
// LOG_LEVEL=silent.
export const logger = pino(
	{
		level: process.env.LOG_LEVEL ?? "info",
	},
	destination({ dest: 2, sync: true }),
);
