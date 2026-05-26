import { createHash } from "node:crypto";
import { templateFor } from "./templates.js";
import type { ProcLogEvent, ProcLogLevel } from "./types.js";

/**
 * Maximum number of lines a single incident may span. Caps runaway "every
 * subsequent line is part of one giant error" output (some CI tools).
 */
export const MAX_INCIDENT_LINES = 200;

/**
 * Tags that mark the *header* of an incident. Stack-frame and traceback
 * tags are continuation markers — they're collected into the surrounding
 * incident, not started as a new one.
 */
const HEADER_TAGS = new Set([
	"error",
	"fatal",
	"exception",
	"panic",
	"traceback", // Python's "Traceback (most recent call last):" starts an incident.
	"module-not-found",
	"address-in-use",
	"typescript",
	"compile",
	"bundler",
	"errno",
	"http-5xx",
	"user-error",
	"vite",
	"next",
	"rustc",
	"cargo",
	"maven",
	"gradle",
	"pytest-failed",
	"vitest",
	"jest",
]);

const CONTINUATION_TAGS = new Set([
	"stack-frame",
	"pytest-error",
]);

/**
 * Continuation patterns matched against `ansiStripped` text of the *next*
 * line after an incident header. If any matches, the line is folded into
 * the current incident.
 */
const CONTINUATION_PATTERNS: RegExp[] = [
	/^\s+at\s+/, // JS-style stack frame ("    at fn (file:line:col)")
	/^\s{2,}File\s+"[^"]+",\s+line\s+\d+/, // Python frame
	/^\s*Caused by:/i,
	/^\s*\.\.\.\s/,
	/^\s+\| /, // Rust error continuation
	/^\s*-->\s+\S+:\d+:\d+/, // Rust source pointer
	/^\s*=\s/, // Rust note/help bullet
	/^\s{2,}\^+/, // Caret underlines under source
];

function isContinuation(event: ProcLogEvent): boolean {
	for (const tag of event.tags) {
		if (CONTINUATION_TAGS.has(tag)) return true;
	}
	return CONTINUATION_PATTERNS.some((pat) => pat.test(event.ansiStripped));
}

function isHeader(event: ProcLogEvent): boolean {
	if (event.level !== "error") return false;
	for (const tag of event.tags) {
		if (HEADER_TAGS.has(tag)) return true;
	}
	return false;
}

export interface Incident {
	startSeq: number;
	endSeq: number;
	level: ProcLogLevel;
	tags: string[];
	header: ProcLogEvent;
	members: ProcLogEvent[];
	summary: string;
	fingerprint: string;
}

function fingerprintFor(header: ProcLogEvent): string {
	const template = templateFor(header.ansiStripped);
	return createHash("sha1").update(template).digest("hex").slice(0, 16);
}

function finalise(header: ProcLogEvent, members: ProcLogEvent[]): Incident {
	const tagSet = new Set<string>();
	for (const m of members) for (const t of m.tags) tagSet.add(t);
	const summary = header.ansiStripped.slice(0, 200);
	return {
		startSeq: header.seq,
		endSeq: members[members.length - 1].seq,
		level: header.level,
		tags: Array.from(tagSet),
		header,
		members,
		summary,
		fingerprint: fingerprintFor(header),
	};
}

/**
 * Group adjacent log events into incidents. An incident starts at an event
 * tagged with one of `HEADER_TAGS` and continues until:
 *   - a non-continuation line is encountered, OR
 *   - the incident reaches `MAX_INCIDENT_LINES`, OR
 *   - we run out of events.
 *
 * Non-error events outside incidents are dropped from the output (this is
 * an incident extractor, not a filter — callers wanting raw events should
 * just use `iterateEvents`).
 */
export function coalesceIncidents(events: readonly ProcLogEvent[]): Incident[] {
	const incidents: Incident[] = [];
	let i = 0;
	while (i < events.length) {
		const event = events[i];
		if (!isHeader(event)) {
			i++;
			continue;
		}
		const members: ProcLogEvent[] = [event];
		let j = i + 1;
		while (
			j < events.length &&
			members.length < MAX_INCIDENT_LINES &&
			(isContinuation(events[j]) || isAnotherStackFrame(events[j], event))
		) {
			members.push(events[j]);
			j++;
		}
		incidents.push(finalise(event, members));
		i = j;
	}
	return incidents;
}

// Header lines like "Error: foo" may be followed by stack frames AND by
// "Caused by:" blocks that also begin with "Error:". To allow chaining we
// treat a subsequent header-tagged line as a continuation IFF the
// surrounding text indicates a follow-up (e.g. "Caused by:" or "at " above
// it). For simplicity v1: only the explicit CONTINUATION_TAGS / patterns
// continue an incident.
function isAnotherStackFrame(
	_candidate: ProcLogEvent,
	_header: ProcLogEvent,
): boolean {
	return false;
}

/**
 * Stream-friendly variant: yields incidents as soon as their continuation
 * window closes. Useful for `--first-failure` mode where the caller can
 * stop after the first yield.
 */
export async function* iterateIncidents(
	source: AsyncIterable<ProcLogEvent>,
): AsyncIterable<Incident> {
	let header: ProcLogEvent | null = null;
	let members: ProcLogEvent[] = [];

	for await (const event of source) {
		if (header === null) {
			if (isHeader(event)) {
				header = event;
				members = [event];
			}
			continue;
		}
		if (members.length < MAX_INCIDENT_LINES && isContinuation(event)) {
			members.push(event);
			continue;
		}
		yield finalise(header, members);
		header = isHeader(event) ? event : null;
		members = header ? [event] : [];
	}
	if (header) yield finalise(header, members);
}
