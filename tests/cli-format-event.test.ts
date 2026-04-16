import { describe, expect, it } from "vitest";
import { formatEvent } from "../src/cli/format-event.js";
import type { PipelineEvent } from "../src/domain/types.js";

describe("formatEvent (NIB-M-CLI §3.3)", () => {
	const baseTimestamp = "2026-04-17T14:47:11.000Z"; // slices to "14:47:11.000"

	it("T-FE-01: run_complete renders the '✅ Complete — N concepts — /path' shape", () => {
		const event: PipelineEvent = {
			timestamp: baseTimestamp,
			phase: "run",
			type: "run_complete",
			payload: { total_concepts: 42, run_dir: "/home/u/.kce/runs/20260417-144711-abcd" },
		};
		expect(formatEvent(event)).toBe(
			"[14:47:11.000] ✅ Complete — 42 concepts — /home/u/.kce/runs/20260417-144711-abcd",
		);
	});

	it("T-FE-02: run_error renders '❌ Fatal — <msg>' regardless of payload.fatal", () => {
		// §3.3 prescribes a single wording for run_error. We don't invent an
		// "Error" variant on the payload's `fatal` boolean — the pipeline only
		// emits run_error on fatal conditions anyway.
		const fatal: PipelineEvent = {
			timestamp: baseTimestamp,
			phase: "run",
			type: "run_error",
			payload: { error: "Anthropic API key invalid", fatal: true },
		};
		expect(formatEvent(fatal)).toBe("[14:47:11.000] ❌ Fatal — Anthropic API key invalid");
		const notFatal: PipelineEvent = {
			timestamp: baseTimestamp,
			phase: "run",
			type: "run_error",
			payload: { error: "transient glitch", fatal: false },
		};
		expect(formatEvent(notFatal)).toBe("[14:47:11.000] ❌ Fatal — transient glitch");
	});

	it("T-FE-03: run_stopped renders '🛑 Stopped — <reason>'", () => {
		const event: PipelineEvent = {
			timestamp: baseTimestamp,
			phase: "run",
			type: "run_stopped",
			payload: { reason: "user_requested" },
		};
		expect(formatEvent(event)).toBe("[14:47:11.000] 🛑 Stopped — user_requested");
	});

	it("T-FE-04: non-terminal events keep the generic observability form", () => {
		const event: PipelineEvent = {
			timestamp: baseTimestamp,
			phase: "extraction",
			type: "extraction_progress",
			payload: { done: 7, total: 15 },
		};
		expect(formatEvent(event)).toBe(
			'[14:47:11.000] extraction — extraction_progress {"done":7,"total":15}',
		);
	});
});
