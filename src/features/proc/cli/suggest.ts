/**
 * Tiny Levenshtein implementation (Wagner–Fischer with row-rotation). No
 * deps; fast enough for the run-name lists we deal with (dozens to low
 * hundreds of candidates).
 */
function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let prev = new Array<number>(b.length + 1);
	let curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(
				curr[j - 1] + 1,
				prev[j] + 1,
				prev[j - 1] + cost,
			);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[b.length];
}

/**
 * Return up to `cap` candidates from `candidates` whose Levenshtein
 * distance to `input` is at most `maxDistance`, ordered nearest first.
 *
 * Default thresholds are tuned for command/run names where a typo is
 * usually 1–2 characters off.
 */
export function suggest(
	input: string,
	candidates: readonly string[],
	options: { maxDistance?: number; cap?: number } = {},
): string[] {
	const maxDistance = options.maxDistance ?? 3;
	const cap = options.cap ?? 3;
	return candidates
		.map((c) => ({ candidate: c, distance: levenshtein(input, c) }))
		.filter(({ distance }) => distance <= maxDistance)
		.sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
		.slice(0, cap)
		.map(({ candidate }) => candidate);
}

/**
 * Build a "did you mean … ?" hint string from suggestions, or `undefined`
 * if there are none.
 */
export function didYouMean(suggestions: string[]): string | undefined {
	if (suggestions.length === 0) return undefined;
	if (suggestions.length === 1) return `Did you mean "${suggestions[0]}"?`;
	const quoted = suggestions.map((s) => `"${s}"`).join(", ");
	return `Did you mean one of: ${quoted}?`;
}
