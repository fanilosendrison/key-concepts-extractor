// NIB-M-CLI §3.3 — one line per event, horodated, structured stdout. Terminal
// events (run_complete / run_error / run_stopped) and the extraction/control
// events listed in §3.3 get human-readable shapes prescribed by the spec ;
// every other event falls back to the generic `phase — type {payload}` form
// for live debugging.
//
// Payload shapes are validated at the presentation boundary via zod — the
// pipeline event bus types `payload` as Record<string, unknown>, so casting
// would hide emitter/formatter drift. Two policies coexist:
//   - parseEventLine (replay): fails soft, returns null on envelope mismatch.
//     Old events.jsonl lines from prior schemas must not crash `kce show`.
//   - formatEvent (live + replay display): falls back to the generic form on
//     payload-shape mismatch AND logs a pino warn. The fallback keeps output
//     visible; the warn surfaces the drift so an operator diagnosing broken
//     display knows the emitter and schema disagree.
//
// Payload schemas themselves live in domain/event-schemas.ts so the emitter
// side (pipeline.ts, extraction-orchestrator.ts) can `satisfies` the same
// types at compile time — historical drift (`fatal`, `concepts_dropped`)
// motivated the split from this file.

import { z } from "zod";
import { EVENT_PAYLOAD_SCHEMAS } from "../domain/event-schemas.js";
import { PIPELINE_EVENT_TYPES, PIPELINE_PHASES, type PipelineEvent } from "../domain/types.js";
import { logger } from "../infra/logger.js";

// Runtime mirror of the PipelineEvent domain type. The phase / type enums
// re-use the domain `as const` tuples so a new phase or event type added to
// domain/types.ts automatically flows into this schema — no silent drift
// where valid events get dropped as "(malformed event skipped)".
// `timestamp` uses `z.iso.datetime()` which in zod v4 accepts Z-suffixed UTC
// ISO-8601 with millisecond precision — exactly what NIB-M-EVENT-LOGGER §3.1
// prescribes and what `new Date().toISOString()` (event-logger.ts) emits.
// Non-Z offsets (`+02:00`) are REJECTED by design; the constraint is
// deliberate, not accidental. A non-ISO replay value (empty string, garbage)
// is rejected at parseEventLine instead of producing a corrupt slice(11, 23)
// downstream in formatEvent.
const PipelineEventSchema = z.object({
	timestamp: z.iso.datetime(),
	phase: z.enum(PIPELINE_PHASES),
	type: z.enum(PIPELINE_EVENT_TYPES),
	payload: z.record(z.string(), z.unknown()),
});

// Returns null on invalid JSON or schema mismatch so callers can degrade
// gracefully (show.ts prints a "(malformed event skipped)" line rather than
// crashing on a half-written events.jsonl).
export function parseEventLine(line: string): PipelineEvent | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	const parsed = PipelineEventSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

export function formatEvent(event: PipelineEvent): string {
	const time = event.timestamp.slice(11, 23);
	switch (event.type) {
		case "run_complete": {
			const p = EVENT_PAYLOAD_SCHEMAS.run_complete.safeParse(event.payload);
			if (!p.success) return warnAndFallback(time, event, p.error.issues);
			return `[${time}] ✅ Complete — ${p.data.total_concepts} concepts — ${p.data.output_dir}`;
		}
		case "run_error": {
			// §3.3 prescribes "Fatal" uniformly. The `fatal` boolean on the
			// payload is consumed by WS/UI for surfacing intent, not by the
			// CLI formatter — pipeline.ts can emit fatal:false for errors
			// that escape the try but aren't FatalLLMError instances.
			const p = EVENT_PAYLOAD_SCHEMAS.run_error.safeParse(event.payload);
			if (!p.success) return warnAndFallback(time, event, p.error.issues);
			return `[${time}] ❌ Fatal — ${p.data.error}`;
		}
		case "run_stopped": {
			const p = EVENT_PAYLOAD_SCHEMAS.run_stopped.safeParse(event.payload);
			if (!p.success) return warnAndFallback(time, event, p.error.issues);
			return `[${time}] 🛑 Stopped — ${p.data.reason}`;
		}
		case "extraction_start": {
			const p = EVENT_PAYLOAD_SCHEMAS.extraction_start.safeParse(event.payload);
			if (!p.success) return warnAndFallback(time, event, p.error.issues);
			return `[${time}] Extraction — ${p.data.angle} / ${p.data.model} — started`;
		}
		case "extraction_complete": {
			const p = EVENT_PAYLOAD_SCHEMAS.extraction_complete.safeParse(event.payload);
			if (!p.success) return warnAndFallback(time, event, p.error.issues);
			return `[${time}] Extraction — ${p.data.angle} / ${p.data.model} — ${p.data.concepts_count} concepts`;
		}
		case "extraction_progress": {
			const p = EVENT_PAYLOAD_SCHEMAS.extraction_progress.safeParse(event.payload);
			if (!p.success) return warnAndFallback(time, event, p.error.issues);
			return `[${time}] Extraction — ${p.data.completed}/${p.data.total} passes`;
		}
		case "control_start": {
			const p = EVENT_PAYLOAD_SCHEMAS.control_start.safeParse(event.payload);
			if (!p.success) return warnAndFallback(time, event, p.error.issues);
			const label = p.data.control === "quality" ? "Quality control" : "Relevance control";
			return `[${time}] ${label} — ${p.data.scope} — R${p.data.round} ${p.data.model}`;
		}
		default:
			// Unknown event type — no schema to validate against, so no drift
			// signal possible. Generic form is the final line of defence.
			// Known types INTENTIONALLY routed through this branch (no bespoke
			// formatter, observability via the generic JSON shape):
			//   - concept_dropped — typed in event-schemas.ts for emitter-side
			//     `satisfies` checks, but no prescribed §3.3 wording so the
			//     generic JSON rendering is the user-facing form.
			return genericForm(time, event);
	}
}

// Payload shape did not match the schema for a KNOWN event type — the emitter
// and the formatter disagree. Surface it via pino so an operator debugging a
// silent-degradation doesn't have to guess why a terminal event rendered as
// raw JSON. The generic form still displays (fail-soft), the warn is only a
// diagnostic signal. LOG_LEVEL=silent suppresses it in tests.
// No rate-limit by design: drift is expected to be a bug, not a steady state ;
// if a spammy emitter ever appears, the operator reads the first line and
// treats the rest as noise. Adding a rate-limiter would hide the first N
// failures of a flapping emitter, which is worse.
function warnAndFallback(time: string, event: PipelineEvent, issues: z.core.$ZodIssue[]): string {
	logger.warn(
		{ event_type: event.type, issues },
		"formatEvent: payload shape did not match schema for known event type — falling back to generic form",
	);
	return genericForm(time, event);
}

function genericForm(time: string, event: PipelineEvent): string {
	return `[${time}] ${event.phase} — ${event.type} ${JSON.stringify(event.payload)}`;
}
