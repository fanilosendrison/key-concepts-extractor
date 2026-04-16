// NIB-M-CLI §3.3 — one line per event, horodated, structured stdout. Terminal
// events (run_complete / run_error / run_stopped) get a human-readable shape
// per §3.3's prescribed examples; non-terminal events keep the generic
// observability form (`phase — type {payload}`) for live debugging.

import type { PipelineEvent } from "../domain/types.js";

export function formatEvent(event: PipelineEvent): string {
	const time = event.timestamp.slice(11, 23);
	switch (event.type) {
		case "run_complete": {
			const p = event.payload as { total_concepts?: number; run_dir?: string };
			return `[${time}] ✅ Complete — ${p.total_concepts ?? 0} concepts — ${p.run_dir ?? ""}`;
		}
		case "run_error": {
			// NIB-M-CLI §3.3 only shows the "Fatal" wording for run_error; stay
			// aligned even though the payload carries a `fatal` boolean — the
			// CLI currently emits run_error only on fatal conditions anyway
			// (pipeline.ts sets fatal from `error instanceof FatalLLMError`).
			const p = event.payload as { error?: string };
			return `[${time}] ❌ Fatal — ${p.error ?? "(no message)"}`;
		}
		case "run_stopped": {
			const p = event.payload as { reason?: string };
			return `[${time}] 🛑 Stopped — ${p.reason ?? "unknown"}`;
		}
		default:
			return `[${time}] ${event.phase} — ${event.type} ${JSON.stringify(event.payload)}`;
	}
}
