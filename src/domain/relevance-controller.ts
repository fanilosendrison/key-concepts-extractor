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

// NIB-M-RELEVANCE-CONTROLLER §6 + NIB-M-LLM-PAYLOADS Types 5/6/7 :
// fail-closed at every R1/R2/R3 trust boundary. Wire shape uses term/justification.
const ConfidenceSchema = z.enum(["certain", "probable"]).optional();

const R1FlagSchema = z.object({
	term: z.string(),
	justification: z.string().default(""),
	confidence: ConfidenceSchema,
});
const R1OutputSchema = z.object({
	flagged_off_topic: z.array(R1FlagSchema).default([]),
	not_flagged_count: z.number().optional(),
});
const R2ReviewSchema = z.object({
	term: z.string(),
	verdict: z.enum(["confirmed_off_topic", "defended"]),
	justification: z.string().default(""),
});
const R2OutputSchema = z.object({
	reviews_of_claude: z.array(R2ReviewSchema).default([]),
	additional_flags: z.array(R1FlagSchema).default([]),
});
const R3DecisionSchema = z.object({
	term: z.string(),
	origin: z.enum(["claude_round1", "gpt_round2"]).optional(),
	decision: z.enum(["removed", "retained"]),
	reasoning: z.string().default(""),
});
const R3SummarySchema = z
	.object({
		total_evaluated: z.number().optional(),
		removed: z.number().optional(),
		retained_after_dispute: z.number().optional(),
		retained_unanimous: z.number().optional(),
	})
	.optional();
const R3OutputSchema = z.object({
	final_decisions: z.array(R3DecisionSchema).default([]),
	summary: R3SummarySchema,
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
		// NIB-M-RELEVANCE-CONTROLLER §4.2 : R3 fires on disagreement OR additional flags.
		shouldFireR3: (r2) =>
			r2.reviews_of_claude.some((r) => r.verdict === "defended") || r2.additional_flags.length > 0,
		aggregate: ({ r1, r2, r3, mergedList, roundsUsed }) => {
			const removed: RelevanceRemoval[] = [];
			const retained: RelevanceRetention[] = [];
			const termsToRemove = new Set<string>();

			const RETAINED = "retained (désaccord = maintien)";

			for (const flag of r1.flagged_off_topic) {
				const review = r2.reviews_of_claude.find((r) => r.term === flag.term);
				if (review?.verdict === "confirmed_off_topic") {
					termsToRemove.add(flag.term.toLowerCase());
					removed.push({
						term: flag.term,
						flagged_by: "claude",
						confirmed_by: "gpt",
						justification_flagger: flag.justification,
						justification_confirmer: review.justification,
					});
				} else if (review?.verdict === "defended") {
					retained.push({
						term: flag.term,
						flagged_by: "claude",
						defended_by: "gpt",
						justification_flagger: flag.justification,
						counter_argument_defender: review.justification,
						final_decision: RETAINED,
					});
				} else {
					retained.push({
						term: flag.term,
						flagged_by: "claude",
						defended_by: "gpt",
						justification_flagger: flag.justification,
						counter_argument_defender: "No review from GPT",
						final_decision: RETAINED,
					});
				}
			}

			for (const flag of r2.additional_flags) {
				if (r3) {
					const decision = r3.final_decisions.find((d) => d.term === flag.term);
					if (decision?.decision === "removed") {
						termsToRemove.add(flag.term.toLowerCase());
						removed.push({
							term: flag.term,
							flagged_by: "gpt",
							confirmed_by: "claude",
							justification_flagger: flag.justification,
							justification_confirmer: decision.reasoning,
						});
					} else {
						retained.push({
							term: flag.term,
							flagged_by: "gpt",
							defended_by: "claude",
							justification_flagger: flag.justification,
							counter_argument_defender: decision?.reasoning ?? "Doubt = retention",
							final_decision: RETAINED,
						});
					}
				} else {
					retained.push({
						term: flag.term,
						flagged_by: "gpt",
						defended_by: "claude",
						justification_flagger: flag.justification,
						counter_argument_defender: "No Round 3",
						final_decision: RETAINED,
					});
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
