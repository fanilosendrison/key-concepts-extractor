import { z } from "zod";
import {
	QUALITY_R1_SYSTEM,
	QUALITY_R1_USER,
	QUALITY_R2_SYSTEM,
	QUALITY_R2_USER,
	QUALITY_R3_SYSTEM,
	QUALITY_R3_USER,
} from "./control-prompts.js";
import { ControlSchemaError, type EmitFn, runThreeRoundControl } from "./control-shared.js";
import type { ProviderAdapter } from "./ports.js";
import {
	type ControllableConcept,
	type ControlScope,
	getTerm,
	type QualityCorrection,
	type QualityReport,
	withTerm,
} from "./types.js";

export interface QualityInput<T extends ControllableConcept> {
	mergedList: T[];
	context: string;
	scope: ControlScope;
	anthropic: ProviderAdapter;
	openai: ProviderAdapter;
	emit?: EmitFn;
	signal?: AbortSignal | undefined;
}

export interface QualityOutput<T extends ControllableConcept> {
	correctedList: T[];
	report: QualityReport;
}

const R1ErrorSchema = z.object({
	target: z.string(),
	error_type: z.enum(["abusive_merge", "incorrect_categorization", "justification_incoherence"]),
	justification: z.string().optional(),
	description: z.string().optional(),
	proposed_correction: z.string().optional(),
	suggested_split: z.array(z.string()).nullable().optional(),
});
const R1OutputSchema = z.object({
	errors_found: z.array(R1ErrorSchema).default([]),
	no_error_count: z.number().optional(),
});
const R2ReviewSchema = z.object({
	target: z.string(),
	verdict: z.enum(["confirmed", "contested"]),
	justification: z.string().optional(),
});
const R2OutputSchema = z.object({
	reviews_of_claude: z.array(R2ReviewSchema).default([]),
	additional_errors: z.array(R1ErrorSchema).default([]),
});
const R3DecisionSchema = z.object({
	target: z.string(),
	decision: z.enum(["corrected", "maintained"]),
	reasoning: z.string().optional(),
	suggested_split: z.array(z.string()).nullable().optional(),
});
const R3OutputSchema = z.object({
	final_decisions: z.array(R3DecisionSchema).default([]),
});

type R1Error = z.infer<typeof R1ErrorSchema>;
type R1Output = z.infer<typeof R1OutputSchema>;
type R2Output = z.infer<typeof R2OutputSchema>;
type R3Decision = z.infer<typeof R3DecisionSchema>;
type R3Output = z.infer<typeof R3OutputSchema>;

function assertValidSplit(
	target: string,
	suggestedSplit: string[] | null | undefined,
	source: "R1" | "R2" | "R3",
): asserts suggestedSplit is string[] {
	if (!Array.isArray(suggestedSplit) || suggestedSplit.length < 2) {
		throw new ControlSchemaError(
			`Quality ${source}: abusive_merge on "${target}" requires suggested_split with ≥2 terms (got ${JSON.stringify(suggestedSplit)})`,
		);
	}
	const unique = new Set(suggestedSplit);
	if (unique.size !== suggestedSplit.length) {
		throw new ControlSchemaError(
			`Quality ${source}: abusive_merge on "${target}" suggested_split contains duplicates`,
		);
	}
	if (suggestedSplit.includes(target)) {
		throw new ControlSchemaError(
			`Quality ${source}: abusive_merge on "${target}" suggested_split must not include the target itself`,
		);
	}
}

function buildCorrection(
	error: R1Error,
	flaggedBy: "claude" | "gpt",
	confirmedBy: "claude" | "gpt" | null,
	suggestedSplit: string[] | null,
): QualityCorrection {
	return {
		error_type: error.error_type,
		target: error.target,
		correction: error.proposed_correction ?? error.description ?? "",
		suggested_split: suggestedSplit,
		flagged_by: flaggedBy,
		confirmed_by: confirmedBy,
		justification: error.justification ?? error.description ?? "",
	};
}

function resolveSuggestedSplit(
	error: R1Error,
	r3Decision: R3Decision | undefined,
	r1Source: "R1" | "R2",
): string[] | null {
	if (error.error_type !== "abusive_merge") return null;
	if (r3Decision && r3Decision.decision === "corrected") {
		assertValidSplit(error.target, r3Decision.suggested_split, "R3");
		return r3Decision.suggested_split;
	}
	assertValidSplit(error.target, error.suggested_split, r1Source);
	return error.suggested_split;
}

