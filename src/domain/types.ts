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

export type PipelinePhase =
	| "input"
	| "extraction"
	| "fusion_intra"
	| "fusion_inter"
	| "diagnostics"
	| "run";

export interface PipelineEvent {
	timestamp: string;
	phase: PipelinePhase;
	type: string;
	payload: Record<string, unknown>;
}

export type RunStatus = "running" | "completed" | "failed" | "stopped";

// NIB-M-RUN-MANAGER §4.2 : persisted manifest.config shape. Also the runtime
// shape consumed by the pipeline (model IDs for metadata + embedding_threshold
// for fusion-inter). API keys and endpoints live on provider adapters, not here.
// NB: spec §3.10 reads `Record<ProviderId, string>` ; spec example §4.2 uses
// long IDs as keys ('anthropic'/'openai'/'google') — we follow the example.
export interface RunConfig {
	models: Record<ProviderLongId, string>;
	embedding_model: string;
	levenshtein_threshold: number;
	embedding_threshold: number;
}

// Defaults per NIB-S-KCE §3.15 "Defaults" table (subset).
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

export interface RelevanceRemoval {
	target: string;
	reason: string;
	flagged_by: "claude" | "gpt";
	confirmed_by: "claude" | "gpt" | null;
}

export interface RelevanceRetention {
	target: string;
	defense: string;
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

export function withTerm<T extends ControllableConcept>(concept: T, term: string): T {
	if ("term" in concept) {
		return { ...concept, term, variants: [term] };
	}
	return { ...concept, canonical_term: term, variants: [term] };
}
