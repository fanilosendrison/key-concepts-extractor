---
id: NIB-M-WEB-SERVER
type: nib-module
version: "1.0.0"
scope: key-concepts-extractor/web-server
status: approved
validates: [src/web/server.ts, tests/web-server.test.ts]
consumers: [claude-code]
superseded_by: []
---

---

## 1. Purpose

HTTP + WebSocket server that exposes the pipeline to the web UI. Serves the static SPA, provides a REST API for run management, and pushes real-time events via WebSocket.

---

## 2. API

### 2.1 REST endpoints

```javascript
POST   /api/runs              → Start a new run
  Body: multipart/form-data
    - prompt (string, optional)
    - files (file[], optional, .md/.txt)
  Response 201: { run_id: string }
  Response 409: { error: "A run is already in progress" }
  Response 400: { error: "At least one of prompt or files required" }

DELETE /api/runs/:id          → Stop a running run
  Response 200: { status: "stopped" }
  Response 404: { error: "Run not found" }
  Response 409: { error: "Run is not active" }

GET    /api/runs               → List all runs
  Response 200: RunManifest[] (antéchronologique)

GET    /api/runs/:id           → Get run details
  Response 200: { manifest: RunManifest, events: PipelineEvent[] }
  Response 404: { error: "Run not found" }

GET    /api/runs/:id/files/*path  → Get a result file
  Response 200: file content (application/json)
  Response 404: { error: "File not found" }
```

### 2.2 WebSocket

```javascript
WS     /ws/runs/:id            → Real-time event stream for a run
  Server → Client: PipelineEvent (JSON string, one per message)
  Connection opened: sends all existing events as catch-up, then live events
  Run completes/fails/stops: server sends final event, then closes connection
```

### 2.3 Static files

```javascript
GET    /                       → index.html (SPA)
GET    /assets/*               → Static assets (JS, CSS)
```

---

## 3. Algorithm

### 3.1 Server initialization

```javascript
function createServer(config: ServerConfig): void {
  const app = createHTTPServer();
  const wss = createWebSocketServer();

  // Static file serving: serve built SPA from /public or /dist
  app.use('/', serveStatic(config.publicDir));

  // REST routes
  app.post('/api/runs', handleStartRun);
  app.delete('/api/runs/:id', handleStopRun);
  app.get('/api/runs', handleListRuns);
  app.get('/api/runs/:id', handleGetRun);
  app.get('/api/runs/:id/files/*', handleGetFile);

  // WebSocket upgrade
  wss.on('connection', handleWsConnection);

  app.listen(config.port);  // Default: 3000
}
```

### 3.2 handleStartRun

```javascript
async function handleStartRun(req, res): void {
  // 1. Check no active run
  const activeRun = RunManager.listRuns(config.runsDir).find(r => r.status === 'running');
  if (activeRun) return res.status(409).json({ error: 'A run is already in progress' });

  // 2. Parse multipart: extract prompt + files
  const { prompt, files } = parseMultipart(req);

  // 3. Validate at least one input
  if (!prompt && (!files || files.length === 0)) {
    return res.status(400).json({ error: 'At least one of prompt or files required' });
  }

  // 4. Create run
  const runId = generateRunId();
  res.status(201).json({ run_id: runId });

  // 5. Start pipeline asynchronously (non-blocking)
  //    EventLogger forwards events to WebSocket clients
  const input: InputProcessorInput = { prompt: prompt || undefined, files };
  runPipelineAsync(input, config.pipelineConfig, runId, 'web');
}
```

### 3.3 handleWsConnection

```javascript
function handleWsConnection(ws, req): void {
  const runId = extractRunId(req.url);  // /ws/runs/:id

  // 1. Send catch-up: all existing events for this run
  const { events } = RunManager.getRun(config.runsDir, runId);
  for (const event of events) {
    ws.send(JSON.stringify(event));
  }

  // 2. Register this ws client for live events
  activeWsClients.add(ws);

  ws.on('close', () => activeWsClients.delete(ws));
}
```

### 3.4 Graceful stop (DELETE /api/runs/:id)

```javascript
async function handleStopRun(req, res): void {
  // Set interrupt flag on the active pipeline
  // Pipeline checks this flag between phases and after each API call
  // Same graceful stop logic as CLI Ctrl+C
}
```

---

## 4. Edge cases

| Case | Expected behavior |
|---|---|
| WebSocket connects to non-existent run | 404 during upgrade, connection rejected |
| WebSocket connects to completed run | Send all events as catch-up, then close |
| Multiple WebSocket clients for same run | All receive same events |
| Server crash during run | Run stays 'running' in manifest. On restart, detect stale runs and mark as 'failed'. |
| File upload > reasonable size | Return 413 (configurable limit, default 10MB per file) |

---

## 5. Constraints

- **Single concurrent run** — enforced at API level.
- **No authentication** — monoposte, mono-utilisateur (Interface Spec §7.2).
- **Server-push only** — client does not poll (Interface Spec §7.3).
- **Shares run storage** with CLI (Interface Spec §9.1).
- **Port configurable** but not exposed in UI.

---

## 6. Integration

```typescript
// Entry point:
const server = createServer({
  publicDir: './dist',
  port: 3000,
  runsDir: config.runsDir,
  pipelineConfig: config,
});
```
