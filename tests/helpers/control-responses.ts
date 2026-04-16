/**
 * Builders for mocked LLM control responses (QualityController + RelevanceController).
 * Wire shapes follow NIB-M-LLM-PAYLOADS Types 2/3/4 (quality) and 5/6/7 (relevance).
 * Each returns a JSON string ready to be queued into a mock ProviderAdapter.
 *
 * Fidelity policy: all spec-mandated fields are exposed as optional inputs and
 * emitted in the JSON when provided. Unused fields are omitted so tests can
 * focus on the specific shape they want to exercise. The production parsers
 * in src/domain/{quality,relevance}-controller.ts are permissive and accept
 * both minimal and full shapes.
 */

// ---------- Quality ----------

// NIB-M-LLM-PAYLOADS Type 2 `errors_found[]`.
export interface QualityR1Error {
	target: string;
	error_type: "abusive_merge" | "incorrect_categorization" | "justification_incoherence";
	// Tolerated by the parser; widely used by tests as the "why" field.
	justification: string;
	// Spec-mandated fields — optional here so callers can pick minimal or full shapes.
	description?: string;
	proposed_correction?: string;
	confidence?: "certain" | "probable" | "doubtful";
	// Required non-null for abusive_merge (≥2 distinct terms, none === target); null otherwise.
	suggested_split?: string[] | null;
}

function normalizeR1Error(e: QualityR1Error): Record<string, unknown> {
	const out: Record<string, unknown> = {
		target: e.target,
		error_type: e.error_type,
		justification: e.justification,
		suggested_split: e.suggested_split ?? null,
	};
	if (e.description !== undefined) out.description = e.description;
	if (e.proposed_correction !== undefined) out.proposed_correction = e.proposed_correction;
	if (e.confidence !== undefined) out.confidence = e.confidence;
	return out;
}

export function qualityR1(errors: QualityR1Error[], noErrorCount = 0): string {
	return JSON.stringify({
		errors_found: errors.map(normalizeR1Error),
		no_error_count: noErrorCount,
	});
}

// NIB-M-LLM-PAYLOADS Type 3 `reviews_of_claude[]`.
export interface QualityR2Review {
	target: string;
	verdict: "confirmed" | "contested";
	justification: string;
	// Spec-mandated; optional here for minimal mocks.
	claude_error_type?: "abusive_merge" | "incorrect_categorization" | "justification_incoherence";
}

function normalizeR2Review(r: QualityR2Review): Record<string, unknown> {
	const out: Record<string, unknown> = {
		target: r.target,
		verdict: r.verdict,
		justification: r.justification,
	};
	if (r.claude_error_type !== undefined) out.claude_error_type = r.claude_error_type;
	return out;
}

export function qualityR2(reviews: QualityR2Review[], additional: QualityR1Error[] = []): string {
	return JSON.stringify({
		reviews_of_claude: reviews.map(normalizeR2Review),
		additional_errors: additional.map(normalizeR1Error),
	});
}

// NIB-M-LLM-PAYLOADS Type 4 `final_decisions[]`.
export interface QualityR3Decision {
	target: string;
	decision: "corrected" | "maintained";
	reasoning: string;
	// Required non-null when decision=corrected AND underlying error=abusive_merge.
	suggested_split?: string[] | null;
	// Spec-mandated; optional here for minimal mocks.
	origin?: "claude_round1" | "gpt_round2";
	correction_applied?: string | null;
}

function normalizeR3Decision(d: QualityR3Decision): Record<string, unknown> {
	const out: Record<string, unknown> = {
		target: d.target,
		decision: d.decision,
		reasoning: d.reasoning,
		suggested_split: d.suggested_split ?? null,
	};
	if (d.origin !== undefined) out.origin = d.origin;
	if (d.correction_applied !== undefined) out.correction_applied = d.correction_applied;
	return out;
}

export function qualityR3(decisions: QualityR3Decision[]): string {
	return JSON.stringify({ final_decisions: decisions.map(normalizeR3Decision) });
}

// ---------- Relevance ----------

// NIB-M-LLM-PAYLOADS Type 5 `flagged_off_topic[]`.
export interface RelevanceR1Flag {
	term: string;
	justification: string;
	confidence?: "certain" | "probable";
}

export function relevanceR1(flags: RelevanceR1Flag[], notFlaggedCount = 0): string {
	return JSON.stringify({ flagged_off_topic: flags, not_flagged_count: notFlaggedCount });
}

// NIB-M-LLM-PAYLOADS Type 6 `reviews_of_claude[]`.
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

// NIB-M-LLM-PAYLOADS Type 7 `final_decisions[]` + optional `summary` object.
export interface RelevanceR3Decision {
	term: string;
	origin?: "claude_round1" | "gpt_round2";
	decision: "removed" | "retained";
	reasoning: string;
}

export interface RelevanceR3Summary {
	total_evaluated?: number;
	removed?: number;
	retained_after_dispute?: number;
	retained_unanimous?: number;
}

export function relevanceR3(decisions: RelevanceR3Decision[], summary?: RelevanceR3Summary): string {
	const payload: Record<string, unknown> = { final_decisions: decisions };
	if (summary !== undefined) payload.summary = summary;
	return JSON.stringify(payload);
}
