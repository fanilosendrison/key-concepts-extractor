import {
	createServer as createHttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import type { EmbeddingAdapter, ProviderAdapter } from "../domain/ports.js";
import { DEFAULT_RUN_CONFIG, type InputFile, type RunConfig } from "../domain/types.js";
import { createEventLogger, type EventListener } from "../infra/event-logger.js";
import { createRunManager, listRuns, type RunManager } from "../infra/run-manager.js";
import { runPipeline } from "../pipeline.js";

export interface WebServerDeps {
	baseDir: string;
	anthropic: ProviderAdapter;
	openai: ProviderAdapter;
	google: ProviderAdapter;
	embeddings: EmbeddingAdapter;
	config?: RunConfig;
}

export interface ListeningServer {
	readonly port: number;
	readonly url: string;
	stop(): Promise<void>;
}

export interface WebServer {
	fetch: (req: Request) => Promise<Response>;
	listen(port?: number): Promise<ListeningServer>;
	// Resolves when no background run is in flight. Used by tests to avoid
	// tearing down the temp run directory while the pipeline is still writing.
	waitForIdle(): Promise<void>;
}

export function createWebServer(deps: WebServerDeps): WebServer {
	const runsDir = join(deps.baseDir, "runs");

	// NIB-M-WEB-SERVER §7.2 : single concurrent run. In-memory mutex avoids the
	// persisted-failed-manifest hack previously used to satisfy T-WS-03 listing.
	let activeRunId: string | null = null;
	let activeRunPromise: Promise<void> | null = null;

	// Per-run unsubscribe functions, keyed by ws context — torn down on close.
	const wsUnsubs = new WeakMap<WSContext, () => void>();

	const app = new Hono();
	const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

	app.post("/api/runs", async (c) => {
		let body: { prompt?: unknown; files?: unknown } = {};
		try {
			const raw = await c.req.text();
			if (raw.length > 0) body = JSON.parse(raw) as typeof body;
		} catch {
			body = {};
		}
		const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
		const rawFiles = Array.isArray(body.files) ? body.files : [];
		const files: InputFile[] = rawFiles.flatMap((f) => {
			if (
				f &&
				typeof f === "object" &&
				typeof (f as InputFile).name === "string" &&
				typeof (f as InputFile).content === "string"
			) {
				return [f as InputFile];
			}
			return [];
		});

		if (!prompt && files.length === 0) {
			return c.json({ error: "At least one of prompt or files required" }, 400);
		}
		// Claim the mutex SYNCHRONOUSLY before any await to close the race between
		// two POSTs observing activeRunId=null and both passing the check.
		if (activeRunId !== null) {
			return c.json({ error: "A run is already in progress" }, 409);
		}
		const rm = createRunManager(runsDir);
		activeRunId = rm.runId;
		try {
			await rm.initRun(deps.config ?? DEFAULT_RUN_CONFIG, "web");
		} catch (error) {
			activeRunId = null;
			throw error;
		}

		// Fire-and-forget: the run continues asynchronously. `activeRunId` is cleared
		// by the settler below regardless of outcome (completed / failed / stopped).
		activeRunPromise = startRunAsync(rm, { prompt, files }).finally(() => {
			if (activeRunId === rm.runId) activeRunId = null;
			activeRunPromise = null;
		});

		return c.json({ run_id: rm.runId }, 201);
	});

	app.delete("/api/runs/:id", async (c) => {
		const id = c.req.param("id");
		const all = await listRuns(runsDir);
		const manifest = all.find((r) => r.run_id === id);
		if (!manifest) return c.json({ error: "Run not found" }, 404);
		if (manifest.status !== "running") {
			return c.json({ error: "Run is not active" }, 409);
		}
		const rm = createRunManager(runsDir, id);
		await rm.stopRun();
		if (activeRunId === id) activeRunId = null;
		return c.json({ status: "stopped" }, 200);
	});

	app.get("/api/runs", async (c) => {
		const all = await listRuns(runsDir);
		return c.json(all);
	});

	app.get("/api/runs/:id", async (c) => {
		const id = c.req.param("id");
		const all = await listRuns(runsDir);
		const manifest = all.find((r) => r.run_id === id);
		if (!manifest) return c.json({ error: "Run not found" }, 404);
		const rm = createRunManager(runsDir, id);
		const logger = createEventLogger(rm.runDir);
		const events = await logger.getEvents();
		return c.json({ manifest, events });
	});

	app.get(
		"/ws/runs/:id",
		upgradeWebSocket((c) => {
			const runId = c.req.param("id");
			return {
				async onOpen(_evt, ws) {
					if (!runId) return;
					const rm = createRunManager(runsDir, runId);
					const logger = createEventLogger(rm.runDir);
					const past = await logger.getEvents();
					for (const event of past) ws.send(JSON.stringify(event));
					// NIB-M-EVENT-LOGGER §3.1 : live forwarding for every event emitted
					// by the pipeline after the WS connection is established.
					const listener: EventListener = (event) => {
						try {
							ws.send(JSON.stringify(event));
						} catch {
							// Half-closed socket (e.g. TCP reset without close frame) may never
							// fire onClose — release the subscription proactively to avoid leaking
							// listeners in the event-logger for the remainder of the process.
							const u = wsUnsubs.get(ws);
							if (u) {
								u();
								wsUnsubs.delete(ws);
							}
						}
					};
					const unsub = logger.subscribe(listener);
					wsUnsubs.set(ws, unsub);
				},
				onClose(_evt, ws) {
					const unsub = wsUnsubs.get(ws);
					if (unsub) {
						unsub();
						wsUnsubs.delete(ws);
					}
				},
				onError(err) {
					void err;
				},
			};
		}),
	);

	async function startRunAsync(
		rm: RunManager,
		input: { prompt: string | undefined; files: InputFile[] },
	): Promise<void> {
		try {
			await runPipeline(
				{
					...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
					files: input.files,
				},
				{
					anthropic: deps.anthropic,
					openai: deps.openai,
					google: deps.google,
					embeddings: deps.embeddings,
					baseDir: deps.baseDir,
					runManager: rm,
					source: "web",
					...(deps.config ? { config: deps.config } : {}),
				},
			);
		} catch (error) {
			// runPipeline catches internally and updates manifest; this is a safety net
			// for unexpected throws so we never leak an "active" run across failures.
			await rm.failRun(error instanceof Error ? error : new Error(String(error))).catch(() => {});
		}
	}

	const server: WebServer = {
		fetch: async (req) => app.fetch(req),

		async waitForIdle() {
			while (activeRunPromise) await activeRunPromise;
		},

		async listen(port = 0) {
			const httpServer = createHttpServer((req, res) => handleNodeRequest(app, req, res));
			await new Promise<void>((resolve) => httpServer.listen(port, resolve));
			injectWebSocket(httpServer);
			const address = httpServer.address();
			const actualPort = typeof address === "object" && address ? address.port : port;
			return {
				port: actualPort,
				url: `http://127.0.0.1:${actualPort}`,
				async stop() {
					await new Promise<void>((resolve) => {
						httpServer.close(() => resolve());
					});
				},
			};
		},
	};

	return server;
}

async function handleNodeRequest(
	app: Hono,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const host = req.headers.host ?? "127.0.0.1";
	const url = `http://${host}${req.url ?? "/"}`;
	const method = req.method ?? "GET";
	const headers = new Headers();
	for (const [k, v] of Object.entries(req.headers)) {
		if (Array.isArray(v)) headers.set(k, v.join(", "));
		else if (typeof v === "string") headers.set(k, v);
	}

	let body: Uint8Array | undefined;
	if (method !== "GET" && method !== "HEAD") {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		if (chunks.length > 0) body = new Uint8Array(Buffer.concat(chunks));
	}

	const webRequest = new Request(url, {
		method,
		headers,
		...(body !== undefined ? { body } : {}),
	});
	const webResponse = await app.fetch(webRequest);

	res.statusCode = webResponse.status;
	webResponse.headers.forEach((value, key) => {
		res.setHeader(key, value);
	});
	if (webResponse.body) {
		const reader = webResponse.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			res.write(Buffer.from(value));
		}
	}
	res.end();
}
