import path from "node:path";
import { coalesceIncidents, type Incident } from "./incidents.js";
import { iterateEvents } from "./log-segments.js";
import { tailRunEvents } from "./log-tailer.js";
import { readCursor, resolveRun, writeCursor } from "./store.js";
import {
	selectRare,
	sortedByCount,
	tallyTemplates,
	type TemplateBucket,
} from "./templates.js";
import type {
	IncidentWire,
	ProcLogEvent,
	ProcLogLevel,
	ProcLogsQuery,
	ProcLogsQueryResult,
	ProcRun,
	TemplateBucketWire,
} from "./types.js";
import { isTerminalStatus } from "./types.js";

const DEFAULT_LIMIT = 100;
const HARD_LIMIT = 500;
const DEFAULT_CONTEXT_LINES = 2;
const DEFAULT_MAX_LINE_BYTES = 1024;

function parseTime(
	value: string | undefined,
	now = Date.now(),
): number | undefined {
	if (!value) return undefined;
	const duration = value.match(/^(\d+)(ms|s|m|h|d)$/i);
	if (duration) {
		const amount = Number(duration[1]);
		const unit = duration[2].toLowerCase();
		const multiplier =
			unit === "ms"
				? 1
				: unit === "s"
					? 1000
					: unit === "m"
						? 60_000
						: unit === "h"
							? 3_600_000
							: 86_400_000;
		return now - amount * multiplier;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function levelMatches(
	eventLevel: ProcLogLevel,
	requested?: ProcLogLevel,
): boolean {
	if (!requested) return true;
	return eventLevel === requested;
}

function streamMatches(
	event: ProcLogEvent,
	requested: ProcLogsQuery["stream"],
): boolean {
	if (!requested || requested === "both") return true;
	return event.stream === requested;
}

function matchEvent(
	event: ProcLogEvent,
	query: ProcLogsQuery,
	requestedLevel: ProcLogLevel | undefined,
): boolean {
	if (!streamMatches(event, query.stream)) return false;
	if (!levelMatches(event.level, requestedLevel)) return false;
	if (!textMatches(event, query)) return false;
	return true;
}

function modeLevel(mode: ProcLogsQuery["mode"]): ProcLogLevel | undefined {
	if (mode === "errors") return "error";
	if (mode === "warnings") return "warn";
	return undefined;
}

function textMatches(
	event: ProcLogEvent,
	query: Pick<ProcLogsQuery, "contains" | "regex" | "caseSensitive">,
): boolean {
	const text = event.ansiStripped || event.line;
	if (query.contains) {
		const haystack = query.caseSensitive ? text : text.toLowerCase();
		const needle = query.caseSensitive
			? query.contains
			: query.contains.toLowerCase();
		if (!haystack.includes(needle)) return false;
	}
	if (query.regex) {
		const regex = new RegExp(query.regex, query.caseSensitive ? "" : "i");
		if (!regex.test(text)) return false;
	}
	return true;
}

function truncateLine(line: string, maxBytes: number): string {
	if (maxBytes <= 0) return line;
	if (Buffer.byteLength(line, "utf8") <= maxBytes) return line;
	let lo = 0;
	let hi = line.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (Buffer.byteLength(line.slice(0, mid), "utf8") <= maxBytes - 14) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return `${line.slice(0, lo)}…[truncated]`;
}

function runLabel(run: ProcRun): string {
	return run.meta.name
		? `${run.meta.name}#${run.meta.runId.slice(0, 8)}`
		: run.meta.runId.slice(0, 8);
}

export function formatLogEvents(
	events: ProcLogEvent[],
	options: {
		label?: string;
		maxLineBytes?: number;
		format?: "compact" | "full";
	} = {},
): string {
	const max = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
	const format = options.format ?? "full";
	return events
		.map((event) => {
			const time = event.ts.split("T")[1]?.replace("Z", "") ?? event.ts;
			const body = truncateLine(event.ansiStripped, max);
			if (format === "compact") return `${time} ${body}`;
			const labelPrefix = options.label ? `[${options.label}] ` : "";
			return `${labelPrefix}${time} #${event.seq} ${event.stream} ${event.level}: ${body}`;
		})
		.join("\n");
}

const MAX_WAIT_MS = 60_000;

async function waitForMatch(
	runId: string,
	query: ProcLogsQuery,
	requestedLevel: ProcLogLevel | undefined,
	sinceSeq: number,
	waitMs: number,
): Promise<ProcLogEvent | null> {
	const tailer = await tailRunEvents(runId, {
		sinceSeq,
		maxWaitMs: Math.min(Math.max(0, waitMs), MAX_WAIT_MS),
	});
	return new Promise<ProcLogEvent | null>((resolve) => {
		let settled = false;
		const finish = (event: ProcLogEvent | null) => {
			if (settled) return;
			settled = true;
			tailer.close();
			resolve(event);
		};
		tailer.onEvent((event) => {
			if (matchEvent(event, query, requestedLevel)) finish(event);
		});
		tailer.onTerminal(() => finish(null));
	});
}

export async function queryProcLogs(
	query: ProcLogsQuery,
): Promise<ProcLogsQueryResult> {
	const mode = query.mode ?? "errors";
	const requestedLimit = query.limit ?? DEFAULT_LIMIT;
	const limit = Math.min(Math.max(1, requestedLimit), HARD_LIMIT);
	const contextLines = query.contextLines ?? DEFAULT_CONTEXT_LINES;
	const maxLineBytes = query.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;

	const run = await resolveRun({
		runId: query.runId,
		name: query.name,
		cwd: query.cwd ? path.resolve(query.cwd) : undefined,
	});
	if (!run) {
		return {
			run: null,
			events: [],
			matchedCount: 0,
			returnedCount: 0,
			summary: "No matching proc run found.",
		};
	}

	// Direct lookup by seq: bypass mode/level/text/cursor and return the event
	// untruncated. Callers reach for this when a `…[truncated]` marker chopped
	// a stack trace and they need the full payload.
	if (query.seq !== undefined) {
		const target = query.seq;
		for await (const event of iterateEvents(run.meta.runId, {
			sinceSeq: target - 1,
		})) {
			if (event.seq === target) {
				return {
					run,
					events: [event],
					matchedCount: 1,
					returnedCount: 1,
					summary: `Returning seq #${event.seq} untruncated for ${runLabel(run)}.`,
				};
			}
			if (event.seq > target) break;
		}
		return {
			run,
			events: [],
			matchedCount: 0,
			returnedCount: 0,
			summary: `No event with seq #${target} for ${runLabel(run)}.`,
		};
	}

	const now = Date.now();
	const since = parseTime(query.since, now);
	const until = parseTime(query.until, now);

	let minSeq: number | undefined;
	let cursorUpdated = false;
	if (mode === "since_last_query" && query.cursorKey) {
		const cursor = await readCursor(query.cursorKey);
		minSeq = cursor[run.meta.runId];
	}

	const requestedLevel = query.level ?? modeLevel(mode);

	// Two-pass approach: first stream all events into memory to allow context
	// expansion. With segment-aware iteration this remains cheap because
	// `iterateEvents` filters by seq/ts at the segment boundary level.
	const events: ProcLogEvent[] = [];
	for await (const event of iterateEvents(run.meta.runId, {
		sinceSeq: minSeq,
		sinceTs: since,
		untilTs: until,
	})) {
		if (mode === "startup" && events.length >= 400) break;
		events.push(event);
	}

	// Smart modes: dispatch before the matchedIndexes path. These modes have
	// their own selection logic and don't run through matchEvent / context.
	if (
		mode === "first_failure" ||
		mode === "incidents" ||
		mode === "templates" ||
		mode === "rare"
	) {
		return buildSmartResult({
			run,
			mode,
			events,
			limit,
			contextLines,
			maxLineBytes,
			rareThreshold: query.rareThreshold ?? 2,
		});
	}

	const matchedIndexes: number[] = [];
	for (const [index, event] of events.entries()) {
		if (matchEvent(event, query, requestedLevel)) matchedIndexes.push(index);
	}

	// Block waiting for the first matching event when the caller opted in and
	// the initial scan came up empty. We only wait while the run is still
	// active — a terminal run will never produce new events.
	let waitedMs: number | null = null;
	if (
		query.waitMs &&
		query.waitMs > 0 &&
		matchedIndexes.length === 0 &&
		!isTerminalStatus(run.state.status)
	) {
		// Start the tailer past whichever is higher: the last event we already
		// scanned (so we don't double-process), or the cursor's last-seen seq (so
		// `since_last_query` waiters don't replay history).
		const lastSeen = events.length > 0 ? events[events.length - 1].seq : -1;
		const baseline = Math.max(lastSeen, minSeq ?? -1);
		const started = Date.now();
		const tailed = await waitForMatch(
			run.meta.runId,
			query,
			requestedLevel,
			baseline,
			query.waitMs,
		);
		waitedMs = Date.now() - started;
		if (tailed) {
			events.push(tailed);
			matchedIndexes.push(events.length - 1);
		}
	}

	let returned: ProcLogEvent[];
	if (mode === "recent" || mode === "startup" || contextLines <= 0) {
		returned = matchedIndexes
			.slice(-limit)
			.map((index) => events[index])
			.filter((event): event is ProcLogEvent => Boolean(event));
	} else {
		const selectedMatches = matchedIndexes.slice(-limit);
		const indexes = new Set<number>();
		for (const index of selectedMatches) {
			const start = Math.max(0, index - contextLines);
			const end = Math.min(events.length - 1, index + contextLines);
			for (let i = start; i <= end; i++) indexes.add(i);
		}
		returned = Array.from(indexes)
			.sort((a, b) => a - b)
			.map((index) => events[index])
			.filter((event): event is ProcLogEvent => Boolean(event));
	}

	if (mode === "since_last_query" && query.cursorKey) {
		const cursor = await readCursor(query.cursorKey);
		const maxSeq = events.reduce(
			(max, event) => Math.max(max, event.seq),
			cursor[run.meta.runId] ?? -1,
		);
		cursor[run.meta.runId] = maxSeq;
		await writeCursor(query.cursorKey, cursor);
		cursorUpdated = true;
	}

	const label = runLabel(run);
	const extra =
		returned.length > matchedIndexes.length
			? " (with context)"
			: matchedIndexes.length > returned.length
				? " (limit hit)"
				: "";
	const waitSuffix =
		waitedMs !== null && matchedIndexes.length > 0
			? ` after waiting ${waitedMs}ms`
			: "";
	const summary =
		returned.length === 0
			? emptySummary({
					label,
					mode,
					effectiveLevel: requestedLevel,
					contains: query.contains,
					regex: query.regex,
					waitedMs,
				})
			: `Found ${matchedIndexes.length} matching ${mode} event(s) for ${label}${waitSuffix}; returning ${returned.length}${extra}.`;

	// Apply line truncation in the returned event objects too, so any
	// downstream renderer sees the already-bounded text.
	const truncated = returned.map((event) =>
		Buffer.byteLength(event.ansiStripped, "utf8") <= maxLineBytes
			? event
			: {
					...event,
					ansiStripped: truncateLine(event.ansiStripped, maxLineBytes),
				},
	);

	return {
		run,
		events: truncated,
		matchedCount: matchedIndexes.length,
		returnedCount: truncated.length,
		summary,
		cursorUpdated,
	};
}

export function getRunLabel(run: ProcRun): string {
	return runLabel(run);
}

function describeTextFilter(
	contains: string | undefined,
	regex: string | undefined,
): string | null {
	const parts: string[] = [];
	if (contains) parts.push(`contains '${contains}'`);
	if (regex) parts.push(`regex /${regex}/`);
	return parts.length > 0 ? parts.join(" and ") : null;
}

function emptySummary(args: {
	label: string;
	mode: ProcLogsQuery["mode"];
	effectiveLevel: ProcLogLevel | undefined;
	contains: string | undefined;
	regex: string | undefined;
	waitedMs?: number | null;
}): string {
	const { label, mode, effectiveLevel, contains, regex, waitedMs } = args;
	const filter = describeTextFilter(contains, regex);
	const waitedSuffix =
		waitedMs !== null && waitedMs !== undefined
			? ` (waited ${waitedMs}ms)`
			: "";
	if (effectiveLevel && filter) {
		return `No ${effectiveLevel}-level events matched ${filter} for ${label}${waitedSuffix}. Try mode:'recent' to search all events.`;
	}
	if (effectiveLevel) {
		return `No ${effectiveLevel}-level events for ${label}${waitedSuffix}.`;
	}
	if (filter) {
		return `No events matched ${filter} for ${label}${waitedSuffix}.`;
	}
	return `No ${mode ?? "matching"} events for ${label}${waitedSuffix}.`;
}

// ---------- Smart modes (first_failure, incidents, templates, rare) ----------

interface SmartArgs {
	run: ProcRun;
	mode: "first_failure" | "incidents" | "templates" | "rare";
	events: ProcLogEvent[];
	limit: number;
	contextLines: number;
	maxLineBytes: number;
	rareThreshold: number;
}

function truncateEvent(event: ProcLogEvent, maxBytes: number): ProcLogEvent {
	if (
		maxBytes <= 0 ||
		Buffer.byteLength(event.ansiStripped, "utf8") <= maxBytes
	) {
		return event;
	}
	return {
		...event,
		ansiStripped: truncateLine(event.ansiStripped, maxBytes),
	};
}

function bucketToWire(bucket: TemplateBucket): TemplateBucketWire {
	return {
		template: bucket.template,
		count: bucket.count,
		level: bucket.level,
		firstSeq: bucket.firstSeq,
		lastSeq: bucket.lastSeq,
		exampleLine: bucket.exampleLine,
	};
}

function incidentToWire(inc: Incident): IncidentWire {
	return {
		startSeq: inc.startSeq,
		endSeq: inc.endSeq,
		level: inc.level,
		tags: inc.tags,
		summary: inc.summary,
		fingerprint: inc.fingerprint,
		memberCount: inc.members.length,
	};
}

function buildSmartResult(args: SmartArgs): ProcLogsQueryResult {
	const { run, mode, events, limit, contextLines, maxLineBytes, rareThreshold } =
		args;
	const label = runLabel(run);

	if (mode === "first_failure") {
		const incidents = coalesceIncidents(events);
		if (incidents.length === 0) {
			return {
				run,
				events: [],
				matchedCount: 0,
				returnedCount: 0,
				summary: `No failures detected for ${label}.`,
				incidents: [],
			};
		}
		const first = incidents[0];
		// Build context: contextLines events preceding the header + every
		// member of the incident.
		const headerIdx = events.findIndex((e) => e.seq === first.startSeq);
		const startIdx = Math.max(0, headerIdx - contextLines);
		const endIdx = Math.min(
			events.length - 1,
			headerIdx + first.members.length - 1,
		);
		const selected = events
			.slice(startIdx, endIdx + 1)
			.map((e) => truncateEvent(e, maxLineBytes));
		return {
			run,
			events: selected,
			matchedCount: 1,
			returnedCount: selected.length,
			summary: `First failure for ${label} at seq #${first.startSeq} (${first.header.ts}): ${first.tags.join(", ") || "error"}. Returning ${contextLines} preceding line(s) + ${first.members.length} incident line(s).`,
			incidents: [incidentToWire(first)],
		};
	}

	if (mode === "incidents") {
		const all = coalesceIncidents(events);
		const slice = all.slice(-limit);
		const selectedSeqs = new Set<number>();
		for (const inc of slice) {
			for (const m of inc.members) selectedSeqs.add(m.seq);
		}
		const selected = events
			.filter((e) => selectedSeqs.has(e.seq))
			.map((e) => truncateEvent(e, maxLineBytes));
		return {
			run,
			events: selected,
			matchedCount: all.length,
			returnedCount: selected.length,
			summary:
				all.length === 0
					? `No incidents for ${label}.`
					: `Found ${all.length} incident(s) for ${label}; returning ${slice.length}${all.length > slice.length ? " (limit hit)" : ""}.`,
			incidents: slice.map(incidentToWire),
		};
	}

	if (mode === "templates") {
		const buckets = tallyTemplates(events);
		const sorted = sortedByCount(buckets.values()).slice(0, limit);
		return {
			run,
			events: [],
			matchedCount: buckets.size,
			returnedCount: sorted.length,
			summary:
				buckets.size === 0
					? `No events to template for ${label}.`
					: `Tallied ${buckets.size} template(s) across ${events.length} event(s) for ${label}; returning top ${sorted.length}.`,
			templates: sorted.map(bucketToWire),
		};
	}

	// mode === "rare"
	const buckets = tallyTemplates(events);
	const rare = selectRare(events, buckets, rareThreshold).map((e) =>
		truncateEvent(e, maxLineBytes),
	);
	const limited = rare.slice(-limit);
	return {
		run,
		events: limited,
		matchedCount: rare.length,
		returnedCount: limited.length,
		summary:
			rare.length === 0
				? `No rare events (template count ≤ ${rareThreshold}) for ${label}.`
				: `Found ${rare.length} rare event(s) (template count ≤ ${rareThreshold}) for ${label}; returning ${limited.length}${rare.length > limited.length ? " (limit hit)" : ""}.`,
	};
}
