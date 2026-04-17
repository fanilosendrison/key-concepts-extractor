import { describe, expect, it, vi } from "vitest";
import { FatalLLMError, TransientLLMError } from "../src/domain/errors.js";
import {
	composeSignal,
	resolveEndpoint,
	runWithRetry,
	sleep,
} from "../src/infra/provider-shared.js";

describe("provider-shared cancellation (NIB-M-PROVIDER-ADAPTERS)", () => {
	describe("composeSignal", () => {
		it("T-PS-01: external abort propagates to composed signal", () => {
			const external = new AbortController();
			const composed = composeSignal(external.signal);
			expect(composed.aborted).toBe(false);
			external.abort(new Error("user stop"));
			expect(composed.aborted).toBe(true);
		});

		it("T-PS-02: no external signal → composed is purely the timeout signal", () => {
			const composed = composeSignal();
			expect(composed.aborted).toBe(false);
			// Only assertion we can make without waiting TIMEOUT_MS : it's an AbortSignal.
			expect(composed).toBeInstanceOf(AbortSignal);
		});

		it("T-PS-11: default timeoutMs (TIMEOUT_MS) is accepted by the guard", () => {
			// Positive control for T-PS-10 — verifies the validation allows the
			// nominal case. If TIMEOUT_MS ever becomes invalid per the guard,
			// this test fails loudly instead of every production call breaking.
			expect(() => composeSignal()).not.toThrow();
			expect(() => composeSignal(undefined, 1)).not.toThrow();
		});

		it("T-PS-12: short valid timeoutMs actually fires, aborting with TimeoutError", async () => {
			// T-PS-10 covers invalid timeouts; T-PS-11 covers the default case.
			// Neither exercises a SHORT VALID timeout end-to-end. Without this,
			// a future regression (e.g. composeSignal silently swallowing the
			// timeout signal in the AbortSignal.any composition) would slip
			// through the suite. Use vi.waitFor instead of a fixed setTimeout
			// because Node's timer resolution can reach 4-16ms on macOS under
			// load — a hardcoded slack would flake on busy CI.
			const composed = composeSignal(undefined, 10);
			expect(composed.aborted).toBe(false);
			await vi.waitFor(() => expect(composed.aborted).toBe(true), {
				timeout: 1000,
				interval: 5,
			});
			expect((composed.reason as Error | undefined)?.name).toBe("TimeoutError");
		});

		it("T-PS-10: rejects NaN / ≤0 / ±Infinity / non-integer timeoutMs", () => {
			// AbortSignal.timeout(0) fires immediately and floats get truncated
			// via ToUint32 — 0.5 would silently become 0. Guard all invalid shapes.
			const bads = [
				Number.NaN,
				0,
				-1,
				Number.POSITIVE_INFINITY,
				Number.NEGATIVE_INFINITY,
				0.5,
				1.9,
			];
			for (const bad of bads) {
				expect(() => composeSignal(undefined, bad)).toThrow(/must be a positive integer/);
			}
		});
	});

	describe("sleep", () => {
		it("T-PS-03: rejects immediately when signal is already aborted", async () => {
			const ac = new AbortController();
			ac.abort(new Error("pre-aborted"));
			await expect(sleep(10_000, ac.signal)).rejects.toThrow("pre-aborted");
		});

		it("T-PS-04: rejects when signal aborts during wait (no leak past abort)", async () => {
			const ac = new AbortController();
			setTimeout(() => ac.abort(new Error("mid-sleep abort")), 20);
			const started = Date.now();
			await expect(sleep(10_000, ac.signal)).rejects.toThrow("mid-sleep abort");
			// Must reject well before the full sleep would elapse.
			expect(Date.now() - started).toBeLessThan(500);
		});
	});

	describe("runWithRetry", () => {
		it("T-PS-05: abort during backoff halts retries — callOnce invoked once only", async () => {
			const ac = new AbortController();
			let calls = 0;
			const callOnce = async () => {
				calls += 1;
				throw new TransientLLMError("fail once");
			};
			// Abort shortly after the first failure, while sleep(5000) is waiting.
			setTimeout(() => ac.abort(new Error("user cancel")), 20);
			await expect(runWithRetry("anthropic", callOnce, { signal: ac.signal })).rejects.toThrow(
				"user cancel",
			);
			expect(calls).toBe(1);
		});

		it("T-PS-06: pre-aborted signal rejects before first attempt", async () => {
			const ac = new AbortController();
			ac.abort(new Error("before-start"));
			let calls = 0;
			const callOnce = async () => {
				calls += 1;
				return '"ok"';
			};
			await expect(runWithRetry("openai", callOnce, { signal: ac.signal })).rejects.toThrow(
				"before-start",
			);
			expect(calls).toBe(0);
		});

		it("T-PS-07: wallclock budget exhausted — fails with distinct message, skips remaining retries", async () => {
			// Budget = 0ms forces the budget check to trip at the start of
			// attempt 1 (elapsed > 0). The error MUST carry the budget-specific
			// message so we distinguish it from the retries-exhausted fatal
			// (which would show `calls === MAX_RETRIES + 1 === 4`, not 1).
			let calls = 0;
			const callOnce = async () => {
				calls += 1;
				throw new TransientLLMError("fail");
			};
			await expect(runWithRetry("anthropic", callOnce, { maxTotalDurationMs: 0 })).rejects.toThrow(
				/exceeded total wallclock budget/,
			);
			expect(calls).toBe(1);
		});

		it("T-PS-08: generous budget allows the full retry sequence", async () => {
			// Positive control for T-PS-07 : with a large budget, a fast-throwing
			// callOnce should walk through MAX_RETRIES + 1 = 4 attempts and fail
			// with retries-exhausted, not with the budget message.
			let calls = 0;
			const callOnce = async () => {
				calls += 1;
				throw new TransientLLMError("fail");
			};
			await expect(
				runWithRetry("anthropic", callOnce, { maxTotalDurationMs: 10 * 60_000 }),
			).rejects.toThrow(/failed after \d+ retries/);
			expect(calls).toBe(4);
		}, 90_000); // allow the 5s+15s+45s real backoff sequence

		it("T-PS-09: rejects NaN / negative / ±Infinity budgets up front, before any call", async () => {
			// "Up front" = callOnce is NEVER invoked for an invalid budget. This
			// locks the contract — if the validation ever migrates past attempt 1,
			// `calls > 0` would break this test.
			const bads = [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
			for (const bad of bads) {
				let calls = 0;
				const callOnce = async () => {
					calls += 1;
					return '"ok"';
				};
				await expect(
					runWithRetry("anthropic", callOnce, { maxTotalDurationMs: bad }),
				).rejects.toThrow(/must be a non-negative finite number/);
				expect(calls).toBe(0);
			}
		});
	});

	describe("resolveEndpoint", () => {
		// These literals are load-bearing per NIB-S-KCE §config-defaults +
		// the DC-* wire contracts. A typo in provider-shared.ts would ship
		// silently until an integration call fails — lock them here.
		it.each([
			["anthropic" as const, "https://api.anthropic.com"],
			["openai" as const, "https://api.openai.com"],
			["google" as const, "https://generativelanguage.googleapis.com"],
		])("T-PS-13: default endpoint for %s matches the normative URL", (provider, url) => {
			expect(resolveEndpoint(provider)).toBe(url);
		});

		it("T-PS-14: a non-empty override wins over the default", () => {
			expect(resolveEndpoint("openai", "http://localhost:1234")).toBe("http://localhost:1234");
		});

		it("T-PS-15: empty-string override is a FatalLLMError, not a silent passthrough", () => {
			// `??` would accept `""`, producing a relative URL at the fetch layer.
			// Guard ensures callers surface config bugs loudly, aligned with the
			// file-wide convention for other programmer-error cases.
			expect(() => resolveEndpoint("openai", "")).toThrow(FatalLLMError);
			expect(() => resolveEndpoint("openai", "")).toThrow(/must be a non-empty URL/);
		});
	});
});
