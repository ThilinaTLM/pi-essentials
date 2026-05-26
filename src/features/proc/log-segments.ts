import { createReadStream, existsSync } from "node:fs";
import { appendFile, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
	eventsPath,
	rawLogPath,
	runDir,
	segmentsIndexPath,
	writeJsonAtomic,
} from "./store.js";
import type {
	LogSegmentEntry,
	LogSegmentsIndex,
	ProcLogEvent,
	ProcStream,
} from "./types.js";

export type SegmentKind = "events" | "stdout" | "stderr";

function envNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function rotateBytes(): number {
	return envNumber("PI_PROC_ROTATE_BYTES", 8 * 1024 * 1024);
}

export function maxSegmentsPerKind(): number {
	return envNumber("PI_PROC_MAX_SEGMENTS", 8);
}

export function activeSegmentPath(
	runId: string,
	kind: SegmentKind,
	root?: string,
): string {
	if (kind === "events") return eventsPath(runId, root);
	return rawLogPath(runId, kind, root);
}

function rotatedSegmentPath(
	runId: string,
	kind: SegmentKind,
	index: number,
	root?: string,
): string {
	const dir = runDir(runId, root);
	const padded = String(index).padStart(3, "0");
	if (kind === "events") return path.join(dir, `events.${padded}.ndjson`);
	return path.join(dir, `${kind}.${padded}.log`);
}

const EMPTY_INDEX: LogSegmentsIndex = { updatedAt: "", segments: [] };

export async function loadSegmentsIndex(
	runId: string,
	root?: string,
): Promise<LogSegmentsIndex> {
	const indexPath = segmentsIndexPath(runId, root);
	if (!existsSync(indexPath)) return { ...EMPTY_INDEX };
	try {
		const raw = await readFile(indexPath, "utf8");
		return JSON.parse(raw) as LogSegmentsIndex;
	} catch {
		return { ...EMPTY_INDEX };
	}
}

export async function saveSegmentsIndex(
	runId: string,
	index: LogSegmentsIndex,
	root?: string,
): Promise<void> {
	const next: LogSegmentsIndex = {
		updatedAt: new Date().toISOString(),
		segments: index.segments,
	};
	await writeJsonAtomic(segmentsIndexPath(runId, root), next);
}

function nextRotationIndex(index: LogSegmentsIndex, kind: SegmentKind): number {
	const existing = index.segments.filter((s) => s.kind === kind);
	if (existing.length === 0) return 0;
	return Math.max(...existing.map((s) => s.index)) + 1;
}

/**
 * Rotate the active segment for `kind` if it exceeds the configured size
 * threshold. Returns true when a rotation happened. Caller is responsible
 * for closing any open write streams to the active path before calling.
 */
export async function maybeRotate(
	runId: string,
	kind: SegmentKind,
	stats: {
		firstSeq: number | null;
		lastSeq: number | null;
		firstTs: string | null;
		lastTs: string | null;
		bytes: number;
	},
	root?: string,
): Promise<boolean> {
	if (stats.bytes < rotateBytes()) return false;
	const active = activeSegmentPath(runId, kind, root);
	if (!existsSync(active)) return false;

	const index = await loadSegmentsIndex(runId, root);
	const rotationIndex = nextRotationIndex(index, kind);
	const rotatedPath = rotatedSegmentPath(runId, kind, rotationIndex, root);
	await rename(active, rotatedPath);

	const entry: LogSegmentEntry = {
		path: path.basename(rotatedPath),
		kind,
		index: rotationIndex,
		firstSeq: stats.firstSeq,
		lastSeq: stats.lastSeq,
		firstTs: stats.firstTs,
		lastTs: stats.lastTs,
		bytes: stats.bytes,
	};
	index.segments.push(entry);

	// Prune old segments of this kind.
	const ofKind = index.segments
		.filter((s) => s.kind === kind)
		.sort((a, b) => a.index - b.index);
	const excess = ofKind.length - maxSegmentsPerKind();
	if (excess > 0) {
		const toRemove = ofKind.slice(0, excess);
		for (const seg of toRemove) {
			await unlink(path.join(runDir(runId, root), seg.path)).catch(
				() => undefined,
			);
		}
		const removePaths = new Set(toRemove.map((s) => s.path));
		index.segments = index.segments.filter((s) => !removePaths.has(s.path));
	}

	await saveSegmentsIndex(runId, index, root);
	return true;
}

