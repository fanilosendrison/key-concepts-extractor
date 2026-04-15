import { fillTemplate } from "./collection-utils.js";
import {
	QUALITY_R1_SYSTEM,
	QUALITY_R1_USER,
	QUALITY_R2_SYSTEM,
	QUALITY_R2_USER,
	QUALITY_R3_SYSTEM,
	QUALITY_R3_USER,
} from "./control-prompts.js";
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
	emit?: (type: string, payload: Record<string, unknown>) => void;
}

export interface QualityOutput<T extends ControllableConcept> {
	correctedList: T[];
	report: QualityReport;
}

interface R1Error {
	target: string;
	error_type: QualityCorrection["error_type"];
	justification?: string;
	description?: string;
	proposed_correction?: string;
	suggested_split?: string[] | null;
}

interface R1Output {
	errors_found: R1Error[];
	no_error_count?: number;
}

interface R2Review {
	target: string;
	verdict: "confirmed" | "contested";
	justification?: string;
}

interface R2Output {
	reviews_of_claude: R2Review[];
	additional_errors: R1Error[];
}

interface R3Decision {
	target: string;
	decision: "corrected" | "maintained";
	reasoning?: string;
	suggested_split?: string[] | null;
}

interface R3Output {
	final_decisions: R3Decision[];
}

export class QualityControlSchemaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "QualityControlSchemaError";
	}
}

function assertValidSplit(
	target: string,
	suggestedSplit: string[] | null | undefined,
	source: "R1" | "R2" | "R3",
): asserts suggestedSplit is string[] {
	// NIB-M-QUALITY-CONTROLLER §6 fail-closed on schema violation for abusive_merge.
	if (!Array.isArray(suggestedSplit) || suggestedSplit.length < 2) {
		throw new QualityControlSchemaError(
			`Quality ${source}: abusive_merge on "${target}" requires suggested_split with ≥2 terms (got ${JSON.stringify(suggestedSplit)})`,
		);
	}
	const unique = new Set(suggestedSplit);
	if (unique.size !== suggestedSplit.length) {
		throw new QualityControlSchemaError(
			`Quality ${source}: abusive_merge on "${target}" suggested_split contains duplicates`,
		);
	}
	if (suggestedSplit.includes(target)) {
		throw new QualityControlSchemaError(
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
	// Non-abusive_merge → no split needed.
	if (error.error_type !== "abusive_merge") return null;

	// When R3 issued a "corrected" decision for this target, its split is authoritative.
	if (r3Decision && r3Decision.decision === "corrected") {
		assertValidSplit(error.target, r3Decision.suggested_split, "R3");
		return r3Decision.suggested_split;
	}

	// Otherwise use the originating round's split.
	assertValidSplit(error.target, error.suggested_split, r1Source);
	return error.suggested_split;
}

export async function runQualityControl<T extends ControllableConcept>(
	input: QualityInput<T>,
): Promise<QualityOutput<T>> {
	const mergedListJson = JSON.stringify(input.mergedList);
	const emit = input.emit ?? (() => {});
	const warn = (payload: Record<string, unknown>) => emit("quality_warning", payload);

	emit("control_start", { control: "quality", round: 1, model: "claude", scope: input.scope });
	const r1Response = await input.anthropic.call({
		systemPrompt: QUALITY_R1_SYSTEM,
		userPrompt: fillTemplate(QUALITY_R1_USER, {
			context: input.context,
			merged_list: mergedListJson,
		}),
		provider: "anthropic",
	});
	const r1 = JSON.parse(r1Response.content) as R1Output;
	const errorsR1 = r1.errors_found ?? [];

	if (errorsR1.length === 0) {
		return {
			correctedList: input.mergedList,
			report: {
				review_type: "fusion_quality",
				review_rounds: 1,
				errors_flagged: 0,
				errors_corrected: 0,
				corrections: [],
			},
		};
	}

	emit("control_start", { control: "quality", round: 2, model: "gpt", scope: input.scope });
	const r2Response = await input.openai.call({
		systemPrompt: QUALITY_R2_SYSTEM,
		userPrompt: fillTemplate(QUALITY_R2_USER, {
			context: input.context,
			merged_list: mergedListJson,
			claude_findings: JSON.stringify(r1),
		}),
		provider: "openai",
	});
	const r2 = JSON.parse(r2Response.content) as R2Output;
	const reviews = r2.reviews_of_claude ?? [];
	const additional = r2.additional_errors ?? [];

	const hasDisagreement = reviews.some((r) => r.verdict === "contested");
	const hasAdditional = additional.length > 0;

	let r3: R3Output | null = null;
	if (hasDisagreement || hasAdditional) {
		emit("control_start", { control: "quality", round: 3, model: "claude", scope: input.scope });
		const r3Response = await input.anthropic.call({
			systemPrompt: QUALITY_R3_SYSTEM,
			userPrompt: fillTemplate(QUALITY_R3_USER, {
				context: input.context,
				merged_list: mergedListJson,
				claude_findings: JSON.stringify(r1),
				gpt_findings: JSON.stringify(r2),
			}),
			provider: "anthropic",
		});
		r3 = JSON.parse(r3Response.content) as R3Output;
	}

	const corrections: QualityCorrection[] = [];

	for (const error of errorsR1) {
		const review = reviews.find((r) => r.target === error.target);
		const r3Decision = r3?.final_decisions.find((d) => d.target === error.target);

		// R3 "maintained" overrides and skips correction (final arbiter).
		if (r3Decision && r3Decision.decision === "maintained") continue;

		const split = resolveSuggestedSplit(error, r3Decision, "R1");
		if (!review || review.verdict === "confirmed") {
			corrections.push(buildCorrection(error, "claude", review ? "gpt" : null, split));
		} else {
			// Contested by GPT → R3 arbitrates (doubt = correct). When no R3 exists
			// despite disagreement, defensive path: rule doubt=correct still applies.
			corrections.push(buildCorrection(error, "claude", null, split));
		}
	}

	// §4.2 : hasAdditional=true forces R3 invocation, so r3 is non-null when this loop runs.
	for (const error of additional) {
		if (!r3) continue;
		const r3Decision = r3.final_decisions.find((d) => d.target === error.target);
		if (!r3Decision || r3Decision.decision === "maintained") continue;
		const split = resolveSuggestedSplit(error, r3Decision, "R2");
		corrections.push(buildCorrection(error, "gpt", "claude", split));
	}

	const correctedList = applyCorrections(input.mergedList, corrections, warn);
	const roundsUsed = r3 ? 3 : 2;

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
				// v1: categorization/justification updates are reflected only in the report,
				// not re-applied to the concept object (LLM gives no structured new value).
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
		// Validated upstream in resolveSuggestedSplit; defensive only.
		throw new QualityControlSchemaError(
			`splitCluster invoked without suggested_split on target "${correction.target}"`,
		);
	}
	const targetIdx = list.findIndex((x) => getTerm(x) === correction.target);
	// NIB-M-QC §6: target not found → skip + warn (non-fatal, distinct from schema violation).
	if (targetIdx === -1) {
		warn({ reason: "target_not_found", target: correction.target });
		return list;
	}
	const target = list[targetIdx];
	if (!target) return list;

	// Inheritance rule (NIB-M-QC §4.4): all fields inherited from target except `term` (or
	// `canonical_term` for FinalConcept) and `variants`, which come from suggested_split.
	const splits: T[] = correction.suggested_split.map((term) => withTerm(target, term));
	return [...list.slice(0, targetIdx), ...splits, ...list.slice(targetIdx + 1)];
}
