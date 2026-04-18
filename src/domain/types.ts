export const CANONICAL_ANGLES = [
	"extraction_directe",
	"etats_ideaux",
	"mecanismes_causaux",
	"taxonomie",
	"conditions_bord",
] as const;
export type AngleId = (typeof CANONICAL_ANGLES)[number];

// Short IDs used in output files and provenance (NIB-T §C-07)
export const CANONICAL_PROVIDERS = ["claude", "gpt", "gemini"] as const;
export type ProviderId = (typeof CANONICAL_PROVIDERS)[number];

// Long IDs used at the adapter / wire level (NIB-M-PROVIDER-ADAPTERS §2)
export const CANONICAL_PROVIDER_LONG_IDS = ["anthropic", "openai", "google"] as const;
export type ProviderLongId = (typeof CANONICAL_PROVIDER_LONG_IDS)[number];

export type ControlScope = `angle:${AngleId}` | "inter_angle";

export type Consensus = "1/3" | "2/3" | "3/3";

export type AnglesCount = "1/5" | "2/5" | "3/5" | "4/5" | "5/5";

// Closed sets per NIB-S-KCE §3.14. Mirrored verbatim in the LLM extraction
// prompt (extraction-orchestrator.ts OUTPUT SCHEMA). Validated fail-closed in
// parseExtractionResponse so an out-of-set LLM value triggers a transient retry
// rather than silently flowing through fusion as an unknown category.
export const CONCEPT_CATEGORIES = [
	"phenomenon",
	"method",
	"metric",
	"property",
	"architecture",
	"tool",
	"constraint",
	"context",
] as const;
export type ConceptCategory = (typeof CONCEPT_CATEGORIES)[number];

export const GRANULARITY_LEVELS = [
	"token-level",
	"model-level",
	"system-level",
	"pipeline-level",
	"domain-level",
] as const;
export type GranularityLevel = (typeof GRANULARITY_LEVELS)[number];

// All fields required: shape is contractual with the LLM extraction prompt
// (see extraction-orchestrator.ts OUTPUT SCHEMA) and propagated as-is through
// fusion-intra → fusion-inter without optional handling downstream.
export interface RawConcept {
	term: string;
	category: ConceptCategory;
	granularity: GranularityLevel;
	explicit_in_source: boolean;
	justification: string;
}

export interface MergedConcept {
	term: string;
	category: ConceptCategory;
	granularity: GranularityLevel;
	explicit_in_source: boolean;
	found_by_models: ProviderId[];
	consensus: Consensus;
	variants: string[];
	justifications?: string[];
	// NIB-M-QC §4.4 : set when the concept was produced by splitting a parent
	// cluster during quality control. Carries the parent term so downstream
	// audits can trace derivation. When present, provenance fields
	// (found_by_models, consensus, justifications) are reset on split because
	// the parent's provenance was about the merged cluster, not each split.
	derived_from?: string;
}

export interface AngleProvenanceEntry {
	consensus: Consensus;
	models: ProviderId[];
}

export interface FinalConcept {
	canonical_term: string;
	variants: string[];
	category: ConceptCategory;
	granularity: GranularityLevel;
	explicit_in_source: boolean;
	angle_provenance: Partial<Record<AngleId, AngleProvenanceEntry>>;
	angles_count: AnglesCount;
	justifications: string[];
	// See MergedConcept.derived_from. On split, angle_provenance is reset to {}
	// and justifications to [] so diagnostics and coverage don't inflate counts
	// on a concept whose provenance is synthetic.
	derived_from?: string;
}

export interface InputFileDescriptor {
	originalName: string;
	normalizedName: string;
	sizeBytes: number;
}

export interface ProcessedInput {
	context: string;
	prompt: string | null;
	inputFiles: InputFileDescriptor[];
}

export interface InputFile {
	name: string;
	content: string;
}

