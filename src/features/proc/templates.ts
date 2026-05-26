import type { ProcLogEvent, ProcLogLevel } from "./types.js";

/**
 * Replace volatile tokens (timestamps, UUIDs, numbers, URLs, quoted
 * strings) with placeholder symbols before hashing. The result is a
 * line "template" that groups e.g.
 *   "Request 42 took 100ms"
 *   "Request 7  took   3ms"
 * into one bucket.
 *
 * The patterns are ordered: more-specific first (timestamp, UUID) so they
 * don't get pre-consumed by the generic `\b\d+\b` rule.
 */
const TOKEN_MASK_PATTERNS: ReadonlyArray<[RegExp, string]> = [
	[/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?\b/g, "<TS>"],
	[/\b\d{4}-\d{2}-\d{2}\b/g, "<DATE>"],
	[/\b\d{2}:\d{2}:\d{2}(\.\d+)?\b/g, "<TIME>"],
	[
		/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
		"<UUID>",
	],
	[/\b0x[0-9a-f]+\b/gi, "<HEX>"],
	[/https?:\/\/\S+/g, "<URL>"],
	[/"[^"]*"/g, "<STR>"],
	[/'[^']*'/g, "<STR>"],
	// Numbers, optionally followed by a short unit suffix (ms, s, MB, %, etc.).
	// Consuming the suffix means "Request 42 took 100ms" and "Request 7 took
	// 3s" hash to the same template.
	[/\b\d+(\.\d+)?[a-zA-Z%]{0,5}\b/g, "<N>"],
];

const TEMPLATE_TOKEN_LIMIT = 8;

/**
 * Compute the template bucket key for a single line. Masking is applied,
 * then the result is whitespace-normalised and truncated to the first
 * `TEMPLATE_TOKEN_LIMIT` tokens — keeps memory bounded for runs that emit
 * millions of unique long lines while still capturing the line shape.
 */
export function templateFor(line: string): string {
	let masked = line;
	for (const [pattern, sub] of TOKEN_MASK_PATTERNS) {
		masked = masked.replace(pattern, sub);
	}
	const tokens = masked.trim().split(/\s+/).slice(0, TEMPLATE_TOKEN_LIMIT);
	return tokens.join(" ");
}

export interface TemplateBucket {
	template: string;
	count: number;
	level: ProcLogLevel;
	firstSeq: number;
	lastSeq: number;
	exampleLine: string;
}

const LEVEL_RANK: Record<ProcLogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

function maxLevel(a: ProcLogLevel, b: ProcLogLevel): ProcLogLevel {
	return LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a;
}

/**
 * Tally events by template. Returns a Map keyed by template string so
 * callers can both lookup by template and iterate ordered output.
 */
export function tallyTemplates(
	events: readonly ProcLogEvent[],
): Map<string, TemplateBucket> {
	const buckets = new Map<string, TemplateBucket>();
	for (const event of events) {
		const template = templateFor(event.ansiStripped);
		const existing = buckets.get(template);
		if (existing) {
			existing.count++;
			existing.lastSeq = event.seq;
			existing.level = maxLevel(existing.level, event.level);
		} else {
			buckets.set(template, {
				template,
				count: 1,
				level: event.level,
				firstSeq: event.seq,
				lastSeq: event.seq,
				exampleLine: event.ansiStripped,
			});
		}
	}
	return buckets;
}

/**
 * Sort buckets descending by count, then ascending by firstSeq for stable
 * output when counts tie.
 */
export function sortedByCount(
	buckets: Iterable<TemplateBucket>,
): TemplateBucket[] {
	return Array.from(buckets).sort((a, b) => {
		if (b.count !== a.count) return b.count - a.count;
		return a.firstSeq - b.firstSeq;
	});
}

/**
 * Pick events whose template appears at most `maxCount` times in the
 * supplied tally. Anomaly surface for "what's different about this run".
 */
export function selectRare(
	events: readonly ProcLogEvent[],
	buckets: Map<string, TemplateBucket>,
	maxCount = 2,
): ProcLogEvent[] {
	const rare: ProcLogEvent[] = [];
	for (const event of events) {
		const template = templateFor(event.ansiStripped);
		const bucket = buckets.get(template);
		if (bucket && bucket.count <= maxCount) rare.push(event);
	}
	return rare;
}
