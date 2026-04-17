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
			// §3.3 prescribes "Fatal" uniformly. The `fatal` boolean on the
			// payload is consumed by WS/UI for surfacing intent, not by the
			// CLI formatter — pipeline.ts can emit fatal:false for errors
			// that escape the try but aren't FatalLLMError instances.
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
