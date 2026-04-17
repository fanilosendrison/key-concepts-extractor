import type { DestinationStream } from "pino";
import { pino, destination as pinoDestination } from "pino";

// Process-wide structured logger for diagnostic output. Writes synchronously
// to stderr (fd 2) so CLI event streaming on stdout (NIB-M-CLI §3.3) stays
// line-clean AND so the diagnostic line is flushed before process.exit —
// the emitTerminal fallback path (pipeline.ts) can only fire immediately
// before the CLI exits with a non-zero code, so an async SonicBoom would
// drop the line at the exact moment we need it. sync:true is the right
// tradeoff at our low log volume. Tests may override the level via
// LOG_LEVEL=silent.
//
// `createLogger` exposes the same construction with an injectable destination
// for tests that need to capture pino output (e.g. assert on a warn body).
// The default `logger` export stays the production singleton.
//
// The `dest` parameter is typed as `DestinationStream` — deliberately NARROWER
// than pino's real second-arg overload (which also accepts file-path strings
// via SonicBoom). Stream-only prevents a caller from accidentally redirecting
// production logs to an arbitrary filesystem path by passing a string.
export function createLogger(dest?: DestinationStream) {
	return pino(
		{
			level: process.env.LOG_LEVEL ?? "info",
		},
		dest ?? pinoDestination({ dest: 2, sync: true }),
	);
}

export const logger = createLogger();
