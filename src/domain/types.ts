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

// TODO: resserrer en union littérale depuis NIB-S §3 en GREEN
export type ConceptCategory = string;
export type GranularityLevel = string;

export interface RawConcept {
	term: string;
	category: ConceptCategory;
	explicit_in_source: boolean;
	justification?: string;
}

export interface MergedConcept {
	term: string;
	category: ConceptCategory;
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

export interface RunManifest {
	run_id: string;
	status: RunStatus;
	created_at: string;
	finished_at?: string;
	results?: Record<string, unknown>;
	error?: string;
}

export interface QualityCorrection {
	error_type: "abusive_merge" | "incorrect_categorization" | "justification_incoherence";
	target: string;
	correction: string;
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
