import type { PipelineEvent } from "../domain/types.js";

export interface EventLogger {
  emit(event: Omit<PipelineEvent, "timestamp">): Promise<void>;
  getEvents(): Promise<PipelineEvent[]>;
}

export function createEventLogger(_runDir: string): EventLogger {
  throw new Error("Not implemented");
}
