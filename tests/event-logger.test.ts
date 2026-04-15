import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventLogger } from "../src/infra/event-logger.js";
import { cleanupTempDir, createTempDir } from "./helpers/temp-dir.js";

describe("EventLogger", () => {
	let runDir: string;

	beforeEach(async () => {
		runDir = await createTempDir();
		await mkdir(runDir, { recursive: true });
	});
	afterEach(async () => {
		await cleanupTempDir(runDir);
	});

	it("T-EL-01: emit writes to file", async () => {
		const logger = createEventLogger(runDir);
		await logger.emit({ phase: "extraction", type: "extraction_start", payload: {} });
		const file = join(runDir, "events.jsonl");
		expect(existsSync(file)).toBe(true);
		const lines = readFileSync(file, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const evt = JSON.parse(lines[0]!);
		expect(evt.timestamp).toBeDefined();
		expect(evt.phase).toBe("extraction");
		expect(evt.type).toBe("extraction_start");
	});

	it("T-EL-02: multiple emits append", async () => {
		const logger = createEventLogger(runDir);
		for (let i = 0; i < 3; i++) {
			await logger.emit({ phase: "extraction", type: "tick", payload: { i } });
		}
		const lines = readFileSync(join(runDir, "events.jsonl"), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(3);
	});

	it("T-EL-03: getEvents returns all", async () => {
		const logger = createEventLogger(runDir);
		for (let i = 0; i < 5; i++) {
			await logger.emit({ phase: "run", type: "tick", payload: { i } });
		}
		const events = await logger.getEvents();
		expect(events).toHaveLength(5);
	});

	it("P-04: append-only", async () => {
		const logger = createEventLogger(runDir);
		for (let i = 0; i < 7; i++) {
			await logger.emit({ phase: "run", type: "tick", payload: {} });
		}
		const events = await logger.getEvents();
		expect(events.length).toBe(7);
	});
});
