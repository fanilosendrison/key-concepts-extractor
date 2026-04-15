import {
	RELEVANCE_R1_SYSTEM,
	RELEVANCE_R1_USER,
	RELEVANCE_R2_SYSTEM,
	RELEVANCE_R2_USER,
	RELEVANCE_R3_SYSTEM,
	RELEVANCE_R3_USER,
} from "./control-prompts.js";
import type { ProviderAdapter } from "./ports.js";
import type {
	ControlScope,
	MergedConcept,
	RelevanceRemoval,
	RelevanceReport,
	RelevanceRetention,
} from "./types.js";

export interface RelevanceInput {
	mergedList: MergedConcept[];
	context: string;
	scope: ControlScope;
	anthropic: ProviderAdapter;
	openai: ProviderAdapter;
	emit?: (type: string, payload: Record<string, unknown>) => void;
}

export interface RelevanceOutput {
	filteredList: MergedConcept[];
	report: RelevanceReport;
}

interface R1Flag {
	target: string;
	reason?: string;
}
interface R1Output {
	flagged_off_topic: R1Flag[];
	not_flagged_count?: number;
}
interface R2Review {
	target: string;
	verdict: "confirmed_off_topic" | "defended";
	reason?: string;
}
interface R2Output {
	reviews_of_claude: R2Review[];
	additional_flags: R1Flag[];
}
interface R3Decision {
	target: string;
	decision: "removed" | "retained";
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

export async function runRelevanceControl(input: RelevanceInput): Promise<RelevanceOutput> {
	const mergedListJson = JSON.stringify(input.mergedList);
	const emit = input.emit ?? (() => {});

	emit("control_start", { control: "relevance", round: 1, model: "claude", scope: input.scope });
	const r1Response = await input.anthropic.call({
		systemPrompt: RELEVANCE_R1_SYSTEM,
		userPrompt: fillTemplate(RELEVANCE_R1_USER, {
			context: input.context,
			merged_list: mergedListJson,
		}),
		provider: "anthropic",
	});
	const r1 = JSON.parse(r1Response.content) as R1Output;
	const flagged = r1.flagged_off_topic ?? [];

	if (flagged.length === 0) {
		return {
			filteredList: input.mergedList,
			report: {
				review_rounds: 1,
				concepts_flagged: 0,
				concepts_removed: 0,
				concepts_retained_after_dispute: 0,
				removed: [],
				retained_after_dispute: [],
			},
		};
	}

	emit("control_start", { control: "relevance", round: 2, model: "gpt", scope: input.scope });
	const r2Response = await input.openai.call({
		systemPrompt: RELEVANCE_R2_SYSTEM,
		userPrompt: fillTemplate(RELEVANCE_R2_USER, {
			context: input.context,
			merged_list: mergedListJson,
			claude_findings: JSON.stringify(r1),
		}),
		provider: "openai",
	});
	const r2 = JSON.parse(r2Response.content) as R2Output;
	const reviews = r2.reviews_of_claude ?? [];
	const additional = r2.additional_flags ?? [];

	// R3 only fires when GPT adds NEW flags Claude hasn't seen.
	// Defense alone resolves deterministically (disagreement = retention).
	const hasAdditional = additional.length > 0;

	let r3: R3Output | null = null;
	if (hasAdditional) {
		emit("control_start", { control: "relevance", round: 3, model: "claude", scope: input.scope });
		const r3Response = await input.anthropic.call({
			systemPrompt: RELEVANCE_R3_SYSTEM,
			userPrompt: fillTemplate(RELEVANCE_R3_USER, {
				context: input.context,
				merged_list: mergedListJson,
				claude_findings: JSON.stringify(r1),
				gpt_findings: JSON.stringify(r2),
			}),
			provider: "anthropic",
		});
		r3 = JSON.parse(r3Response.content) as R3Output;
	}

	const removed: RelevanceRemoval[] = [];
	const retained: RelevanceRetention[] = [];
	const termsToRemove = new Set<string>();

	for (const flag of flagged) {
		const review = reviews.find((r) => r.target === flag.target);
		if (review?.verdict === "confirmed_off_topic") {
			termsToRemove.add(flag.target.toLowerCase());
			removed.push({
				target: flag.target,
				reason: flag.reason ?? "",
				flagged_by: "claude",
				confirmed_by: "gpt",
			});
		} else if (review?.verdict === "defended") {
			retained.push({
				target: flag.target,
				defense: review.reason ?? "",
			});
		} else {
			// No review from GPT → retain (disagreement = retention)
			retained.push({
				target: flag.target,
				defense: "no review from GPT",
			});
		}
	}

	for (const flag of additional) {
		if (r3) {
			const decision = r3.final_decisions.find((d) => d.target === flag.target);
			if (decision?.decision === "removed") {
				termsToRemove.add(flag.target.toLowerCase());
				removed.push({
					target: flag.target,
					reason: flag.reason ?? "",
					flagged_by: "gpt",
					confirmed_by: "claude",
				});
			} else {
				retained.push({
					target: flag.target,
					defense: decision?.reasoning ?? "doubt = retention",
				});
			}
		} else {
			retained.push({ target: flag.target, defense: "no round 3" });
		}
	}

	const filteredList = input.mergedList.filter((c) => !termsToRemove.has(c.term.toLowerCase()));
	const roundsUsed = r3 ? 3 : 2;

	return {
		filteredList,
		report: {
			review_rounds: roundsUsed,
			concepts_flagged: removed.length + retained.length,
			concepts_removed: removed.length,
			concepts_retained_after_dispute: retained.length,
			removed,
			retained_after_dispute: retained,
		},
	};
}
