import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineEvent } from "../domain/types.js";

export interface EventLogger {
	emit(event: Omit<PipelineEvent, "timestamp">): Promise<void>;
	getEvents(): Promise<PipelineEvent[]>;
}

export function createEventLogger(runDir: string): EventLogger {
	const filePath = join(runDir, "events.jsonl");

	return {
		async emit(event) {
			const full: PipelineEvent = {
				timestamp: new Date().toISOString(),
				...event,
			};
			await appendFile(filePath, `${JSON.stringify(full)}\n`, "utf-8");
		},
		async getEvents() {
			if (!existsSync(filePath)) return [];
			const content = await readFile(filePath, "utf-8");
			return content
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as PipelineEvent);
		},
	};
}