/**
 * List all segments for a kind in chronological order (oldest first),
 * including the active segment at the end.
 */
export async function listSegments(
	runId: string,
	kind: SegmentKind,
	root?: string,
): Promise<Array<{ path: string; entry: LogSegmentEntry | null }>> {
	const index = await loadSegmentsIndex(runId, root);
	const rotated: Array<{ path: string; entry: LogSegmentEntry | null }> =
		index.segments
			.filter((s) => s.kind === kind)
			.sort((a, b) => a.index - b.index)
			.map((entry) => ({
				path: path.join(runDir(runId, root), entry.path),
				entry,
			}));
	const active = activeSegmentPath(runId, kind, root);
	if (existsSync(active)) rotated.push({ path: active, entry: null });
	return rotated;
}

export interface EventIterateOptions {
	sinceSeq?: number;
	sinceTs?: number;
	untilTs?: number;
}

/**
 * Stream events from a run's segments in seq order. Filters out events that
 * fall outside the seq/ts window before yielding. Iteration is bounded by
 * `signal` if provided.
 */
export async function* iterateEvents(
	runId: string,
	options: EventIterateOptions = {},
	root?: string,
): AsyncGenerator<ProcLogEvent> {
	const segments = await listSegments(runId, "events", root);
	for (const { path: segPath, entry } of segments) {
		// Skip rotated segments whose last seq/ts is before the lower bound.
		if (entry) {
			if (
				options.sinceSeq !== undefined &&
				entry.lastSeq !== null &&
				entry.lastSeq < options.sinceSeq
			)
				continue;
			if (
				options.sinceTs !== undefined &&
				entry.lastTs !== null &&
				Date.parse(entry.lastTs) < options.sinceTs
			)
				continue;
		}
		if (!existsSync(segPath)) continue;
		const stream = createReadStream(segPath, { encoding: "utf8" });
		const rl = createInterface({ input: stream, crlfDelay: Infinity });
		try {
			for await (const line of rl) {
				if (!line) continue;
				let event: ProcLogEvent;
				try {
					event = JSON.parse(line) as ProcLogEvent;
				} catch {
					continue;
				}
				if (options.sinceSeq !== undefined && event.seq <= options.sinceSeq)
					continue;
				const eventTs = Date.parse(event.ts);
				if (
					options.sinceTs !== undefined &&
					Number.isFinite(eventTs) &&
					eventTs < options.sinceTs
				)
					continue;
				if (
					options.untilTs !== undefined &&
					Number.isFinite(eventTs) &&
					eventTs > options.untilTs
				)
					continue;
				yield event;
			}
		} finally {
			rl.close();
			stream.close();
		}
	}
}

/**
 * Append an event to the active events segment. Used in tests and any
 * out-of-band tooling; the supervisor's EventSink writes directly to its
 * open WriteStream for throughput.
 */
export async function appendEvent(
	event: ProcLogEvent,
	root?: string,
): Promise<void> {
	await appendFile(
		eventsPath(event.runId, root),
		`${JSON.stringify(event)}\n`,
		"utf8",
	);
}

export async function appendRaw(
	runId: string,
	stream: ProcStream,
	chunk: Buffer | string,
	root?: string,
): Promise<void> {
	await appendFile(rawLogPath(runId, stream, root), chunk);
}

/**
 * Get the active segment size on disk, or 0 if it doesn't exist yet.
 */
export async function activeSegmentSize(
	runId: string,
	kind: SegmentKind,
	root?: string,
): Promise<number> {
	const active = activeSegmentPath(runId, kind, root);
	if (!existsSync(active)) return 0;
	try {
		const s = await stat(active);
		return s.size;
	} catch {
		return 0;
	}
}
