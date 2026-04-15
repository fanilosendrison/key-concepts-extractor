import type { AngleId, DiagnosticsReport, FinalConcept, ProviderId } from "./types.js";

export interface DiagnosticsInput {
	concepts: FinalConcept[];
	fragile?: number;
}

export function generateDiagnostics(input: DiagnosticsInput): DiagnosticsReport {
	const uniqueByAngle: Partial<Record<AngleId, number>> = {};
	const uniqueByModel: Partial<Record<ProviderId, string[]>> = {};
	let unanimous = 0;

	for (const concept of input.concepts) {
		const angles = Object.keys(concept.angle_provenance) as AngleId[];

		if (angles.length === 1) {
			const angle = angles[0];
			if (angle) uniqueByAngle[angle] = (uniqueByAngle[angle] ?? 0) + 1;
		}

		const allModels = new Set<ProviderId>();
		for (const prov of Object.values(concept.angle_provenance)) {
			if (!prov) continue;
			for (const m of prov.models) allModels.add(m);
		}
		if (allModels.size === 1) {
			const [only] = [...allModels];
			if (only) {
				const arr = uniqueByModel[only] ?? [];
				arr.push(concept.canonical_term);
				uniqueByModel[only] = arr;
			}
		}

		const has3PlusAngles = angles.length >= 3;
		const hasUnanimousAngle = Object.values(concept.angle_provenance).some(
			(p) => p?.consensus === "3/3",
		);
		if (has3PlusAngles && hasUnanimousAngle) unanimous++;
	}

	return {
		unique_by_angle: uniqueByAngle,
		unique_by_model: uniqueByModel,
		unanimous_concepts: unanimous,
		total_after_inter_angle: input.concepts.length,
		fragile: input.fragile ?? 0,
	};
}
