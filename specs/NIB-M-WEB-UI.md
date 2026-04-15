---
id: NIB-M-WEB-UI
type: nib-module
version: "1.0.0"
scope: key-concepts-extractor/web-ui
status: approved
consumers: [claude-code]
superseded_by: []
---

---

## 1. Purpose

Single-page application (SPA) served by WebServer. Provides the conversational-style interface for submitting runs, watching real-time progress, viewing results, and browsing history.

---

## 2. Views

Two views, switchable via sidebar navigation.

### 2.1 Main view (default)

Three zones stacked vertically:

```javascript
┌────────────────────────────────────────┐
│  Results section (appears on completion)   │
│  - Total concepts count                    │
│  - Run directory path                      │
│  - File list with open-in-viewer links      │
│  - Diagnostics (structured display)         │
├────────────────────────────────────────┤
│  Event journal (scrollable, grows upward)   │
│  Events grouped by phase, timestamped       │
│  Auto-scroll to latest, user can browse     │
├────────────────────────────────────────┤
│  Submission zone (always visible)            │
│  [Prompt textarea] [File drop] [Launch/Stop] │
└────────────────────────────────────────┘
```

### 2.2 History view

List of past runs, antéchronologique. Each entry shows: date, status badge, concept count, prompt preview/file names. Clicking a run opens its detail (event log + results).

---

## 3. Components

### 3.1 SubmissionZone

**State:**

```typescript
interface SubmissionState {
  prompt: string;                    // Textarea content
  files: File[];                     // Attached files
  isRunning: boolean;                // Pipeline active
  activeRunId: string | null;
}
```

**Behavior:**

- Textarea: multiline, placeholder "Describe your research..."
- File zone: drag-and-drop or file picker. Accepts `.md`, `.txt`. Each file shows name + size + remove button.
- Launch button: disabled if no prompt and no files. On click: `POST /api/runs` with multipart.
- Stop button: replaces Launch when `isRunning`. On click: `DELETE /api/runs/:id`.
- After run starts: submission zone becomes read-only (except Stop button).
- After run ends: submission zone reactivates.

### 3.2 EventJournal

**Data source:** WebSocket `/ws/runs/:id`. On connection, receives catch-up events, then live.

**Display:**

- Events grouped by phase (visual separator + phase label).
- Each event: `[HH:mm:ss] {formatted message}` — same format as CLI.
- Phase progress shown as counters: "Extraction — 7/15", "Fusion intra-angle — 3/5".
- Error events highlighted in red.
- Retry events shown inline with retry count.

**Auto-scroll:**

- Latest event always visible (scroll to bottom on new event).
- If user scrolls up, auto-scroll pauses.
- Auto-scroll resumes when user scrolls back to bottom (within 50px of bottom).

### 3.3 ResultsSection

Appears when `run_complete` event received.

**Content:**

- Total concepts count (large number).
- Run directory path (copyable).
- File list: each file as a row with name, role description, and "View" link.
- Clicking "View" opens JSON in a modal/drawer (syntax-highlighted, read-only).
- Diagnostics panel: contribution by angle (bar chart or table), contribution by model, fragile count, unanimous count.

### 3.4 HistoryList

**Data source:** `GET /api/runs` on mount.

**Display:**

- Table or card list. Columns: date, status, concepts, prompt/files.
- Status badges: ✅ completed, ❌ failed, ⏹ stopped, ⏳ running.
- Click to open: loads `GET /api/runs/:id`, displays EventJournal (replay) + ResultsSection.
- Relaunch button: re-submits with same inputs (`POST /api/runs` with files from `inputs/` directory).

### 3.5 JsonViewer

Modal/drawer for viewing result files.

- Syntax-highlighted JSON (read-only).
- Collapsible nodes for large objects.
- File name in header.

---

## 4. Data flow

```javascript
User → SubmissionZone → POST /api/runs → Server starts pipeline
                                          │
                        WebSocket /ws/runs/:id ◄─┘
                                          │
                        EventJournal ◄────┘ (live events)
                                          │
                        ResultsSection ◄──┘ (on run_complete)
                                          │
                        GET /api/runs/:id/files/* (on "View" click)
```

---

## 5. Edge cases

| Case | Expected behavior |
|---|---|
| Page refresh during active run | Reconnect WebSocket, receive catch-up events |
| WebSocket disconnection | Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s) |
| Server unreachable | Show offline banner. History view works from local state. |
| Run files deleted from disk | "View" button shows "File not found" message |
| Very long event log (>1000 events) | Virtual scrolling for performance |

---

## 6. Constraints

- **SPA** — single HTML entry point, client-side routing.
- **No framework requirement** — implementation can use vanilla JS, React, Vue, or similar. Agent decides based on complexity.
- **Chrome-only** target (Interface Spec §7.1).
- **No config UI** — configuration is external (Interface Spec §7.5).
- **Offline capability** — history and results viewable without internet. Only run launch requires connectivity (Interface Spec §7.4).
