import { pino } from "pino";

// Process-wide structured logger. Tests may override via env var (LOG_LEVEL=silent).
export const logger = pino({
	level: process.env.LOG_LEVEL ?? "info",
});
