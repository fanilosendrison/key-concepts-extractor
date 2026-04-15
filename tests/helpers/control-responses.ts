/**
 * Builders for mocked LLM control responses (QualityController + RelevanceController).
 * Shapes inferred from NIB-M-QUALITY-CONTROLLER §4 and NIB-M-RELEVANCE-CONTROLLER §4.
 * Each returns a JSON string ready to be queued into a mock ProviderAdapter.
 */

// ---------- Quality ----------

export interface QualityR1Error {
	target: string;
	error_type: "abusive_merge" | "incorrect_categorization" | "justification_incoherence";
	justification: string;
	// NIB-M-LLM-PAYLOADS Type 2 v0.3.0: required non-null for abusive_merge (≥2 distinct terms, none === target).
	suggested_split?: string[] | null;
}

export function qualityR1(errors: QualityR1Error[], noErrorCount = 0): string {
	const normalized = errors.map((e) => ({
		...e,
		suggested_split: e.suggested_split ?? null,
	}));
	return JSON.stringify({ errors_found: normalized, no_error_count: noErrorCount });
}

export interface QualityR2Review {
	target: string;
	verdict: "confirmed" | "contested";
	justification: string;
}

export function qualityR2(reviews: QualityR2Review[], additional: QualityR1Error[] = []): string {
	const normalized = additional.map((e) => ({
		...e,
		suggested_split: e.suggested_split ?? null,
	}));
	return JSON.stringify({
		reviews_of_claude: reviews,
		additional_errors: normalized,
	});
}

export interface QualityR3Decision {
	target: string;
	decision: "corrected" | "maintained";
	reasoning: string;
	// NIB-M-LLM-PAYLOADS Type 4 v0.3.0: required non-null when decision=corrected AND underlying error=abusive_merge.
	suggested_split?: string[] | null;
}

export function qualityR3(decisions: QualityR3Decision[]): string {
	const normalized = decisions.map((d) => ({
		...d,
		suggested_split: d.suggested_split ?? null,
	}));
	return JSON.stringify({ final_decisions: normalized });
}

// ---------- Relevance ----------

export interface RelevanceR1Flag {
	term: string;
	justification: string;
	confidence?: "certain" | "probable";
}

export function relevanceR1(flags: RelevanceR1Flag[], notFlaggedCount = 0): string {
	return JSON.stringify({ flagged_off_topic: flags, not_flagged_count: notFlaggedCount });
}

export interface RelevanceR2Review {
	term: string;
	verdict: "confirmed_off_topic" | "defended";
	justification: string;
}

export function relevanceR2(
	reviews: RelevanceR2Review[],
	additional: RelevanceR1Flag[] = [],
): string {
	return JSON.stringify({ reviews_of_claude: reviews, additional_flags: additional });
}

export interface RelevanceR3Decision {
	term: string;
	origin?: "claude_round1" | "gpt_round2";
	decision: "removed" | "retained";
	reasoning: string;
}

export function relevanceR3(decisions: RelevanceR3Decision[]): string {
	return JSON.stringify({ final_decisions: decisions });
}
