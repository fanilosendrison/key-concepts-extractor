import { describe, expect, it } from "vitest";
import { TransientLLMError } from "../src/domain/errors.js";
import { composeSignal, runWithRetry, sleep } from "../src/infra/provider-shared.js";

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
			// Only assertion we can make without waiting 120s : it's an AbortSignal.
			expect(composed).toBeInstanceOf(AbortSignal);
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
			await expect(runWithRetry("anthropic", callOnce, ac.signal)).rejects.toThrow("user cancel");
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
			await expect(runWithRetry("openai", callOnce, ac.signal)).rejects.toThrow("before-start");
			expect(calls).toBe(0);
		});
	});
});
