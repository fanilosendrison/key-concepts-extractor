import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineEvent } from "../domain/types.js";

export type EventListener = (event: PipelineEvent) => void;

export interface EventLogger {
	emit(event: Omit<PipelineEvent, "timestamp">): Promise<void>;
	getEvents(): Promise<PipelineEvent[]>;
	// NIB-M-EVENT-LOGGER §3.1 + NIB-M-WEB-SERVER §2.2 : live event forwarding to WS clients.
	subscribe(listener: EventListener): () => void;
}

// Shared in-memory registry of live subscribers, keyed by run directory, so any
// EventLogger instance created for the same run (pipeline side + WS side) sees the
// same subscriber set.
const subscribersByRunDir = new Map<string, Set<EventListener>>();

export function createEventLogger(runDir: string): EventLogger {
	const filePath = join(runDir, "events.jsonl");
	// Serialize appends so concurrent fire-and-forget emit() calls (see pipeline.ts)
	// cannot interleave bytes on disk. Each emit queues its append on writeChain;
	// the chain itself recovers from rejections so one failure doesn't poison
	// subsequent writers, while the original rejection still propagates to the
	// caller that triggered it.
	let writeChain: Promise<void> = Promise.resolve();

	return {
		emit(event) {
			const full: PipelineEvent = {
				timestamp: new Date().toISOString(),
				...event,
			};
			const next = writeChain.then(async () => {
				await appendFile(filePath, `${JSON.stringify(full)}\n`, "utf-8");
				const subs = subscribersByRunDir.get(runDir);
				if (subs) {
					for (const listener of subs) {
						// Isolate listener failures so one broken subscriber can't crash the pipeline.
						try {
							listener(full);
						} catch {
							// Intentionally swallowed; subscribers are advisory (WS forwarding).
						}
					}
				}
			});
			writeChain = next.catch(() => undefined);
			return next;
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
		subscribe(listener) {
			let set = subscribersByRunDir.get(runDir);
			if (!set) {
				set = new Set();
				subscribersByRunDir.set(runDir, set);
			}
			set.add(listener);
			return () => {
				const current = subscribersByRunDir.get(runDir);
				if (!current) return;
				current.delete(listener);
				if (current.size === 0) subscribersByRunDir.delete(runDir);
			};
		},
	};
}
