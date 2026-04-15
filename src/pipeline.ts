import { join } from "node:path";
import { verifyCoverage } from "./domain/coverage-verifier.js";
import { generateDiagnostics } from "./domain/diagnostics.js";
import { FatalLLMError } from "./domain/errors.js";
import { runExtraction } from "./domain/extraction-orchestrator.js";
import { fuseInterAngle } from "./domain/fusion-inter.js";
import { fuseIntraAngle } from "./domain/fusion-intra.js";
import { processInput } from "./domain/input-processor.js";
import type { EmbeddingAdapter, ProviderAdapter } from "./domain/ports.js";
import { runQualityControl } from "./domain/quality-controller.js";
import { runRelevanceControl } from "./domain/relevance-controller.js";
import {
	CANONICAL_ANGLES,
	type FinalConcept,
	type InputFile,
	type MergedConcept,
	type PipelinePhase,
} from "./domain/types.js";
import { createEventLogger } from "./infra/event-logger.js";
import { createRunManager } from "./infra/run-manager.js";

export interface PipelineDeps {
	anthropic: ProviderAdapter;
	openai: ProviderAdapter;
	google: ProviderAdapter;
	embeddings: EmbeddingAdapter;
	baseDir: string;
	signal?: AbortSignal | undefined;
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
	const runManager = createRunManager(runsDir);
	await runManager.initRun();
	const logger = createEventLogger(runManager.runDir);

	const emit = (phase: PipelinePhase, type: string, payload: Record<string, unknown>) => {
		void logger.emit({ phase, type, payload });
	};

	const checkSignal = (): boolean => deps.signal?.aborted === true;

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

		if (checkSignal()) {
			await runManager.stopRun();
			emit("run", "run_stopped", { reason: "user_requested" });
			return { runId: runManager.runId, status: "stopped" };
		}

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

		if (checkSignal()) {
			await runManager.stopRun();
			emit("run", "run_stopped", { reason: "user_requested" });
			return { runId: runManager.runId, status: "stopped" };
		}

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
			});
			concepts = relevance.filteredList;
			await runManager.persistIntraAngleRelevance(angle, relevance.report);

			intraResults.push({ angle, concepts });
		}

		if (checkSignal()) {
			await runManager.stopRun();
			emit("run", "run_stopped", { reason: "user_requested" });
			return { runId: runManager.runId, status: "stopped" };
		}

		// Phase 4 — Fusion inter-angle + controls
		const byAngle: Parameters<typeof fuseInterAngle>[0]["byAngle"] = {};
		for (const r of intraResults) byAngle[r.angle] = r.concepts;

		let finalConcepts: FinalConcept[] = await fuseInterAngle({
			byAngle,
			embeddings: deps.embeddings,
		});
		emit("fusion_inter", "fusion_inter_complete", { count: finalConcepts.length });

		const interQuality = await runQualityControl({
			mergedList: finalConcepts as unknown as MergedConcept[],
			context: processed.context,
			scope: "inter_angle",
			anthropic: deps.anthropic,
			openai: deps.openai,
			emit: (type, payload) => emit("fusion_inter", type, payload),
		});
		finalConcepts = interQuality.correctedList as unknown as FinalConcept[];

		const interRelevance = await runRelevanceControl({
			mergedList: finalConcepts as unknown as MergedConcept[],
			context: processed.context,
			scope: "inter_angle",
			anthropic: deps.anthropic,
			openai: deps.openai,
			emit: (type, payload) => emit("fusion_inter", type, payload),
		});
		finalConcepts = interRelevance.filteredList as unknown as FinalConcept[];

		await runManager.persistInterAngle(finalConcepts);
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
		emit("run", "run_complete", {
			total_concepts: coverage.concepts.length,
			run_dir: runManager.runDir,
		});

		return { runId: runManager.runId, status: "completed" };
	} catch (error) {
		// If the signal was aborted (graceful stop), record as stopped rather than failed
		if (deps.signal?.aborted) {
			await runManager.stopRun();
			emit("run", "run_stopped", { reason: "user_requested" });
			return { runId: runManager.runId, status: "stopped" };
		}
		const isFatal = error instanceof FatalLLMError;
		await runManager.failRun(error instanceof Error ? error : new Error(String(error)));
		emit("run", "run_error", {
			error: error instanceof Error ? error.message : String(error),
			fatal: isFatal,
		});
		return { runId: runManager.runId, status: "failed" };
	}
}
