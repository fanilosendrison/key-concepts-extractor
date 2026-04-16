import { FatalLLMError, TransientLLMError } from "../domain/errors.js";
import type { ProviderLongId } from "../domain/types.js";

export interface ProviderAdapterConfig {
	apiKey: string;
	model: string;
	endpoint?: string;
}

export const TIMEOUT_MS = 600_000;
// Embeddings are a single fast call (1-3s typical for batches up to 100
// texts, which is the per-request cap set by DC-OPENAI-EMBEDDINGS §5).
// 60s covers worst-case congestion without hiding a hang — 600s would.
export const TIMEOUT_MS_EMBEDDING = 60_000;
export const MAX_RETRIES = 3;
export const BACKOFF_MS = [5000, 15000, 45000] as const;
// Total wallclock ceiling per call. Retries exist to recover from transient
// failures (429/503/parse); if we've already burned two full timeouts, the
// model is too slow and further retries waste wallclock. Caps worst case
// from 41 min (4 × TIMEOUT + backoff) to ~20 min.
export const MAX_TOTAL_DURATION_MS = TIMEOUT_MS * 2;
// Same 2× invariant, scaled to the embedding profile.
export const MAX_TOTAL_DURATION_MS_EMBEDDING = TIMEOUT_MS_EMBEDDING * 2;

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
// Both cancel the fetch — whichever fires first. `timeoutMs` allows callers
// with different latency profiles (embeddings vs. generative LLMs) to pick
// a bound proportional to expected duration rather than inheriting 600s.
export function composeSignal(external?: AbortSignal, timeoutMs: number = TIMEOUT_MS): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
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

export interface RunWithRetryOptions {
	signal?: AbortSignal | undefined;
	// Override of the total wallclock budget — test-only. Production uses the default.
	maxTotalDurationMs?: number | undefined;
}

export async function runWithRetry(
	provider: ProviderLongId,
	callOnce: () => Promise<string>,
	options: RunWithRetryOptions = {},
): Promise<{ content: string; latencyMs: number }> {
	const { signal } = options;
	const maxTotalDurationMs = options.maxTotalDurationMs ?? MAX_TOTAL_DURATION_MS;
	// Reject NaN / Infinity / negative up front — silently clamping would hide
	// configuration bugs and produce nonsense messages downstream. Fatal because
	// it's a programmer error: no retry will un-break a bad config value.
	if (!Number.isFinite(maxTotalDurationMs) || maxTotalDurationMs < 0) {
		throw new FatalLLMError(
			`runWithRetry: maxTotalDurationMs must be a non-negative finite number, got ${maxTotalDurationMs}`,
		);
	}
	let lastError: unknown;
	const startedAt = Date.now();
	// The budget only gates retries (attempt > 0). The first attempt always
	// runs — a wallclock budget of 0 still authorises one call, not zero.
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw signal.reason ?? new Error("aborted");
		if (attempt > 0) {
			// Budget check before sleeping — refuse to burn more time on a call
			// that has already consumed its wallclock ceiling.
			if (Date.now() - startedAt >= maxTotalDurationMs) {
				throw new FatalLLMError(
					`Provider ${provider} exceeded total wallclock budget of ${maxTotalDurationMs}ms after ${attempt} attempts`,
				);
			}
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
