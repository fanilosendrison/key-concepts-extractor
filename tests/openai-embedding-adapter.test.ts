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
		});
	});

	it("T-EMB-03: aborts in-flight request when caller signal aborts", async () => {
		const adapter = createOpenAIEmbeddingAdapter({
			apiKey: "sk-test",
			model: "text-embedding-3-small",
		});
		const ctrl = new AbortController();
		// Mock fetch to honor the signal: reject with AbortError when aborted.
		globalThis.fetch = vi.fn(
			(_url: RequestInfo | URL, init?: RequestInit) =>
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
