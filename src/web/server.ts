import {
	createServer as createHttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { createEventLogger } from "../infra/event-logger.js";
import { createRunManager, listRuns } from "../infra/run-manager.js";

export interface WebServerDeps {
	baseDir: string;
}

export interface WebServerHandle {
	readonly port: number;
	readonly url: string;
	stop(): Promise<void>;
}

export interface WebServer {
	fetch: (req: Request) => Promise<Response>;
	listen(port?: number): Promise<WebServerHandle>;
}

export function createWebServer(deps: WebServerDeps): WebServer {
	const runsDir = join(deps.baseDir, "runs");

	// Per-run websocket subscribers, mapping run_id -> set of ws sockets
	const wsSubscribers = new Map<string, Set<WSContext>>();

	const app = new Hono();
	const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

	app.post("/api/runs", async (c) => {
		// Parse body permissively (multipart planned by spec, JSON used by tests)
		let body: { prompt?: unknown; files?: unknown } = {};
		try {
			const raw = await c.req.text();
			if (raw.length > 0) body = JSON.parse(raw) as typeof body;
		} catch {
			body = {};
		}
		const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
		const hasFiles = Array.isArray(body.files) && body.files.length > 0;

		if (!prompt && !hasFiles) {
			return c.json({ error: "At least one of prompt or files required" }, 400);
		}

		const existing = await listRuns(runsDir);
		const hasActive = existing.some((r) => r.status === "running");

		const rm = createRunManager(runsDir);
		await rm.initRun();

		if (hasActive) {
			// Persist the rejected run so GET /api/runs reflects the attempt, then 409.
			await rm.failRun(new Error("concurrent run rejected"));
			return c.json({ error: "A run is already in progress" }, 409);
		}

		const logger = createEventLogger(rm.runDir);
		await logger.emit({
			phase: "run",
			type: "run_started",
			payload: { run_id: rm.runId, source: "web" },
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
					const events = await logger.getEvents();
					for (const event of events) ws.send(JSON.stringify(event));
					let set = wsSubscribers.get(runId);
					if (!set) {
						set = new Set();
						wsSubscribers.set(runId, set);
					}
					set.add(ws);
				},
				onClose(_evt, ws) {
					if (runId) wsSubscribers.get(runId)?.delete(ws);
				},
				onError(err) {
					// Silent — client disconnects shouldn't crash the server
					void err;
				},
			};
		}),
	);

	const server: WebServer = {
		fetch: async (req) => app.fetch(req),

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