// Exported as `as const` tuple so downstream (e.g. the zod PipelineEventSchema
// in cli/format-event.ts) can derive a runtime enum from the same source of
// truth — adding a phase in one place and forgetting the other would otherwise
// turn legitimate events into "(malformed event skipped)" silently.
export const PIPELINE_PHASES = [
	"input",
	"extraction",
	"fusion_intra",
	"fusion_inter",
	"diagnostics",
	"run",
] as const;
export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

// NIB-M-EVENT-LOGGER §2 — closed union. Every emit must pass one of these ;
// adding a new event type requires amending both NIB-M-EVENT-LOGGER §2 and §4.
export const PIPELINE_EVENT_TYPES = [
	"input_processed",
	"extraction_start",
	"extraction_complete",
	"extraction_error",
	"extraction_progress",
	"concept_dropped",
	"fusion_intra_start",
	"fusion_intra_complete",
	"fusion_inter_start",
	"fusion_inter_complete",
	"control_start",
	"control_complete",
	"control_result",
	"quality_warning",
	"coverage_complete",
	"run_complete",
	"run_error",
	"run_stopped",
] as const;
export type PipelineEventType = (typeof PIPELINE_EVENT_TYPES)[number];

// Events that close the run; the CLI subscriber must receive them before process exit.
export type TerminalEventType = Extract<
	PipelineEventType,
	"run_complete" | "run_error" | "run_stopped"
>;

export interface PipelineEvent {
	timestamp: string;
	phase: PipelinePhase;
	type: PipelineEventType;
	payload: Record<string, unknown>;
}

export type RunStatus = "running" | "completed" | "failed" | "stopped";

// NIB-S-KCE §3.10 : persisted manifest.config shape. Also the runtime shape
// consumed by the pipeline (model IDs for metadata + embedding_threshold for
// fusion-inter). Secrets and endpoints live inside adapter closures, never on
// this object (NIB-S-KCE §3.15).
export interface RunConfig {
	models: Record<ProviderLongId, string>;
	embedding_model: string;
	levenshtein_threshold: number;
	embedding_threshold: number;
}

// Defaults per NIB-S-KCE §3.15 "Defaults" table (subset).
// NOTE: Model version strings are intentionally hardcoded — they serve as
// compile-time defaults when no RunConfig override is provided. Update these
// when the project upgrades its baseline model targets. Runtime overrides
// should be passed through RunConfig (e.g. via CLI flags or web request body).
export const DEFAULT_RUN_CONFIG: RunConfig = {
	models: {
		anthropic: "claude-opus-4-6",
		openai: "gpt-5.4",
		google: "gemini-3.1-pro-preview",
	},
	embedding_model: "text-embedding-3-small",
	levenshtein_threshold: 0.9,
	embedding_threshold: 0.85,
};

// Set on terminal status by finalizeRun. Shape mirrors NIB-S-KCE §3.10.
export interface RunResults {
	total_concepts: number;
	fragile_concepts: number;
	unanimous_concepts: number;
}

export interface RunManifest {
	run_id: string;
	status: RunStatus;
	created_at: string;
	finished_at?: string;
	source: "cli" | "web";
	input_files: string[];
	config: RunConfig;
	results?: RunResults;
	error?: string;
}

export type RunSource = "cli" | "web";

export interface QualityCorrection {
	error_type: "abusive_merge" | "incorrect_categorization" | "justification_incoherence";
	target: string;
	correction: string;
	// NIB-M-QUALITY-CONTROLLER §3 + §4.4: non-null for abusive_merge (≥2 distinct terms, none === target).
	// Validated fail-closed in QC before applyCorrections.
	suggested_split: string[] | null;
	flagged_by: "claude" | "gpt";
	confirmed_by: "claude" | "gpt" | null;
	justification: string;
}

export interface QualityReport {
	review_type: "fusion_quality";
	review_rounds: number;
	errors_flagged: number;
	errors_corrected: number;
	corrections: QualityCorrection[];
}

