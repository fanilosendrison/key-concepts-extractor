import { join } from "node:path";
import { verifyCoverage } from "./domain/coverage-verifier.js";
import { generateDiagnostics } from "./domain/diagnostics.js";
import { errorMessage, FatalLLMError } from "./domain/errors.js";
import { runExtraction } from "./domain/extraction-orchestrator.js";
import { fuseInterAngle } from "./domain/fusion-inter.js";
import { fuseIntraAngle } from "./domain/fusion-intra.js";
import { processInput } from "./domain/input-processor.js";
import type { EmbeddingAdapter, ProviderAdapter } from "./domain/ports.js";
import { runQualityControl } from "./domain/quality-controller.js";
import { runRelevanceControl } from "./domain/relevance-controller.js";
import {
	CANONICAL_ANGLES,
	CANONICAL_PROVIDERS,
	DEFAULT_RUN_CONFIG,
	type FinalConcept,
	type InputFile,
	type MergedConcept,
	type MergedOutput,
	type PipelineEventType,
	type PipelinePhase,
	type RunConfig,
	type RunSource,
	type TerminalEventType,
} from "./domain/types.js";
import { createEventLogger } from "./infra/event-logger.js";
import { createRunManager, type RunManager } from "./infra/run-manager.js";

export interface PipelineDeps {
	anthropic: ProviderAdapter;
	openai: ProviderAdapter;
	google: ProviderAdapter;
	embeddings: EmbeddingAdapter;
	baseDir: string;
	// NIB-M-WEB-SERVER §2.2 : web server pre-creates the RunManager (for synchronous
	// run_id return in POST /api/runs) then passes it here. CLI path leaves this undefined.
	runManager?: RunManager;
	signal?: AbortSignal | undefined;
	// NIB-M-RUN-MANAGER §4.2 : resolved at startup. Omit to use DEFAULT_RUN_CONFIG
	// (useful for tests where model IDs are irrelevant).
	config?: RunConfig;
	// Identifies the entry point that launched the run (manifest.source).
	// Defaults to "cli" — the web path passes "web" explicitly.
	source?: RunSource;
}

export interface PipelineInput {
	prompt?: string;
	files?: InputFile[];
}

export interface PipelineResult {
	runId: string;
	status: "completed" | "failed" | "stopped";
}

