import type {
  AngleId,
  ProviderId,
  RawConcept,
  RunManifest,
} from "../domain/types.js";

export interface RunManager {
  readonly runId: string;
  readonly runDir: string;
  initRun(): Promise<void>;
  persistExtractionPass(
    angle: AngleId,
    provider: ProviderId,
    concepts: RawConcept[],
  ): Promise<void>;
  finalizeRun(results: Record<string, unknown>): Promise<void>;
  failRun(error: Error): Promise<void>;
  getManifest(): Promise<RunManifest>;
}

export function createRunManager(_baseDir: string, _runId?: string): RunManager {
  throw new Error("Not implemented");
}

export function listRuns(_baseDir: string): Promise<RunManifest[]> {
  throw new Error("Not implemented");
}
