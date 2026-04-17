import { errorMessage, FatalLLMError, TransientLLMError } from "../domain/errors.js";
import type { ProviderLongId } from "../domain/types.js";

export interface ProviderAdapterConfig {
	apiKey: string;
	model: string;
	endpoint?: string;
}

// Centralised wire endpoints per provider. Values are normative per
// NIB-S-KCE §config-defaults and the DC-* specs (DC-ANTHROPIC §0,
// DC-OPENAI §0, DC-OPENAI-EMBEDDINGS §0, DC-GOOGLE-GEMINI §0). Adapters
// override only when the caller injects a custom base URL (e.g. a mock
// server in tests). Keeping the table here makes a future endpoint
// rotation a one-line change instead of a four-file scatter, and ties
// the URL to the same ProviderLongId enum used throughout the pipeline.
// Module-local on purpose: callers go through `resolveEndpoint`, which
// also guards against the empty-string foot-gun below.
const DEFAULT_ENDPOINTS: Record<ProviderLongId, string> = {
	anthropic: "https://api.anthropic.com",
	openai: "https://api.openai.com",
	google: "https://generativelanguage.googleapis.com",
};

export function resolveEndpoint(provider: ProviderLongId, override?: string): string {
	// Empty string is a config bug, not an intent-to-override. Passing it
	// through would produce a relative URL at the fetch layer with an opaque
	// "Invalid URL" instead of the spec-aligned fatal we emit elsewhere.
	if (override !== undefined && override.length === 0) {
		throw new FatalLLMError(
			`resolveEndpoint: endpoint override for ${provider} must be a non-empty URL, got ""`,
		);
	}
	return override ?? DEFAULT_ENDPOINTS[provider];
}

// Config-value guards. Fatal on failure — it's a programmer error and no
// retry can un-break a bad config value. All use the convention
// `assertFoo("fnName: paramName", value)` so the thrown message carries the
// origin and the field name together. The shared `assertNumberMs` funnels
// the throw so adding a third guard is one line and stays on-convention.
function assertNumberMs(
	name: string,
	value: number,
	isValid: (n: number) => boolean,
	constraint: string,
): void {
	if (!isValid(value)) {
		throw new FatalLLMError(`${name} must be ${constraint}, got ${value}`);
	}
}

// Reject NaN / Infinity / non-positive / non-integer. AbortSignal.timeout
// truncates floats via ToUint32, so 0.5 silently becomes 0 (already-aborted).
/** @param name Caller identifier in the form "functionName: paramName" (used in thrown error message). */
function assertPositiveIntegerMs(name: string, value: number): void {
	assertNumberMs(name, value, (n) => Number.isInteger(n) && n > 0, "a positive integer");
}

// Reject NaN / Infinity / negative. Zero IS allowed (used by T-PS-07 to force
// an immediate budget trip on attempt > 0).
/** @param name Caller identifier in the form "functionName: paramName" (used in thrown error message). */
function assertNonNegativeFiniteMs(name: string, value: number): void {
	assertNumberMs(name, value, (n) => Number.isFinite(n) && n >= 0, "a non-negative finite number");
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
// Global ceiling for a full multi-batch `embed()` operation. Per-batch budget
// still applies; this protects against a runaway (thousands of concepts) where
// each batch could legitimately consume its full 120s. 5× per-batch budget =
// 600s total, which covers ~5 batches under worst-case congestion or hundreds
// of batches at nominal 1-3s each.
export const MAX_OPERATION_DURATION_MS_EMBEDDING = MAX_TOTAL_DURATION_MS_EMBEDDING * 5;

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
	assertPositiveIntegerMs("composeSignal: timeoutMs", timeoutMs);
	const timeout = AbortSignal.timeout(timeoutMs);
	return external ? AbortSignal.any([timeout, external]) : timeout;
}

function isNonRetriableHttpStatus(status: number): boolean {
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
	assertNonNegativeFiniteMs("runWithRetry: maxTotalDurationMs", maxTotalDurationMs);
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
			// Only external cancellation is terminal here. A per-attempt timeout
			// (AbortSignal.timeout fires while signal?.aborted === false) falls
			// through to the transient branch below and retries — aligned with
			// NIB-M-PROVIDER-ADAPTERS. The global wallclock ceiling
			// (maxTotalDurationMs, defaults to MAX_TOTAL_DURATION_MS = 2×TIMEOUT)
			// caps retry divergence so a pathologically slow model can't loop.
			if (isAbortError(err) && signal?.aborted) throw err;
			if (!(err instanceof TransientLLMError)) {
				lastError = new TransientLLMError(errorMessage(err));
			}
		}
	}
	throw new FatalLLMError(
		`Provider ${provider} failed after ${MAX_RETRIES} retries: ${errorMessage(lastError)}`,
	);
}

// Per-provider wire-spec mapping of finish_reason enum values. Each adapter
// declares the two terminal values at its call-site, keeping the wire contract
// declarative and co-located with the fetch shape. DC-OPENAI §5 and
// DC-GOOGLE-GEMINI §5 define the enums; both split into truncation (retriable
// per spec — model may succeed on retry) and safety filter rejection (fatal —
// the provider's safety layer will reject the same content on retry).
// Generic so adapters can opt into compile-time typo protection on mapping
// values by parameterising with their wire-spec enum (e.g. via `satisfies
// FinishReasonMapping<GeminiFinishReason>` at the call site). Default `string`
// preserves the loose behaviour for adapters that still type reason as string.
export interface FinishReasonMapping<T extends string = string> {
	readonly truncation: T;
	readonly safety: T;
}

// Error message format is stable: `Provider <id> <kind> (finish_reason=<value>)`.
// The `(finish_reason=<value>)` suffix is a log-correlation contract operators
// may grep. Provider id is the canonical lowercase ProviderLongId so messages
// stay consistent with runWithRetry's "Provider <id> ..." format.
export function checkFinishReason(
	provider: ProviderLongId,
	reason: string | undefined,
	mapping: FinishReasonMapping,
): void {
	// Wire responses sometimes omit finish_reason despite the schema. Treat as
	// transient — a retry may bring back a complete response. Silent pass-through
	// here would let runWithRetry's JSON.parse guard misattribute the failure.
	if (!reason) {
		throw new TransientLLMError(`Provider ${provider} response missing finish_reason`);
	}
	if (reason === mapping.truncation) {
		throw new TransientLLMError(`Provider ${provider} output truncated (finish_reason=${reason})`);
	}
	if (reason === mapping.safety) {
		throw new FatalLLMError(
			`Provider ${provider} safety filter rejected content (finish_reason=${reason})`,
		);
	}
}

export function classifyHttp(status: number, bodyText: string): Error {
	const msg = `HTTP ${status}: ${bodyText.slice(0, 200)}`;
	if (isNonRetriableHttpStatus(status)) return new FatalLLMError(msg);
	// Retriable (429/503/5xx) and unrecognised (e.g. 408, 422) both fall through
	// to transient — recognised-retriable and "unknown" share the same handling.
	return new TransientLLMError(msg);
}
