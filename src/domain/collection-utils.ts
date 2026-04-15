/**
 * Return the most frequent value in an array. Tie-break: first-encountered wins
 * (deterministic given stable input order).
 */
export function mostFrequent<T>(values: T[]): T {
	if (values.length === 0) throw new Error("mostFrequent: empty array");
	const counts = new Map<T, { count: number; firstIndex: number }>();
	values.forEach((v, i) => {
		const entry = counts.get(v);
		if (entry) entry.count++;
		else counts.set(v, { count: 1, firstIndex: i });
	});
	let best: T = values[0] as T;
	let bestCount = -1;
	let bestFirstIndex = Number.POSITIVE_INFINITY;
	for (const [value, { count, firstIndex }] of counts) {
		if (count > bestCount || (count === bestCount && firstIndex < bestFirstIndex)) {
			best = value;
			bestCount = count;
			bestFirstIndex = firstIndex;
		}
	}
	return best;
}

/** Substitute `{key}` placeholders in a template string with values from `vars`. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
	let out = template;
	for (const [key, value] of Object.entries(vars)) {
		out = out.split(`{${key}}`).join(value);
	}
	return out;
}
