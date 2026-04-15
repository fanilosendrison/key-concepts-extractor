import type { AngleId, MergedConcept, ProviderId, RawConcept } from "./types.js";

export interface IntraAngleInput {
  angle: AngleId;
  passes: Partial<Record<ProviderId, RawConcept[]>>;
}

export function fuseIntraAngle(_input: IntraAngleInput): MergedConcept[] {
  throw new Error("Not implemented");
}
