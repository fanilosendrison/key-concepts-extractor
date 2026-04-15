import { FatalLLMError, TransientLLMError } from "../domain/errors.js";
import type { ProviderLongId } from "../domain/types.js";

export interface ProviderAdapterConfig {
	apiKey: string;
	model: string;
	endpoint?: string;
}

export const TIMEOUT_MS = 120_000;
export const MAX_RETRIES = 3;
export const BACKOFF_MS = [5000, 15000, 45000] as const;

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetriableHttpStatus(status: number): boolean {
	return status === 429 || status === 503 || (status >= 500 && status <= 599);
}

export function isNonRetriableHttpStatus(status: number): boolean {
	return status === 400 || status === 401 || status === 403 || status === 404;
}

export async function runWithRetry(
	provider: ProviderLongId,
	callOnce: () => Promise<string>,
): Promise<{ content: string; latencyMs: number }> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			const delay = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 45000;
			await sleep(delay);
		}
		try {
			const start = Date.now();
			const content = await callOnce();
			// Validate JSON-parseability (ProviderAdapter contract §4.2)
			try {
				JSON.parse(content);
			} catch {
				throw new TransientLLMError(`Invalid JSON from ${provider}`);
			}
			return { content, latencyMs: Date.now() - start };
		} catch (err) {
			lastError = err;
			if (err instanceof FatalLLMError) throw err;
			if (!(err instanceof TransientLLMError)) {
				// Unknown: treat as transient but wrap
				lastError = new TransientLLMError(err instanceof Error ? err.message : String(err));
			}
		}
	}
	throw new FatalLLMError(
		`Provider ${provider} failed after ${MAX_RETRIES} retries: ${
			lastError instanceof Error ? lastError.message : String(lastError)
		}`,
	);
}

export function classifyHttp(status: number, bodyText: string): Error {
	if (isNonRetriableHttpStatus(status)) {
		return new FatalLLMError(`HTTP ${status}: ${bodyText.slice(0, 200)}`);
	}
	if (isRetriableHttpStatus(status)) {
		return new TransientLLMError(`HTTP ${status}: ${bodyText.slice(0, 200)}`);
	}
	return new TransientLLMError(`HTTP ${status}: ${bodyText.slice(0, 200)}`);
}
