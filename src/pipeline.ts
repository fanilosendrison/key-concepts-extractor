import type { EmbeddingAdapter, ProviderAdapter } from "./domain/ports.js";
import type { InputFile } from "./domain/types.js";

export interface PipelineDeps {
  anthropic: ProviderAdapter;
  openai: ProviderAdapter;
  google: ProviderAdapter;
  embeddings: EmbeddingAdapter;
  baseDir: string;
  signal?: AbortSignal;
}

export interface PipelineInput {
  prompt?: string;
  files?: InputFile[];
}

export interface PipelineResult {
  runId: string;
  status: "completed" | "failed" | "stopped";
}

export function runPipeline(
  _input: PipelineInput,
  _deps: PipelineDeps,
): Promise<PipelineResult> {
  throw new Error("Not implemented");
}
