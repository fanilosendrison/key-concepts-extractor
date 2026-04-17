import { afterEach, describe, expect, it, vi } from "vitest";
import { formatEvent, parseEventLine } from "../src/cli/format-event.js";
import type { PipelineEvent } from "../src/domain/types.js";
import { logger } from "../src/infra/logger.js";

describe("formatEvent (NIB-M-CLI §3.3)", () => {
	const baseTimestamp = "2026-04-17T14:47:11.000Z"; // slices to "14:47:11.000"

	it("T-FE-01: run_complete renders the '✅ Complete — N concepts — /path' shape", () => {
		const event: PipelineEvent = {
			timestamp: baseTimestamp,
			phase: "run",
			type: "run_complete",
			payload: { total_concepts: 42, output_dir: "/home/u/.kce/runs/20260417-144711-abcd" },
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

	it("T-FE-04: extraction_start renders 'Extraction — <angle> / <model> — started' per §3.3", () => {
		const event: PipelineEvent = {
			timestamp: "2026-04-17T14:30:22.451Z",
			phase: "extraction",
			type: "extraction_start",
			payload: { angle: "etats_ideaux", model: "claude" },
		};
		expect(formatEvent(event)).toBe("[14:30:22.451] Extraction — etats_ideaux / claude — started");
	});

	it("T-FE-05: extraction_complete renders 'Extraction — <angle> / <model> — N concepts' per §3.3", () => {
		const event: PipelineEvent = {
			timestamp: "2026-04-17T14:30:30.892Z",
			phase: "extraction",
			type: "extraction_complete",
			payload: {
				angle: "etats_ideaux",
				model: "claude",
				concepts_count: 18,
				concepts_dropped: 0,
			},
		};
		expect(formatEvent(event)).toBe(
			"[14:30:30.892] Extraction — etats_ideaux / claude — 18 concepts",
		);
	});

	it("T-FE-06: extraction_progress renders 'Extraction — N/M passes' per §3.3", () => {
		const event: PipelineEvent = {
			timestamp: "2026-04-17T14:30:30.892Z",
			phase: "extraction",
			type: "extraction_progress",
			payload: { completed: 7, total: 15 },
		};
		expect(formatEvent(event)).toBe("[14:30:30.892] Extraction — 7/15 passes");
	});

	it("T-FE-07: control_start renders 'Quality control — <scope> — R<round> <model>' per §3.3", () => {
		const event: PipelineEvent = {
			timestamp: "2026-04-17T14:31:05.123Z",
			phase: "fusion_intra",
			type: "control_start",
			payload: { control: "quality", round: 1, model: "claude", scope: "angle:etats_ideaux" },
		};
		expect(formatEvent(event)).toBe(
			"[14:31:05.123] Quality control — angle:etats_ideaux — R1 claude",
		);
	});

	it("T-FE-08: control_start with control:relevance renders 'Relevance control — …'", () => {
		const event: PipelineEvent = {
			timestamp: "2026-04-17T14:31:05.123Z",
			phase: "fusion_inter",
			type: "control_start",
			payload: { control: "relevance", round: 2, model: "gpt", scope: "inter_angle" },
		};
		expect(formatEvent(event)).toBe("[14:31:05.123] Relevance control — inter_angle — R2 gpt");
	});

	it("T-FE-09: other events keep the generic observability form", () => {
		const event: PipelineEvent = {
			timestamp: baseTimestamp,
			phase: "input",
			type: "input_processed",
			payload: { files: 2, prompt: "provided" },
		};
		expect(formatEvent(event)).toBe(
			'[14:47:11.000] input — input_processed {"files":2,"prompt":"provided"}',
		);
	});

	it("T-FE-10: malformed payload falls back to the generic form (fail-soft)", () => {
		// zod rejects a missing `output_dir` — the formatter must not crash,
		// it degrades to the generic JSON rendering so the event is still visible.
		const event: PipelineEvent = {
			timestamp: baseTimestamp,
			phase: "run",
			type: "run_complete",
			payload: { total_concepts: 42 },
		};
		expect(formatEvent(event)).toBe('[14:47:11.000] run — run_complete {"total_concepts":42}');
	});

	describe("drift detection via pino warn (fail-soft + signal)", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		// All 7 known event types go through warnAndFallback — lock the
		// uniform behaviour so a future refactor that drops the warn on a
		// single case (e.g. "extraction_progress is too noisy") fails the
		// suite instead of silently regressing the drift signal.
		const knownTypes: ReadonlyArray<{
			type: PipelineEvent["type"];
			phase: PipelineEvent["phase"];
		}> = [
			{ type: "run_complete", phase: "run" },
			{ type: "run_error", phase: "run" },
			{ type: "run_stopped", phase: "run" },
			{ type: "extraction_start", phase: "extraction" },
			{ type: "extraction_complete", phase: "extraction" },
			{ type: "extraction_progress", phase: "extraction" },
			{ type: "control_start", phase: "fusion_intra" },
		];

		it.each(
			knownTypes,
		)("T-FE-11: $type with empty payload triggers pino warn (with event_type + non-empty issues) AND returns generic form", ({
			type,
			phase,
		}) => {
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
			const event: PipelineEvent = {
				timestamp: baseTimestamp,
				phase,
				type,
				payload: {}, // empty — every schema has ≥1 required field
			};
			const out = formatEvent(event);
			expect(out).toBe(`[14:47:11.000] ${phase} — ${type} {}`);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			const [arg0, arg1] = warnSpy.mock.calls[0] ?? [];
			expect(arg0).toMatchObject({ event_type: type });
			// The `issues` array is the load-bearing diagnostic for
			// downstream log consumers — lock its presence and non-emptiness.
			const issues = (arg0 as { issues?: unknown }).issues;
			expect(Array.isArray(issues)).toBe(true);
			expect((issues as unknown[]).length).toBeGreaterThan(0);
			expect(arg1).toMatch(/payload shape did not match schema/);
		});

		it("T-FE-12: unknown event type does NOT warn (no schema to drift from)", () => {
			// The generic fallback is the designed behaviour for unknown types ;
			// they must not produce a spurious drift signal. This locks the
			// known-vs-unknown separation of policies.
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
			const event: PipelineEvent = {
				timestamp: baseTimestamp,
				phase: "input",
				type: "input_processed",
				payload: { files: 2, prompt: "provided" },
			};
			formatEvent(event);
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it("T-FE-13: known event with matching payload does NOT warn", () => {
			// Positive control for T-FE-11 — a well-formed payload must go
			// through the happy path without any diagnostic signal.
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
			const event: PipelineEvent = {
				timestamp: baseTimestamp,
				phase: "run",
				type: "run_complete",
				payload: { total_concepts: 42, output_dir: "/tmp/run" },
			};
			formatEvent(event);
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it("T-FE-14: parseEventLine + formatEvent lock the two-policy contract (envelope-soft, payload-warn)", () => {
			// End-to-end: a replay line with a VALID envelope but BAD payload
			// must parse (parseEventLine stays fail-soft on envelope per comment
			// at format-event.ts:10-15) AND trigger a warn when formatEvent
			// renders it (drift signal for known type). If a refactor quietly
			// moved the warn into parseEventLine — breaking the replay policy —
			// both isolated suites would still pass; this test catches it.
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
			const line = JSON.stringify({
				timestamp: baseTimestamp,
				phase: "run",
				type: "run_complete",
				payload: { total_concepts: 42 }, // missing output_dir
			});
			const parsed = parseEventLine(line);
			expect(parsed).not.toBeNull();
			// parseEventLine must NOT warn — replay stays soft.
			expect(warnSpy).not.toHaveBeenCalled();
			// formatEvent on the parsed event MUST warn — emitter/formatter drift.
			if (parsed) formatEvent(parsed);
			expect(warnSpy).toHaveBeenCalledTimes(1);
		});
	});
});

// parseEventLine is the replay-boundary guard consumed by `kce show` when
// reading events.jsonl — the file may be truncated (SIGKILL), from an
// older schema, or just plain corrupt. Every failure mode must return null
// rather than throw so show.ts can degrade to "(malformed event skipped)".
describe("parseEventLine (NIB-M-CLI §2.3 replay guard)", () => {
	it("T-PEL-01: returns the full envelope on a well-formed JSON line", () => {
		// Assert on every envelope field (not just type) so a refactor that drops
		// timestamp / phase / payload from the parsed shape fails the test.
		const line = JSON.stringify({
			timestamp: "2026-04-17T14:47:11.000Z",
			phase: "run",
			type: "run_complete",
			payload: { total_concepts: 3, output_dir: "/home/u/.kce/runs/x" },
		});
		expect(parseEventLine(line)).toEqual({
			timestamp: "2026-04-17T14:47:11.000Z",
			phase: "run",
			type: "run_complete",
			payload: { total_concepts: 3, output_dir: "/home/u/.kce/runs/x" },
		});
	});

	it("T-PEL-02: returns null on invalid JSON (e.g. partial line from SIGKILL)", () => {
		expect(parseEventLine('{"phase":"run","type":"run_comple')).toBeNull();
	});

	it("T-PEL-03: returns null when an unknown phase value is present (enum mismatch)", () => {
		// Guards against a rogue writer or an out-of-date replay client — the
		// schema enum is the source-of-truth gate.
		const line = JSON.stringify({
			timestamp: "2026-04-17T14:47:11.000Z",
			phase: "unknown_phase",
			type: "run_complete",
			payload: {},
		});
		expect(parseEventLine(line)).toBeNull();
	});

	it("T-PEL-04: returns null when an unknown type value is present (enum mismatch)", () => {
		const line = JSON.stringify({
			timestamp: "2026-04-17T14:47:11.000Z",
			phase: "run",
			type: "total_meltdown",
			payload: {},
		});
		expect(parseEventLine(line)).toBeNull();
	});

	it("T-PEL-05: returns null when envelope fields are missing", () => {
		const line = JSON.stringify({ type: "run_complete", payload: {} });
		expect(parseEventLine(line)).toBeNull();
	});

	// Locks the z.object boundary — a bare string / number / array / null
	// JSON body must not slip through. Previously the cast-based show.ts
	// would have returned garbage from these; parseEventLine must reject.
	// it.each so a failing case points at its literal instead of a shared line.
	it.each([
		['"just a string"'],
		["42"],
		["null"],
		["[]"],
		["true"],
	])("T-PEL-06: returns null for valid JSON that is not a plain object (%s)", (bare) => {
		expect(parseEventLine(bare)).toBeNull();
	});

	// Each envelope field has its own validator (z.string / z.enum / z.record) —
	// cover all four so a regression that swaps any of them for a coerced
	// variant (e.g. z.coerce.string) fails the suite rather than silently
	// coerce. Timestamp cases ALSO lock the Z-only ISO-8601 contract
	// (NIB-M-EVENT-LOGGER §3.1) — a revert of `z.iso.datetime()` to
	// `z.string()` would let the non-ISO rows through and break the suite.
	it.each([
		[
			"phase is not a string",
			{ timestamp: "2026-04-17T14:47:11.000Z", phase: 42, type: "run_complete", payload: {} },
		],
		[
			"type is not a string",
			{ timestamp: "2026-04-17T14:47:11.000Z", phase: "run", type: 42, payload: {} },
		],
		[
			"timestamp is not a string",
			{ timestamp: 123, phase: "run", type: "run_complete", payload: {} },
		],
		[
			"timestamp is an empty string",
			{ timestamp: "", phase: "run", type: "run_complete", payload: {} },
		],
		[
			"timestamp is not ISO-8601",
			{
				timestamp: "2026-04-17 14:47:11",
				phase: "run",
				type: "run_complete",
				payload: {},
			},
		],
		[
			"timestamp is garbage",
			{ timestamp: "not-a-timestamp", phase: "run", type: "run_complete", payload: {} },
		],
		[
			"payload is not an object",
			{
				timestamp: "2026-04-17T14:47:11.000Z",
				phase: "run",
				type: "run_complete",
				payload: "oops",
			},
		],
	])("T-PEL-07: returns null when %s", (_label, envelope) => {
		expect(parseEventLine(JSON.stringify(envelope))).toBeNull();
	});
});
