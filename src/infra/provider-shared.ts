import { FatalLLMError, TransientLLMError } from "../domain/errors.js";
import type { ProviderLongId } from "../domain/types.js";

export interface ProviderAdapterConfig {
	apiKey: string;
	model: string;
	endpoint?: string;
}

export const TIMEOUT_MS = 300_000;
export const MAX_RETRIES = 3;
export const BACKOFF_MS = [5000, 15000, 45000] as const;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(signal?.reason ?? new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// Compose a per-attempt timeout with an external caller-provided signal.
// Both cancel the fetch — whichever fires first.
export function composeSignal(external?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	return external ? AbortSignal.any([timeout, external]) : timeout;
}

export function isRetriableHttpStatus(status: number): boolean {
	return status === 429 || status === 503 || (status >= 500 && status <= 599);
}

export function isNonRetriableHttpStatus(status: number): boolean {
	return status === 400 || status === 401 || status === 403 || status === 404;
}

// AbortError from fetch — surfaces as DOMException with name "AbortError" or
// TimeoutError from AbortSignal.timeout. Either way, non-retriable: rethrow immediately.
function isAbortError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return err.name === "AbortError" || err.name === "TimeoutError";
}

export async function runWithRetry(
	provider: ProviderLongId,
	callOnce: () => Promise<string>,
	signal?: AbortSignal,
): Promise<{ content: string; latencyMs: number }> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw signal.reason ?? new Error("aborted");
		if (attempt > 0) {
			const delay = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 45000;
			// Interruptible: external abort rejects sleep and stops retry.
			await sleep(delay, signal);
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
			// External cancel (or per-attempt timeout) is terminal — do not burn retries on it.
			if (isAbortError(err) && signal?.aborted) throw err;
			if (!(err instanceof TransientLLMError)) {
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