// NIB-M-RELEVANCE-CONTROLLER §4.3 + NIB-M-LLM-PAYLOADS Types 5/6/7:
// RC wire shapes use `term`/`justification` (QC uses `target`/`reason`).
export interface RelevanceRemoval {
	term: string;
	flagged_by: "claude" | "gpt";
	confirmed_by: "claude" | "gpt" | null;
	justification_flagger: string;
	justification_confirmer: string;
}

export interface RelevanceRetention {
	term: string;
	flagged_by: "claude" | "gpt";
	defended_by: "claude" | "gpt";
	justification_flagger: string;
	counter_argument_defender: string;
	final_decision: string;
}

export interface RelevanceReport {
	review_rounds: number;
	concepts_flagged: number;
	concepts_removed: number;
	concepts_retained_after_dispute: number;
	removed: RelevanceRemoval[];
	retained_after_dispute: RelevanceRetention[];
}

export interface DiagnosticsReport {
	unique_by_angle: Partial<Record<AngleId, number>>;
	unique_by_model: Partial<Record<ProviderId, string[]>>;
	unanimous_concepts: number;
	total_after_inter_angle: number;
	fragile: number;
}

// NIB-S-KCE §3.5 : persisted format of fusion-inter/merged.json.
export interface MergedOutputMetadata {
	models: ProviderId[];
	angles: readonly AngleId[];
	total_passes: number;
	fusion_similarity_threshold: number;
	date: string; // YYYY-MM-DD
}

export interface MergedOutput {
	metadata: MergedOutputMetadata;
	concepts: FinalConcept[];
	diagnostics: DiagnosticsReport | null;
}

// NIB-M-QUALITY-CONTROLLER §2 + NIB-M-RELEVANCE-CONTROLLER §2:
// controllers accept either angle-level MergedConcept[] or inter-angle FinalConcept[].
export type ControllableConcept = MergedConcept | FinalConcept;

export function getTerm(c: ControllableConcept): string {
	return "term" in c ? c.term : c.canonical_term;
}

// Fork a split-derived concept from a parent cluster. Per NIB-M-QC §4.4:
// inherit category, granularity, and explicit_in_source (those hold after
// splitting), but RESET all provenance fields — variants, found_by_models,
// consensus, justifications (MergedConcept) / angle_provenance, angles_count,
// justifications (FinalConcept) were recorded about the merged cluster and
// do not apply to each split piece. Set derived_from so downstream
// (diagnostics, coverage) can treat synthetic concepts honestly.
//
// NOTE on the "1/3" / "1/5" placeholders: Consensus and AnglesCount are
// closed enum types with no "unknown" or "derived" value. A split concept
// has no real provenance (found_by_models is empty), so any placeholder is
// technically a lie — we pick the weakest closed value and rely on
// `derived_from !== undefined` as the true signal. Consumers reading
// consensus/angles_count on derived concepts should defer to derived_from
// (see coverage-verifier.isFragile, diagnostics.ts empty-array guards).
// Widening the enums to carry a "derived" marker is a larger refactor —
// deferred until a reader genuinely needs per-provenance branching.
//
// Naming: `deriveSplit` (not `withTerm`) because the function is NOT a
// generic term-updater — it is the split constructor for NIB-M-QC §4.4,
// and it rewrites provenance. Any new provenance field on MergedConcept /
// FinalConcept MUST be explicitly reset or inherited here.
export function deriveSplit<T extends ControllableConcept>(concept: T, term: string): T {
	if ("term" in concept) {
		const out: MergedConcept = {
			...concept,
			term,
			variants: [term],
			found_by_models: [],
			consensus: "1/3",
			justifications: [],
			derived_from: concept.term,
		};
		return out as T;
	}
	const out: FinalConcept = {
		...concept,
		canonical_term: term,
		variants: [term],
		angle_provenance: {},
		angles_count: "1/5",
		justifications: [],
		derived_from: concept.canonical_term,
	};
	return out as T;
}
