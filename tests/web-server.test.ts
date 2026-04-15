import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebServer, type WebServerHandle } from "../src/web/server.js";
import { cleanupTempDir, createTempDir } from "./helpers/temp-dir.js";

describe("WebServer", () => {
  let baseDir: string;
  let handle: WebServerHandle | undefined;

  beforeEach(async () => {
    baseDir = await createTempDir();
  });
  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = undefined;
    }
    await cleanupTempDir(baseDir);
  });

  it("T-WS-01: POST /api/runs starts a run", async () => {
    const server = createWebServer({ baseDir });
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
    const server = createWebServer({ baseDir });
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
    const server = createWebServer({ baseDir });
    await server.fetch(
      new Request("http://localhost/api/runs", {
        method: "POST",
        body: JSON.stringify({ prompt: "a" }),
      }),
    );
    await server.fetch(
      new Request("http://localhost/api/runs", {
        method: "POST",
        body: JSON.stringify({ prompt: "b" }),
      }),
    );
    const res = await server.fetch(new Request("http://localhost/api/runs"));
    const list = (await res.json()) as unknown[];
    expect(list).toHaveLength(2);
  });

  it("T-WS-04: DELETE /api/runs/:id stops run", async () => {
    const server = createWebServer({ baseDir });
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

  it("T-WS-05: WebSocket receives pipeline events", async () => {
    const server = createWebServer({ baseDir });
    handle = await server.listen(0);

    const startRes = await fetch(`${handle.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "test" }),
    });
    const { run_id } = (await startRes.json()) as { run_id: string };

    const wsUrl = handle.url.replace(/^http/, "ws") + `/ws/runs/${run_id}`;
    const ws = new WebSocket(wsUrl);

    ws.binaryType = "arraybuffer";
    const event = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 3000);
      ws.addEventListener("message", (ev) => {
        clearTimeout(timer);
        const text =
          typeof ev.data === "string"
            ? ev.data
            : new TextDecoder().decode(ev.data as ArrayBuffer);
        resolve(JSON.parse(text));
      });
      ws.addEventListener("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    ws.close();

    expect(event).toMatchObject({
      timestamp: expect.any(String),
      phase: expect.any(String),
      type: expect.any(String),
      payload: expect.any(Object),
    });
  });
});