export async function runQualityControl<T extends ControllableConcept>(
	input: QualityInput<T>,
): Promise<QualityOutput<T>> {
	const emit = input.emit ?? (() => {});
	const warn = (payload: Record<string, unknown>) => emit("quality_warning", payload);

	return runThreeRoundControl<T, R1Output, R2Output, R3Output, QualityOutput<T>>({
		control: "quality",
		mergedList: input.mergedList,
		context: input.context,
		scope: input.scope,
		anthropic: input.anthropic,
		openai: input.openai,
		emit: input.emit,
		signal: input.signal,
		prompts: {
			r1: { system: QUALITY_R1_SYSTEM, user: QUALITY_R1_USER },
			r2: { system: QUALITY_R2_SYSTEM, user: QUALITY_R2_USER },
			r3: { system: QUALITY_R3_SYSTEM, user: QUALITY_R3_USER },
		},
		schemas: { r1: R1OutputSchema, r2: R2OutputSchema, r3: R3OutputSchema },
		earlyExit: (r1, mergedList) => {
			if (r1.errors_found.length > 0) return null;
			return {
				correctedList: mergedList,
				report: {
					review_type: "fusion_quality",
					review_rounds: 1,
					errors_flagged: 0,
					errors_corrected: 0,
					corrections: [],
				},
			};
		},
		// §4.2 : R3 fires on contested verdicts OR when GPT introduces new errors.
		shouldFireR3: (r2) =>
			r2.reviews_of_claude.some((r) => r.verdict === "contested") ||
			r2.additional_errors.length > 0,
		aggregate: ({ r1, r2, r3, mergedList, roundsUsed }) => {
			const corrections: QualityCorrection[] = [];

			for (const error of r1.errors_found) {
				const review = r2.reviews_of_claude.find((r) => r.target === error.target);
				const r3Decision = r3?.final_decisions.find((d) => d.target === error.target);

				// R3 "maintained" overrides and skips correction (final arbiter).
				if (r3Decision && r3Decision.decision === "maintained") continue;

				const split = resolveSuggestedSplit(error, r3Decision, "R1");
				if (!review || review.verdict === "confirmed") {
					corrections.push(buildCorrection(error, "claude", review ? "gpt" : null, split));
				} else {
					// Contested by GPT → R3 arbitrates (doubt = correct). Defensive when no R3.
					corrections.push(buildCorrection(error, "claude", null, split));
				}
			}

			for (const error of r2.additional_errors) {
				if (!r3) continue;
				const r3Decision = r3.final_decisions.find((d) => d.target === error.target);
				if (!r3Decision || r3Decision.decision === "maintained") continue;
				const split = resolveSuggestedSplit(error, r3Decision, "R2");
				corrections.push(buildCorrection(error, "gpt", "claude", split));
			}

			const correctedList = applyCorrections(mergedList, corrections, warn);

			return {
				correctedList,
				report: {
					review_type: "fusion_quality",
					review_rounds: roundsUsed,
					errors_flagged: corrections.length,
					errors_corrected: corrections.length,
					corrections,
				},
			};
		},
	});
}

function applyCorrections<T extends ControllableConcept>(
	list: T[],
	corrections: QualityCorrection[],
	warn: (payload: Record<string, unknown>) => void,
): T[] {
	let result = [...list];
	for (const c of corrections) {
		switch (c.error_type) {
			case "abusive_merge":
				result = splitCluster(result, c, warn);
				break;
			case "incorrect_categorization":
			case "justification_incoherence":
				// v1: report-only (LLM gives no structured new value).
				break;
		}
	}
	return result;
}

function splitCluster<T extends ControllableConcept>(
	list: T[],
	correction: QualityCorrection,
	warn: (payload: Record<string, unknown>) => void,
): T[] {
	if (!correction.suggested_split) {
		throw new ControlSchemaError(
			`splitCluster invoked without suggested_split on target "${correction.target}"`,
		);
	}
	const targetIdx = list.findIndex((x) => getTerm(x) === correction.target);
	if (targetIdx === -1) {
		warn({ reason: "target_not_found", target: correction.target });
		return list;
	}
	const target = list[targetIdx];
	if (!target) return list;

	// NIB-M-QC §4.4 inheritance : only term/variants change, all other fields inherited as-is.
	const splits: T[] = correction.suggested_split.map((term) => withTerm(target, term));
	return [...list.slice(0, targetIdx), ...splits, ...list.slice(targetIdx + 1)];
}