export async function runPipeline(
	input: PipelineInput,
	deps: PipelineDeps,
): Promise<PipelineResult> {
	const runsDir = join(deps.baseDir, "runs");
	const runManager = deps.runManager ?? createRunManager(runsDir);
	const config = deps.config ?? DEFAULT_RUN_CONFIG;
	// initRun is idempotent: safe whether the caller already initialized or not.
	await runManager.initRun(config, deps.source ?? "cli");
	const logger = createEventLogger(runManager.runDir);

	// Fire-and-forget: intermediate events tolerate loss on crash because
	// the pipeline keeps emitting. Terminal events use emitTerminal below.
	const emit = (
		phase: PipelinePhase,
		type: PipelineEventType,
		payload: Record<string, unknown>,
	) => {
		void logger.emit({ phase, type, payload });
	};

	// Terminal events must reach subscribers before the CLI process exits.
	// A failed flush can't shadow the run result, but we MUST surface the
	// failure on stderr — otherwise a logger I/O error (disk full, fd leak)
	// would leave the CLI exiting silently with a non-zero code and no
	// message. The persisted run state is authoritative; stderr is the
	// fallback channel when the subscriber path is broken.
	const emitTerminal = async (
		type: TerminalEventType,
		payload: Record<string, unknown>,
	): Promise<void> => {
		try {
			await logger.emit({ phase: "run", type, payload });
		} catch (err) {
			// logger.emit appendFile + dispatch to subscribers — a throw here
			// means persistence (or serialization) failed and the subscriber
			// path never fired. Wrap console.error too: on a piped stderr
			// whose reader died (EPIPE), a throw here would shadow the run
			// result and leak as an unhandled rejection.
			try {
				console.error(
					`[emit-terminal] event emission failed for ${type} (subscribers not notified): ${errorMessage(err)}`,
				);
			} catch {
				// stderr closed or full — nothing left to do; run state is authoritative.
			}
		}
	};

	const checkSignal = (): boolean => deps.signal?.aborted === true;

	const stopRunEarly = async (): Promise<PipelineResult> => {
		await runManager.stopRun();
		await emitTerminal("run_stopped", { reason: "user_requested" });
		return { runId: runManager.runId, status: "stopped" };
	};

	try {
		// Phase 1 — Input processing
		const processed = processInput({
			...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
			...(input.files !== undefined ? { files: input.files } : {}),
		});
		emit("input", "input_processed", {
			files: processed.inputFiles.length,
			prompt: processed.prompt ? "provided" : "none",
		});
		if (processed.prompt) await runManager.persistPromptFile(processed.prompt);
		for (let i = 0; i < processed.inputFiles.length; i++) {
			const meta = processed.inputFiles[i];
			const original = input.files?.[i];
			if (meta && original) {
				await runManager.persistInputFile(meta.normalizedName, original.content);
			}
		}
		await runManager.setInputFiles(processed.inputFiles.map((f) => f.normalizedName));

		if (checkSignal()) return stopRunEarly();

		// Phase 2 — Extraction
		const extractionPasses = await runExtraction(processed.context, {
			adapters: {
				anthropic: deps.anthropic,
				openai: deps.openai,
				google: deps.google,
			},
			onPass: async (pass) =>
				runManager.persistExtractionPass(pass.angle, pass.provider, pass.concepts),
			emit: (type, payload) => emit("extraction", type, payload),
			signal: deps.signal,
		});

		if (checkSignal()) return stopRunEarly();

		// Phase 3 — Fusion intra-angle + controls
		const intraResults: Array<{
			angle: (typeof CANONICAL_ANGLES)[number];
			concepts: MergedConcept[];
		}> = [];
		for (const angle of CANONICAL_ANGLES) {
			const anglePasses = extractionPasses.filter((p) => p.angle === angle);
			const passesByProvider: Parameters<typeof fuseIntraAngle>[0]["passes"] = {};
			for (const pass of anglePasses) passesByProvider[pass.provider] = pass.concepts;

			let concepts = fuseIntraAngle({ angle, passes: passesByProvider });
			emit("fusion_intra", "fusion_intra_complete", { angle, count: concepts.length });

			const quality = await runQualityControl({
				mergedList: concepts,
				context: processed.context,
				scope: `angle:${angle}`,
				anthropic: deps.anthropic,
				openai: deps.openai,
				emit: (type, payload) => emit("fusion_intra", type, payload),
				signal: deps.signal,
			});
			concepts = quality.correctedList;
			await runManager.persistIntraAngle(angle, concepts);
			await runManager.persistIntraAngleQuality(angle, quality.report);

			const relevance = await runRelevanceControl({
				mergedList: concepts,
				context: processed.context,
				scope: `angle:${angle}`,
				anthropic: deps.anthropic,
				openai: deps.openai,
				emit: (type, payload) => emit("fusion_intra", type, payload),
				signal: deps.signal,
			});
			concepts = relevance.filteredList;
			await runManager.persistIntraAngleRelevance(angle, relevance.report);

			intraResults.push({ angle, concepts });
		}

		if (checkSignal()) return stopRunEarly();

		// Phase 4 — Fusion inter-angle + controls
		const byAngle: Parameters<typeof fuseInterAngle>[0]["byAngle"] = {};
		for (const r of intraResults) byAngle[r.angle] = r.concepts;

		let finalConcepts: FinalConcept[] = await fuseInterAngle({
			byAngle,
			embeddings: deps.embeddings,
			embeddingThreshold: config.embedding_threshold,
			signal: deps.signal,
		});
		emit("fusion_inter", "fusion_inter_complete", { count: finalConcepts.length });

		const interQuality = await runQualityControl<FinalConcept>({
			mergedList: finalConcepts,
			context: processed.context,
			scope: "inter_angle",
			anthropic: deps.anthropic,
			openai: deps.openai,
			emit: (type, payload) => emit("fusion_inter", type, payload),
			signal: deps.signal,
		});
		finalConcepts = interQuality.correctedList;

		const interRelevance = await runRelevanceControl<FinalConcept>({
			mergedList: finalConcepts,
			context: processed.context,
			scope: "inter_angle",
			anthropic: deps.anthropic,
			openai: deps.openai,
			emit: (type, payload) => emit("fusion_inter", type, payload),
			signal: deps.signal,
		});
		finalConcepts = interRelevance.filteredList;

		// NIB-S-KCE §3.5 : persist MergedOutput wrapper with metadata; diagnostics is null
		// here and filled in the 2-pass write performed by persistDiagnostics below.
		const mergedOutput: MergedOutput = {
			metadata: {
				// NIB-M-RUN-MANAGER §4.5c : short provider IDs for metadata.models per
				// spec §3.14. The resolved model IDs (claude-opus-4-6 etc.) live on
				// manifest.config.models, not here.
				models: [...CANONICAL_PROVIDERS],
				angles: CANONICAL_ANGLES,
				total_passes: CANONICAL_ANGLES.length * CANONICAL_PROVIDERS.length,
				fusion_similarity_threshold: config.embedding_threshold,
				date: new Date().toISOString().slice(0, 10),
			},
			concepts: finalConcepts,
			diagnostics: null,
		};
		await runManager.persistInterAngle(mergedOutput);
		await runManager.persistInterAngleQuality(interQuality.report);
		await runManager.persistInterAngleRelevance(interRelevance.report);

		// Phase 5 — Coverage
		const coverage = verifyCoverage({
			concepts: finalConcepts,
			sourceText: processed.context,
		});
		emit("diagnostics", "coverage_complete", { ...coverage.stats });

		// Phase 6 — Diagnostics
		const diagnostics = generateDiagnostics({
			concepts: coverage.concepts,
			fragile: coverage.stats.fragile,
		});
		await runManager.persistDiagnostics(diagnostics);

		await runManager.finalizeRun({
			total_concepts: coverage.concepts.length,
			fragile_concepts: coverage.stats.fragile,
			unanimous_concepts: diagnostics.unanimous_concepts,
		});
		await emitTerminal("run_complete", {
			total_concepts: coverage.concepts.length,
			run_dir: runManager.runDir,
		});

		return { runId: runManager.runId, status: "completed" };
	} catch (error) {
		// If the signal was aborted (graceful stop), record as stopped rather than failed
		if (deps.signal?.aborted) return stopRunEarly();
		const isFatal = error instanceof FatalLLMError;
		await runManager.failRun(error instanceof Error ? error : new Error(String(error)));
		await emitTerminal("run_error", {
			error: errorMessage(error),
			fatal: isFatal,
		});
		return { runId: runManager.runId, status: "failed" };
	}
}
