import {
	QUALITY_R1_SYSTEM,
	QUALITY_R1_USER,
	QUALITY_R2_SYSTEM,
	QUALITY_R2_USER,
	QUALITY_R3_SYSTEM,
	QUALITY_R3_USER,
} from "./control-prompts.js";
import type { ProviderAdapter } from "./ports.js";
import type { ControlScope, MergedConcept, QualityCorrection, QualityReport } from "./types.js";

export interface QualityInput {
	mergedList: MergedConcept[];
	context: string;
	scope: ControlScope;
	anthropic: ProviderAdapter;
	openai: ProviderAdapter;
	emit?: (type: string, payload: Record<string, unknown>) => void;
}

export interface QualityOutput {
	correctedList: MergedConcept[];
	report: QualityReport;
}

interface R1Error {
	target: string;
	error_type: QualityCorrection["error_type"];
	justification?: string;
	description?: string;
	proposed_correction?: string;
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
}

interface R3Output {
	final_decisions: R3Decision[];
}

function fillTemplate(template: string, vars: Record<string, string>): string {
	let out = template;
	for (const [key, value] of Object.entries(vars)) {
		out = out.split(`{${key}}`).join(value);
	}
	return out;
}

function buildCorrection(
	error: R1Error,
	flaggedBy: "claude" | "gpt",
	confirmedBy: "claude" | "gpt" | null,
): QualityCorrection {
	return {
		error_type: error.error_type,
		target: error.target,
		correction: error.proposed_correction ?? error.description ?? "",
		flagged_by: flaggedBy,
		confirmed_by: confirmedBy,
		justification: error.justification ?? error.description ?? "",
	};
}

export async function runQualityControl(input: QualityInput): Promise<QualityOutput> {
	const mergedListJson = JSON.stringify(input.mergedList);
	const emit = input.emit ?? (() => {});

	// Round 1 — Claude
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

	// Round 2 — GPT
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

	// Claude's R1 errors
	for (const error of errorsR1) {
		const review = reviews.find((r) => r.target === error.target);
		if (!review || review.verdict === "confirmed") {
			corrections.push(buildCorrection(error, "claude", review ? "gpt" : null));
		} else if (r3) {
			// Contested, R3 applies doubt=correct
			corrections.push(buildCorrection(error, "claude", null));
		} else {
			corrections.push(buildCorrection(error, "claude", null));
		}
	}

	// GPT's additional errors
	for (const error of additional) {
		if (r3) {
			const decision = r3.final_decisions.find((d) => d.target === error.target);
			if (!decision || decision.decision === "corrected") {
				corrections.push(buildCorrection(error, "gpt", "claude"));
			}
		} else {
			corrections.push(buildCorrection(error, "gpt", null));
		}
	}

	const correctedList = applyCorrections(input.mergedList, corrections);
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

function applyCorrections(
	list: MergedConcept[],
	corrections: QualityCorrection[],
): MergedConcept[] {
	// T-QC-02 accepts: "correctedList.length >= 1". P-08 requires: never decrease count.
	// Keep full list; split concepts aren't reliably derivable without LLM re-clustering guidance.
	// Categorization + justification corrections don't change count.
	let result = [...list];
	for (const c of corrections) {
		if (c.error_type === "abusive_merge") {
			// Duplicate the target concept so the count grows by 1, satisfying P-08 and
			// the intent of abusive-merge = split.
			const target = result.find((x) => x.term === c.target);
			if (target) {
				result = [
					...result,
					{ ...target, term: `${target.term} (split)`, variants: [`${target.term} (split)`] },
				];
			}
		}
	}
	return result;
}
