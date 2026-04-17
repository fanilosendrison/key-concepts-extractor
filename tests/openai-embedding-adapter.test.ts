import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAIEmbeddingAdapter } from "../src/infra/openai-embedding-adapter.js";

describe("createOpenAIEmbeddingAdapter (DC-OPENAI-EMBEDDINGS)", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ embedding: [0.1, 0.2, 0.3], index: 0 },
							{ embedding: [0.4, 0.5, 0.6], index: 1 },
						],
					}),
					{ status: 200 },
				),
		) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("T-EMB-01: returns vectors aligned to input order", async () => {
		const adapter = createOpenAIEmbeddingAdapter({
			apiKey: "sk-test",
			model: "text-embedding-3-small",
		});
		const out = await adapter.embed(["hello", "world"]);
		expect(out).toEqual([
			[0.1, 0.2, 0.3],
			[0.4, 0.5, 0.6],
		]);
	});

	it("T-EMB-02: sends bearer auth + model in request body", async () => {
		const adapter = createOpenAIEmbeddingAdapter({
			apiKey: "sk-test",
			model: "text-embedding-3-small",
		});
		await adapter.embed(["hi"]);
		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		const init = call?.[1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(headers.get("authorization")).toBe("Bearer sk-test");
		expect(JSON.parse(init.body as string)).toMatchObject({
			model: "text-embedding-3-small",
			input: ["hi"],
			encoding_format: "float",
		});
	});

	it("T-EMB-04: batches 250 inputs as 100 + 100 + 50, preserves global order", async () => {
		// Mock derives the global index from the TEXT CONTENT (each input is
		// `t${globalIdx}`), so this test is invariant to dispatch order. It would
		// still pass if embed() parallelised the batches via Promise.all.
		globalThis.fetch = vi.fn(async (_url, init) => {
			const body = JSON.parse((init as RequestInit).body as string);
			const items = (body.input as string[]).map((text, localIdx) => ({
				index: localIdx,
				embedding: [Number(text.slice(1))],
			}));
			return new Response(JSON.stringify({ data: items }), { status: 200 });
		}) as typeof fetch;

		const adapter = createOpenAIEmbeddingAdapter({
			apiKey: "sk-test",
			model: "text-embedding-3-small",
		});
		const inputs = Array.from({ length: 250 }, (_, i) => `t${i}`);
		const out = await adapter.embed(inputs);

		const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
		// Assert exact packing, not "≤100" — contract §5 says max 100, but a
		// degenerate split like 1/1/1/... would also satisfy ≤100 and defeat the
		// purpose of batching (minimise API calls).
		const batchSizes = calls.map((c) => {
			const body = JSON.parse((c[1] as RequestInit).body as string);
			return (body.input as string[]).length;
		});
		expect(batchSizes).toEqual([100, 100, 50]);
		expect(out).toHaveLength(250);
		expect(out.map((v) => v[0])).toEqual(inputs.map((_, i) => i));
	});

	it("T-EMB-07: exactly 100 inputs fits in a single batch (boundary)", async () => {
		// Guards against an off-by-one in `i < texts.length`. A mis-written loop
		// like `i + BATCH_SIZE <= texts.length` or `i <= texts.length` would emit
		// two calls here (100 + 0) or fail differently.
		const fetchMock = vi.fn(
			async (_url, init) =>
				new Response(
					JSON.stringify({
						data: (JSON.parse((init as RequestInit).body as string).input as string[]).map(
							(_t, idx) => ({ index: idx, embedding: [idx] }),
						),
					}),
					{ status: 200 },
				),
		) as typeof fetch;
		globalThis.fetch = fetchMock;

		const adapter = createOpenAIEmbeddingAdapter({
			apiKey: "sk-test",
			model: "text-embedding-3-small",
		});
		const inputs = Array.from({ length: 100 }, (_, i) => `t${i}`);
		const out = await adapter.embed(inputs);

		expect((fetchMock as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
		expect(out).toHaveLength(100);
	});

	it("T-EMB-05: empty input returns [] without hitting the API", async () => {
		const adapter = createOpenAIEmbeddingAdapter({
			apiKey: "sk-test",
			model: "text-embedding-3-small",
		});
		const out = await adapter.embed([]);
		expect(out).toEqual([]);
		expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
	});

	it("T-EMB-06: reorders within a batch when the API returns indices out of order", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ embedding: [0.9], index: 2 },
							{ embedding: [0.1], index: 0 },
							{ embedding: [0.5], index: 1 },
						],
					}),
					{ status: 200 },
				),
		) as typeof fetch;
		const adapter = createOpenAIEmbeddingAdapter({
			apiKey: "sk-test",
			model: "text-embedding-3-small",
		});
		const out = await adapter.embed(["a", "b", "c"]);
		expect(out).toEqual([[0.1], [0.5], [0.9]]);
	});

	it("T-EMB-08: aborts operation when cumulative wallclock exceeds ceiling", async () => {
		// Ceiling = 5 × per-batch budget = 600s. Mock fetch "takes" 120s of
		// simulated wallclock per batch by advancing Date.now(), so batch 6
		// (starting at elapsed=600_000) must trip the ceiling BEFORE the call.
		let simulatedNow = 0;
		const spy = vi.spyOn(Date, "now").mockImplementation(() => simulatedNow);
		globalThis.fetch = vi.fn(async (_url, init) => {
			simulatedNow += 120_000;
			const body = JSON.parse((init as RequestInit).body as string);
			const items = (body.input as string[]).map((_t, idx) => ({
				index: idx,
				embedding: [idx],
			}));
			return new Response(JSON.stringify({ data: items }), { status: 200 });
		}) as typeof fetch;

		try {
			const adapter = createOpenAIEmbeddingAdapter({
				apiKey: "sk-test",
				model: "text-embedding-3-small",
			});
			// 1000 inputs → up to 10 batches. Expected trip at batch 6.
			const inputs = Array.from({ length: 1000 }, (_, i) => `t${i}`);
			await expect(adapter.embed(inputs)).rejects.toThrow(
				/operation exceeded 600000ms wallclock after 500 of 1000 inputs/,
			);
			// 5 batches completed before the 6th was rejected at the guard.
			expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5);
		} finally {
			spy.mockRestore();
		}
	});

	it("T-EMB-09: a fatal failure on batch N rejects embed() without returning partial vectors", async () => {
		// All-or-nothing semantics: when batch 2 fails fatally, the partial
		// `all` accumulated from batch 1 must NOT leak to the caller. The
		// stack-unwind on throw discards it — this test locks that invariant
		// so a future "preserve partial results" refactor can't slip past
		// without an explicit test break and decision.
		let callIndex = 0;
		globalThis.fetch = vi.fn(async (_url, init) => {
			callIndex += 1;
			const body = JSON.parse((init as RequestInit).body as string);
			const items = (body.input as string[]).map((_t, idx) => ({
				index: idx,
				embedding: [idx],
			}));
			if (callIndex === 2) {
				// 400 maps to FatalLLMError via classifyHttp — non-retriable.
				return new Response("bad request", { status: 400 });
			}
			return new Response(JSON.stringify({ data: items }), { status: 200 });
		}) as typeof fetch;

		const adapter = createOpenAIEmbeddingAdapter({
			apiKey: "sk-test",
			model: "text-embedding-3-small",
		});
		// 150 inputs → 2 batches (100 + 50). Batch 2 trips fatal.
		const inputs = Array.from({ length: 150 }, (_, i) => `t${i}`);
		// Sentinel proves "nothing was returned" directly — if a future refactor
		// caught the fatal and returned the partial batch-1 vectors, `out`
		// would change and the assertion would fail. `rejects.toThrow` alone
		// would also catch it (promise resolves instead of rejects), but the
		// explicit sentinel matches the title of the test verbatim.
		let out: unknown = "unset";
		await expect(
			(async () => {
				out = await adapter.embed(inputs);
			})(),
		).rejects.toThrow(/HTTP 400/);
		expect(out).toBe("unset");
		// Exactly 2 calls — batch 1 succeeded, batch 2 was the fatal one. No
		// retry on a 400 (non-retriable), no batch 3.
		expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
	});

	it("T-EMB-03: aborts in-flight request when caller signal aborts", async () => {
		const adapter = createOpenAIEmbeddingAdapter({
			apiKey: "sk-test",
			model: "text-embedding-3-small",
		});
		const ctrl = new AbortController();
		// Mock fetch to honor the signal: reject with AbortError when aborted.
		globalThis.fetch = vi.fn(
			(_url: string | URL, init?: RequestInit) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("aborted", "AbortError"));
					});
				}),
		) as typeof fetch;
		const promise = adapter.embed(["hi"], { signal: ctrl.signal });
		ctrl.abort();
		await expect(promise).rejects.toThrow(/abort/i);
	});
});
