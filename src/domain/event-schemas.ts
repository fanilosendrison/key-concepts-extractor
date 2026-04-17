// NIB-M-EVENT-LOGGER §3 + NIB-M-CLI §3.3 — normative payload shapes for the
// typed PipelineEvent types listed in domain/types.ts PIPELINE_EVENT_TYPES.
//
// Source of truth for two sides that previously duplicated the contract:
//   - CLI reader (cli/format-event.ts) — validates inbound events.jsonl via
//     safeParse; imports EVENT_PAYLOAD_SCHEMAS.
//   - Emitters (pipeline.ts, domain/extraction-orchestrator.ts) — use
//     `satisfies EventPayloads[<type>]` on inline payload literals to catch
//     drift at compile time. The emit runtime API stays accept-anything for
//     events not covered here (e.g. fusion_*_complete), preserving the low-
//     ceremony observability channel for ad-hoc telemetry.
//
// Drift history that motivated centralisation:
//   - `fatal` on run_error: added at emit time, CLI schema lagged, generic
//     fallback triggered until the schema was widened.
//   - `concepts_dropped` on extraction_complete: same pattern.
// Both were tracked as backlog notables before this module existed.

import { z } from "zod";

export const RunCompletePayloadSchema = z.object({
	total_concepts: z.number(),
	output_dir: z.string(),
});

export const RunErrorPayloadSchema = z.object({
	error: z.string(),
	// Consumed by WS/UI for surfacing intent; CLI formatter renders "Fatal"
	// uniformly per §3.3.
	fatal: z.boolean().optional(),
});

export const RunStoppedPayloadSchema = z.object({
	reason: z.string(),
});

export const ExtractionStartPayloadSchema = z.object({
	angle: z.string(),
	model: z.string(),
});

export const ExtractionCompletePayloadSchema = z.object({
	angle: z.string(),
	model: z.string(),
	concepts_count: z.number(),
	// Raw count rejected by the schema before reaching concepts_count.
	concepts_dropped: z.number().optional(),
});

export const ExtractionProgressPayloadSchema = z.object({
	completed: z.number(),
	total: z.number(),
});

export const ControlStartPayloadSchema = z.object({
	control: z.enum(["quality", "relevance"]),
	round: z.number(),
	model: z.string(),
	scope: z.string(),
});

export const ConceptDroppedPayloadSchema = z.object({
	angle: z.string(),
	model: z.string(),
	concepts_valid: z.number(),
	concepts_dropped: z.number(),
	samples: z.array(
		z.object({
			term: z.string().optional(),
			reason: z.string(),
		}),
	),
});

// Lookup table keyed by PipelineEventType. Covers the subset of events that
// have a bespoke payload contract. Events not listed here are emitted with a
// `Record<string, unknown>` payload and rendered via the generic JSON form.
// Adding a new typed event: add the schema above, then add its (type, schema)
// pair below — everything else flows automatically.
export const EVENT_PAYLOAD_SCHEMAS = {
	run_complete: RunCompletePayloadSchema,
	run_error: RunErrorPayloadSchema,
	run_stopped: RunStoppedPayloadSchema,
	extraction_start: ExtractionStartPayloadSchema,
	extraction_complete: ExtractionCompletePayloadSchema,
	extraction_progress: ExtractionProgressPayloadSchema,
	control_start: ControlStartPayloadSchema,
	concept_dropped: ConceptDroppedPayloadSchema,
} as const;

export type KnownEventType = keyof typeof EVENT_PAYLOAD_SCHEMAS;

// Typed payload per event type — use at emit sites with `satisfies
// EventPayloads["<type>"]` to get compile-time drift detection.
export type EventPayloads = {
	[K in KnownEventType]: z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[K]>;
};
