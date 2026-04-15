---
id: NIB-M-EVENT-LOGGER
type: nib-module
version: "1.0.0"
scope: key-concepts-extractor/event-logger
status: approved
consumers: [claude-code]
superseded_by: []
---

---

## 1. Purpose

Provides a shared event emitter that all pipeline modules use to log progression events. Writes events to `events.jsonl` (append-only) and forwards them to WebSocket clients in real time.

---

## 2. Interface

```typescript
class EventLogger {
  constructor(eventsFilePath: string, wsClients?: Set<WebSocket>);

  emit(event: Omit<PipelineEvent, 'timestamp'>): void;
  getEvents(): PipelineEvent[];  // Read all events from file
}

interface PipelineEvent {
  timestamp: string;                 // ISO 8601 with ms, auto-generated
  phase: 'input' | 'extraction' | 'fusion_intra' | 'fusion_inter' | 'diagnostics' | 'run';
  type: string;
  payload: Record<string, unknown>;
}
```

---

## 3. Algorithm

### 3.1 emit(event)

```javascript
function emit(partialEvent: Omit<PipelineEvent, 'timestamp'>): void {
  const event: PipelineEvent = {
    timestamp: new Date().toISOString(),
    ...partialEvent,
  };

  // 1. Append to events.jsonl (one JSON line)
  appendFileSync(this.eventsFilePath, JSON.stringify(event) + '\n');

  // 2. Forward to all connected WebSocket clients
  if (this.wsClients) {
    const message = JSON.stringify(event);
    for (const ws of this.wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }
}
```

### 3.2 getEvents()

```javascript
function getEvents(): PipelineEvent[] {
  const content = readFileSync(this.eventsFilePath, 'utf-8');
  return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
```

---

## 4. Event types

All event types from Spec v1.5 §13. Helper functions for type-safe event construction:

```typescript
// Phase: extraction
function extractionStart(angle: AngleId, model: ProviderShortId): Omit<PipelineEvent, 'timestamp'>;
function extractionComplete(angle: AngleId, model: ProviderShortId, conceptsCount: number): ...;
function extractionError(angle: AngleId, model: ProviderShortId, error: string, retry: number): ...;
function extractionProgress(completed: number, total: number): ...;

// Phase: fusion_intra
function fusionIntraStart(angle: AngleId, inputCount: number): ...;
function fusionIntraComplete(angle: AngleId, outputCount: number, consensus: Record<string, number>): ...;

// Phase: fusion_inter
function fusionInterStart(inputCount: number, similarityThreshold: number): ...;
function fusionInterComplete(clusters: number, conceptsFinal: number): ...;

// Shared: controls
function controlStart(controlType: 'quality' | 'relevance', round: number, model: 'claude' | 'gpt', scope: ControlScope): ...;
function controlComplete(controlType: string, round: number, model: string, scope: ControlScope, count: number): ...;
function controlResult(controlType: string, scope: ControlScope, roundsUsed: number, actionCount: number): ...;

// Phase: finalization
function coverageComplete(stats: { explicit: number; implicit: number; fragile: number }): ...;
function runComplete(totalConcepts: number, outputDir: string): ...;
function runError(error: string, fatal: boolean): ...;
function runStopped(reason: string, partialResults: boolean): ...;
```

---

## 5. Edge cases

| Case | Expected behavior |
|---|---|
| WebSocket client disconnects during send | Silently skip. Do not throw. |
| events.jsonl does not exist | Created on first emit |
| Concurrent emit calls | appendFileSync is blocking — serialized within the Node.js event loop |

---

## 6. Constraints

- **Append-only** — never modifies or deletes previous events.
- **Synchronous file write** — ensures event is persisted before continuing pipeline.
- **Non-blocking WebSocket send** — does not await client acknowledgment.
