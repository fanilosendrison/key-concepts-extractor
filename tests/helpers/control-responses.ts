/**
 * Builders for mocked LLM control responses (QualityController + RelevanceController).
 * Wire shapes follow NIB-M-LLM-PAYLOADS Types 2/3/4 (quality) and 5/6/7 (relevance).
 * Each returns a JSON string ready to be queued into a mock ProviderAdapter.
 *
 * Fidelity policy: helpers emit the FULL spec shape by default — every
 * spec-mandated field is populated with a sensible default so mocks simulate
 * what a compliant LLM would return, not what the permissive parser tolerates.
 * Callers override any field for scenario-specific tests.
 *
 * Parser tolerance (partial LLM responses) is covered by dedicated
 * `T-QC-MINIMAL` / `T-RC-MINIMAL` tests that bypass these helpers and feed
 * bare-minimum JSON directly.
 */

// ---------- Quality ----------

// NIB-M-LLM-PAYLOADS Type 2 `errors_found[]`.
export interface QualityR1Error {
	target: string;
	error_type: "abusive_merge" | "incorrect_categorization" | "justification_incoherence";
	justification: string;
	description?: string;
	proposed_correction?: string;
	confidence?: "certain" | "probable" | "doubtful";
	// Required non-null for abusive_merge (≥2 distinct terms, none === target); null otherwise.
	suggested_split?: string[] | null;
}

function fullR1Error(e: QualityR1Error): Record<string, unknown> {
	if (e.error_type === "abusive_merge" && e.suggested_split === undefined) {
		throw new Error(
			`control-responses: R1 abusive_merge for "${e.target}" requires explicit suggested_split (spec mandates non-null array)`,
		);
	}
	return {
		target: e.target,
		error_type: e.error_type,
		justification: e.justification,
		description: e.description ?? e.justification,
		proposed_correction: e.proposed_correction ?? "",
		confidence: e.confidence ?? "probable",
		suggested_split: e.suggested_split ?? null,
	};
}

export function qualityR1(errors: QualityR1Error[], noErrorCount = 0): string {
	return JSON.stringify({
		errors_found: errors.map(fullR1Error),
		no_error_count: noErrorCount,
	});
}

// NIB-M-LLM-PAYLOADS Type 3 `reviews_of_claude[]`.
// `claude_error_type` is required (echoes the error_type Claude flagged in
// R1). A default would lie in scenarios reviewing incorrect_categorization
// or justification_incoherence, so the caller must always supply it — when
// the controller grows a cross-check against R1, mocks stay honest.
export interface QualityR2Review {
	target: string;
	verdict: "confirmed" | "contested";
	justification: string;
	claude_error_type: "abusive_merge" | "incorrect_categorization" | "justification_incoherence";
}

function fullR2Review(r: QualityR2Review): Record<string, unknown> {
	return {
		target: r.target,
		claude_error_type: r.claude_error_type,
		verdict: r.verdict,
		justification: r.justification,
	};
}

export function qualityR2(reviews: QualityR2Review[], additional: QualityR1Error[] = []): string {
	return JSON.stringify({
		reviews_of_claude: reviews.map(fullR2Review),
		additional_errors: additional.map(fullR1Error),
	});
}

// NIB-M-LLM-PAYLOADS Type 4 `final_decisions[]`.
export interface QualityR3Decision {
	target: string;
	decision: "corrected" | "maintained";
	reasoning: string;
	// Required non-null when decision=corrected AND underlying error=abusive_merge.
	suggested_split?: string[] | null;
	origin?: "claude_round1" | "gpt_round2";
	correction_applied?: string | null;
}

function fullR3Decision(d: QualityR3Decision): Record<string, unknown> {
	// Per NIB-M-LLM-PAYLOADS Type 4: correction_applied describes the
	// correction itself (e.g. the new category for incorrect_categorization,
	// the rewritten justification for justification_incoherence) — NOT the
	// reasoning for why it was corrected. Default to empty string on
	// "corrected" (caller supplies the actual correction text) and null on
	// "maintained". Collapsing it to `reasoning` would silently conflate the
	// two fields against a parser that ever cross-reads them.
	return {
		target: d.target,
		origin: d.origin ?? "claude_round1",
		decision: d.decision,
		correction_applied:
			d.correction_applied !== undefined
				? d.correction_applied
				: d.decision === "corrected"
					? ""
					: null,
		suggested_split: d.suggested_split ?? null,
		reasoning: d.reasoning,
	};
}

export function qualityR3(decisions: QualityR3Decision[]): string {
	return JSON.stringify({ final_decisions: decisions.map(fullR3Decision) });
}

// ---------- Relevance ----------

// NIB-M-LLM-PAYLOADS Type 5 `flagged_off_topic[]`. Confidence is spec-mandated.
export interface RelevanceR1Flag {
	term: string;
	justification: string;
	confidence?: "certain" | "probable";
}

function fullR1Flag(f: RelevanceR1Flag): Record<string, unknown> {
	return {
		term: f.term,
		justification: f.justification,
		confidence: f.confidence ?? "probable",
	};
}

export function relevanceR1(flags: RelevanceR1Flag[], notFlaggedCount = 0): string {
	return JSON.stringify({
		flagged_off_topic: flags.map(fullR1Flag),
		not_flagged_count: notFlaggedCount,
	});
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
	return JSON.stringify({
		reviews_of_claude: reviews,
		additional_flags: additional.map(fullR1Flag),
	});
}

// NIB-M-LLM-PAYLOADS Type 7 `final_decisions[]` + mandated `summary` object.
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

// Per NIB-M-LLM-PAYLOADS Type 7, R3 `final_decisions` only contains concepts
// that reached R3 — i.e. concepts that were disputed (flagged by one side,
// defended or confirmed by the other). A non-removed R3 decision is therefore
// "retained after dispute", NOT "retained unanimous". Unanimous retention
// lives upstream of R3 and is invisible from the decisions list — default to
// 0 and let scenarios that care override.
function deriveSummary(
	decisions: RelevanceR3Decision[],
	override?: RelevanceR3Summary,
): RelevanceR3Summary {
	const removed = decisions.filter((d) => d.decision === "removed").length;
	const retainedAfterDispute = decisions.length - removed;
	return {
		total_evaluated: override?.total_evaluated ?? decisions.length,
		removed: override?.removed ?? removed,
		retained_after_dispute: override?.retained_after_dispute ?? retainedAfterDispute,
		retained_unanimous: override?.retained_unanimous ?? 0,
	};
}

function fullR3RelevanceDecision(d: RelevanceR3Decision): Record<string, unknown> {
	return {
		term: d.term,
		origin: d.origin ?? "claude_round1",
		decision: d.decision,
		reasoning: d.reasoning,
	};
}

export function relevanceR3(
	decisions: RelevanceR3Decision[],
	summary?: RelevanceR3Summary,
): string {
	return JSON.stringify({
		final_decisions: decisions.map(fullR3RelevanceDecision),
		summary: deriveSummary(decisions, summary),
	});
}
