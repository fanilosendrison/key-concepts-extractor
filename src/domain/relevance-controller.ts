import { z } from "zod";
import {
	RELEVANCE_R1_SYSTEM,
	RELEVANCE_R1_USER,
	RELEVANCE_R2_SYSTEM,
	RELEVANCE_R2_USER,
	RELEVANCE_R3_SYSTEM,
	RELEVANCE_R3_USER,
} from "./control-prompts.js";
import { type EmitFn, runThreeRoundControl } from "./control-shared.js";
import type { ProviderAdapter } from "./ports.js";
import {
	type ControllableConcept,
	type ControlScope,
	getTerm,
	type RelevanceRemoval,
	type RelevanceReport,
	type RelevanceRetention,
} from "./types.js";

export interface RelevanceInput<T extends ControllableConcept> {
	mergedList: T[];
	context: string;
	scope: ControlScope;
	anthropic: ProviderAdapter;
	openai: ProviderAdapter;
	emit?: EmitFn;
	signal?: AbortSignal | undefined;
}

export interface RelevanceOutput<T extends ControllableConcept> {
	filteredList: T[];
	report: RelevanceReport;
}

// NIB-M-RELEVANCE-CONTROLLER §6 : fail-closed at every R1/R2/R3 trust boundary.
const R1FlagSchema = z.object({
	target: z.string(),
	reason: z.string().optional(),
});
const R1OutputSchema = z.object({
	flagged_off_topic: z.array(R1FlagSchema).default([]),
	not_flagged_count: z.number().optional(),
});
const R2ReviewSchema = z.object({
	target: z.string(),
	verdict: z.enum(["confirmed_off_topic", "defended"]),
	reason: z.string().optional(),
});
const R2OutputSchema = z.object({
	reviews_of_claude: z.array(R2ReviewSchema).default([]),
	additional_flags: z.array(R1FlagSchema).default([]),
});
const R3DecisionSchema = z.object({
	target: z.string(),
	decision: z.enum(["removed", "retained"]),
	reasoning: z.string().optional(),
});
const R3OutputSchema = z.object({
	final_decisions: z.array(R3DecisionSchema).default([]),
});

type R1Output = z.infer<typeof R1OutputSchema>;
type R2Output = z.infer<typeof R2OutputSchema>;
type R3Output = z.infer<typeof R3OutputSchema>;

export async function runRelevanceControl<T extends ControllableConcept>(
	input: RelevanceInput<T>,
): Promise<RelevanceOutput<T>> {
	return runThreeRoundControl<T, R1Output, R2Output, R3Output, RelevanceOutput<T>>({
		control: "relevance",
		mergedList: input.mergedList,
		context: input.context,
		scope: input.scope,
		anthropic: input.anthropic,
		openai: input.openai,
		emit: input.emit,
		signal: input.signal,
		prompts: {
			r1: { system: RELEVANCE_R1_SYSTEM, user: RELEVANCE_R1_USER },
			r2: { system: RELEVANCE_R2_SYSTEM, user: RELEVANCE_R2_USER },
			r3: { system: RELEVANCE_R3_SYSTEM, user: RELEVANCE_R3_USER },
		},
		schemas: { r1: R1OutputSchema, r2: R2OutputSchema, r3: R3OutputSchema },
		earlyExit: (r1, mergedList) => {
			if (r1.flagged_off_topic.length > 0) return null;
			return {
				filteredList: mergedList,
				report: {
					review_rounds: 1,
					concepts_flagged: 0,
					concepts_removed: 0,
					concepts_retained_after_dispute: 0,
					removed: [],
					retained_after_dispute: [],
				},
			};
		},
		// R3 only fires when GPT adds NEW flags Claude hasn't seen.
		// Defense alone resolves deterministically (disagreement = retention).
		shouldFireR3: (r2) => r2.additional_flags.length > 0,
		aggregate: ({ r1, r2, r3, mergedList, roundsUsed }) => {
			const removed: RelevanceRemoval[] = [];
			const retained: RelevanceRetention[] = [];
			const termsToRemove = new Set<string>();

			for (const flag of r1.flagged_off_topic) {
				const review = r2.reviews_of_claude.find((r) => r.target === flag.target);
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

			for (const flag of r2.additional_flags) {
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

			const filteredList = mergedList.filter((c) => !termsToRemove.has(getTerm(c).toLowerCase()));

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
		},
	});
}
