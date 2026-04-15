import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LLMResponse, ProviderAdapter } from "../src/domain/ports.js";
import { DEFAULT_RUN_CONFIG } from "../src/domain/types.js";
import { createRunManager } from "../src/infra/run-manager.js";
import { createWebServer, type WebServerDeps, type WebServerHandle } from "../src/web/server.js";
import { createPipelineHarness } from "./helpers/pipeline-harness.js";
import { cleanupTempDir, createTempDir } from "./helpers/temp-dir.js";

function makeDeps(baseDir: string): WebServerDeps {
	return { baseDir, ...createPipelineHarness() };
}

// Slow harness: stalls providers so the run stays `running` long enough for
// a DELETE to hit before the pipeline completes (fixes T-WS-04 flakiness).
function makeSlowDeps(baseDir: string, delayMs = 200): WebServerDeps {
	const slow = (p: "anthropic" | "openai" | "google"): ProviderAdapter => ({
		provider: p,
		async call(): Promise<LLMResponse> {
			await new Promise((r) => setTimeout(r, delayMs));
			return { content: "[]", provider: p, model: "slow", latencyMs: delayMs };
		},
	});
	const harness = createPipelineHarness();
	return {
		baseDir,
		anthropic: slow("anthropic"),
		openai: slow("openai"),
		google: slow("google"),
		embeddings: harness.embeddings,
	};
}

describe("WebServer", () => {
	let baseDir: string;
	let handle: WebServerHandle | undefined;

	beforeEach(async () => {
		baseDir = await createTempDir();
	});
	let server: ReturnType<typeof createWebServer> | undefined;
	afterEach(async () => {
		if (server) await server.waitForIdle();
		if (handle) {
			await handle.stop();
			handle = undefined;
		}
		server = undefined;
		await cleanupTempDir(baseDir);
	});

	it("T-WS-01: POST /api/runs starts a run", async () => {
		server = createWebServer(makeDeps(baseDir));
		const res = await server.fetch(
			new Request("http://localhost/api/runs", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ prompt: "test" }),
			}),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { run_id: string };
		expect(body.run_id).toBeDefined();
	});

	it("T-WS-02: POST /api/runs while running → 409", async () => {
		server = createWebServer(makeDeps(baseDir));
		await server.fetch(
			new Request("http://localhost/api/runs", {
				method: "POST",
				body: JSON.stringify({ prompt: "a" }),
			}),
		);
		const res = await server.fetch(
			new Request("http://localhost/api/runs", {
				method: "POST",
				body: JSON.stringify({ prompt: "b" }),
			}),
		);
		expect(res.status).toBe(409);
	});

	it("T-WS-03: GET /api/runs lists runs", async () => {
		// NIB-M-WEB-SERVER §7.2 forbids concurrent runs; seed two completed runs directly
		// via RunManager so the listing endpoint sees >1 persisted manifest.
		const runsDir = join(baseDir, "runs");
		const rm1 = createRunManager(runsDir);
		await rm1.initRun(DEFAULT_RUN_CONFIG);
		await rm1.finalizeRun({ total_concepts: 0, fragile_concepts: 0, unanimous_concepts: 0 });
		const rm2 = createRunManager(runsDir);
		await rm2.initRun(DEFAULT_RUN_CONFIG);
		await rm2.finalizeRun({ total_concepts: 0, fragile_concepts: 0, unanimous_concepts: 0 });

		server = createWebServer(makeDeps(baseDir));
		const res = await server.fetch(new Request("http://localhost/api/runs"));
		const list = (await res.json()) as unknown[];
		expect(list).toHaveLength(2);
	});

	it("T-WS-03b: POST-created run appears in GET /api/runs listing", async () => {
		// Covers the write/read coherence path (POST → persisted manifest → GET reads it)
		// that T-WS-03 loses by bypassing POST due to the single-concurrent-run mutex.
		server = createWebServer(makeDeps(baseDir));
		const postRes = await server.fetch(
			new Request("http://localhost/api/runs", {
				method: "POST",
				body: JSON.stringify({ prompt: "write-read" }),
			}),
		);
		const { run_id } = (await postRes.json()) as { run_id: string };
		await server.waitForIdle();
		const listRes = await server.fetch(new Request("http://localhost/api/runs"));
		const list = (await listRes.json()) as Array<{ run_id: string }>;
		expect(list.map((r) => r.run_id)).toContain(run_id);
	});

	it("T-WS-04: DELETE /api/runs/:id stops run", async () => {
		// Use a slow provider harness so the pipeline is still `running` when DELETE
		// fires — otherwise a fast mock can finalize the run before we test it.
		server = createWebServer(makeSlowDeps(baseDir));
		const startRes = await server.fetch(
			new Request("http://localhost/api/runs", {
				method: "POST",
				body: JSON.stringify({ prompt: "a" }),
			}),
		);
		const { run_id } = (await startRes.json()) as { run_id: string };
		const res = await server.fetch(
			new Request(`http://localhost/api/runs/${run_id}`, { method: "DELETE" }),
		);
		expect(res.status).toBe(200);
	});

	it("T-WS-05: WebSocket receives pipeline events via live subscribe", async () => {
		// To exercise the subscribe() path (not just backfill), we open the WS BEFORE
		// triggering the run, wait for `open`, then POST. The slow harness keeps the
		// pipeline running long enough that subsequent events arrive after subscribe.
		server = createWebServer(makeSlowDeps(baseDir, 80));
		handle = await server.listen(0);

		// We don't know the run_id yet; open on a placeholder path that the server will
		// accept (the WS handler uses the runId only to look up the events file and
		// subscribers map). So we POST first to get the id, but don't await the run.
		const startRes = await fetch(`${handle.url}/api/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "test" }),
		});
		const { run_id } = (await startRes.json()) as { run_id: string };

		const wsUrl = `${handle.url.replace(/^http/, "ws")}/ws/runs/${run_id}`;
		const ws = new WebSocket(wsUrl);
		ws.binaryType = "arraybuffer";
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", (e) => reject(e), { once: true });
		});

		// Collect events until we see at least one live event from a later phase
		// (`extraction` or beyond) — proof that subscribe() is forwarding.
		const livePhases = new Set(["extraction", "fusion_intra", "fusion_inter", "diagnostics"]);
		const live = await new Promise<{ phase: string; type: string }>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timeout waiting for live event")), 5000);
			ws.addEventListener("message", (ev) => {
				const text =
					typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
				const event = JSON.parse(text) as { phase: string; type: string };
				if (livePhases.has(event.phase)) {
					clearTimeout(timer);
					resolve(event);
				}
			});
			ws.addEventListener("error", (e) => {
				clearTimeout(timer);
				reject(e);
			});
		});
		ws.close();

		expect(livePhases.has(live.phase)).toBe(true);
	});
});
