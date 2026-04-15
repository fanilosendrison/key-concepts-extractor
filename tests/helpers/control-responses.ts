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
}

export function qualityR1(errors: QualityR1Error[], noErrorCount = 0): string {
  return JSON.stringify({ errors_found: errors, no_error_count: noErrorCount });
}

export interface QualityR2Review {
  target: string;
  verdict: "confirmed" | "contested";
  justification: string;
}

export function qualityR2(
  reviews: QualityR2Review[],
  additional: QualityR1Error[] = [],
): string {
  return JSON.stringify({
    reviews_of_claude: reviews,
    additional_errors: additional,
  });
}

export interface QualityR3Decision {
  target: string;
  decision: "corrected" | "maintained";
  reasoning: string;
}

export function qualityR3(decisions: QualityR3Decision[]): string {
  return JSON.stringify({ final_decisions: decisions });
}

// ---------- Relevance ----------

export interface RelevanceR1Flag {
  target: string;
  reason: string;
}

export function relevanceR1(flags: RelevanceR1Flag[], notFlaggedCount = 0): string {
  return JSON.stringify({ flagged_off_topic: flags, not_flagged_count: notFlaggedCount });
}

export interface RelevanceR2Review {
  target: string;
  verdict: "confirmed_off_topic" | "defended";
  reason: string;
}

export function relevanceR2(
  reviews: RelevanceR2Review[],
  additional: RelevanceR1Flag[] = [],
): string {
  return JSON.stringify({ reviews_of_claude: reviews, additional_flags: additional });
}

export interface RelevanceR3Decision {
  target: string;
  decision: "removed" | "retained";
  reasoning: string;
}

export function relevanceR3(decisions: RelevanceR3Decision[]): string {
  return JSON.stringify({ final_decisions: decisions });
}
