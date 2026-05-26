/**
 * Tiny glob → regex helper. Supports only:
 *   *  — any run of characters (including empty)
 *   ?  — exactly one character
 * Everything else is literal. Pattern is anchored to the full string.
 *
 * Avoids pulling in a glob dep for what's effectively a 5-line need
 * (filtering run names in `pi-proc prune --name <pattern>`).
 */
export function globToRegex(pattern: string): RegExp {
	// Escape regex specials EXCEPT `*` and `?`, then expand those.
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const expanded = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${expanded}$`);
}

/** Convenience: test a single value against a glob pattern. */
export function matchesGlob(pattern: string, value: string): boolean {
	return globToRegex(pattern).test(value);
}
