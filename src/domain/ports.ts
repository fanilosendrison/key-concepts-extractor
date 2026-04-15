import type { ProviderLongId } from "./types.js";

export interface LLMRequest {
  systemPrompt: string;
  userPrompt: string;
  provider: ProviderLongId;
}

export interface LLMResponse {
  content: string;
  provider: ProviderLongId;
  model: string;
  latencyMs: number;
}

export interface ProviderAdapter {
  readonly provider: ProviderLongId;
  call(request: LLMRequest): Promise<LLMResponse>;
}

export interface EmbeddingAdapter {
  embed(texts: string[]): Promise<number[][]>;
}
