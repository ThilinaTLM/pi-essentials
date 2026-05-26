export type ProcStream = "stdout" | "stderr";
export type ProcLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Run lifecycle status. Transitions are persisted by the supervisor.
 *
 *   starting → running → exited      // child closed with code 0
 *                      → failed      // child closed with code != 0
 *                      → stopped     // user-initiated stop succeeded
 *                      → crashed     // child gone without a close event
 *   running   → orphaned             // supervisor itself disappeared
 *
 * "stale" is retained as an alias for `orphaned` for backwards compatibility
 * with old callers in tests; new code should not produce it.
 */
export type ProcStatus =
	| "starting"
	| "running"
	| "exited"
	| "failed"
	| "stopped"
	| "crashed"
	| "orphaned"
	| "stale";

export const TERMINAL_STATUSES: ProcStatus[] = [
	"exited",
	"failed",
	"stopped",
	"crashed",
	"orphaned",
	"stale",
];

export const ACTIVE_STATUSES: ProcStatus[] = ["starting", "running"];

export function isTerminalStatus(status: ProcStatus): boolean {
	return TERMINAL_STATUSES.includes(status);
}

export type PtyMode = "pty" | "pipe";

export interface ClassifyConfig {
	errorPatterns?: string[];
	readyPatterns?: string[];
}

/**
 * Policy describing what the supervisor should do when its child exits.
 *   - kind: "none" preserves the current behaviour: any exit is terminal.
 *   - kind: "restart" re-spawns the child with exponential backoff up to
 *     `max` attempts. After `max` restarts in a row (without resetting the
 *     counter via a clean exit), the supervisor gives up and reports the
 *     terminal status as usual.
 */
export interface OnExitPolicy {
	kind: "none" | "restart";
	/** Max restart attempts (default 5). */
	max?: number;
	/** Initial backoff in ms; doubled per attempt, capped at 60s (default 1000). */
	backoffMs?: number;
}

export interface ProcRunMeta {
	runId: string;
	name?: string;
	cwd: string;
	command: string;
	argv: string[];
	shell: boolean;
	startedAt: string;
	logDir: string;
	foreground: boolean;
	forceColor: boolean;
	env?: Record<string, string>;
	classify?: ClassifyConfig;
	readyPattern?: string;
	readyOnUrl?: boolean;
	onExit?: OnExitPolicy;
	/**
	 * When false (default), events whose `ansiStripped` body is empty AND whose
	 * raw `line` contained at least one ANSI escape are skipped. This drops
	 * cursor-move / clear-screen redraws (Vite, ink, etc.) without losing any
	 * lines the program wrote as content. Raw `stdout.log`/`stderr.log` files
	 * remain byte-faithful regardless.
	 */
	keepBlankLines?: boolean;
	/**
	 * When true (default), if a logical line contains one or more `\r`
	 * characters, only the segment after the final `\r` is persisted. This
	 * mirrors what a terminal would render and keeps progress-bar redraws
	 * (Gradle, npm, pip) from inflating event counts and `since_last_query`
	 * cursors.
	 */
	collapseProgress?: boolean;
}

export interface ProcRunState {
	status: ProcStatus;
	supervisorPid: number | null;
	childPid: number | null;
	lastEventAt: string | null;
	exitCode: number | null;
	signal: NodeJS.Signals | string | null;
	endedAt: string | null;
	detectedUrls: string[];
	ptyMode: PtyMode | null;
	readyAt: string | null;
	/** Number of automatic restarts this supervisor has performed. */
	restartCount?: number;
	/** ISO timestamp of the most recent automatic restart, if any. */
	lastRestartAt?: string;
}

export interface ProcRun {
	meta: ProcRunMeta;
	state: ProcRunState;
}

export interface ProcLogEvent {
	ts: string;
	runId: string;
	seq: number;
	stream: ProcStream;
	level: ProcLogLevel;
	line: string;
	ansiStripped: string;
	tags: string[];
}

export interface CreateRunOptions {
	name?: string;
	cwd: string;
	command: string;
	argv: string[];
	shell?: boolean;
	foreground: boolean;
	forceColor?: boolean;
	env?: Record<string, string>;
	classify?: ClassifyConfig;
	readyPattern?: string;
	readyOnUrl?: boolean;
	onExit?: OnExitPolicy;
	/** See `ProcRunMeta.keepBlankLines`. Default false. */
	keepBlankLines?: boolean;
	/** See `ProcRunMeta.collapseProgress`. Default true. */
	collapseProgress?: boolean;
}

export interface ProcRunFilter {
	runId?: string;
	name?: string;
	cwd?: string;
	/**
	 * How to interpret `cwd`. `"descendant"` (default) matches the directory
	 * itself and any subdirectory — useful when querying from a project
	 * root with multiple subprojects. `"exact"` matches the literal path.
	 */
	cwdMode?: "descendant" | "exact";
	status?: ProcStatus | "all";
	statusIn?: ProcStatus[];
	limit?: number;
}

export type ProcQueryMode =
	| "recent"
	| "errors"
	| "warnings"
	| "startup"
	| "since_last_query"
	/** First incident (error + continuation lines) plus preceding context. */
	| "first_failure"
	/** All incidents (grouped error + continuation lines), up to limit. */
	| "incidents"
	/** Aggregate templates with counts; events list will be empty, see `templates`. */
	| "templates"
	/** Lines whose template appears ≤ N times (anomalies); N defaults to 2. */
	| "rare";

export interface ProcLogsQuery {
	runId?: string;
	name?: string;
	cwd?: string;
	since?: string;
	until?: string;
	stream?: ProcStream | "both";
	level?: ProcLogLevel;
	mode?: ProcQueryMode;
	contains?: string;
	regex?: string;
	caseSensitive?: boolean;
	contextLines?: number;
	limit?: number;
	maxLineBytes?: number;
	cursorKey?: string;
	/** Return only the event with this exact seq, untruncated. Other filters are ignored. */
	seq?: number;
	/** Block up to this many ms waiting for the first matching event when the initial scan returns none. */
	waitMs?: number;
	/** Threshold for mode: "rare" — events whose template appears ≤ N times. Default 2. */
	rareThreshold?: number;
}

export interface TemplateBucketWire {
	template: string;
	count: number;
	level: ProcLogLevel;
	firstSeq: number;
	lastSeq: number;
	exampleLine: string;
}

export interface IncidentWire {
	startSeq: number;
	endSeq: number;
	level: ProcLogLevel;
	tags: string[];
	summary: string;
	fingerprint: string;
	memberCount: number;
}

export interface ProcLogsQueryResult {
	run: ProcRun | null;
	events: ProcLogEvent[];
	matchedCount: number;
	returnedCount: number;
	summary: string;
	cursorUpdated?: boolean;
	/** Set only by mode: "templates". */
	templates?: TemplateBucketWire[];
	/** Set by mode: "incidents" or "first_failure". */
	incidents?: IncidentWire[];
}

export interface StartDetachedResult {
	run: ProcRun;
	supervisorPid: number;
}

export interface StopResult {
	run: ProcRun | null;
	stopped: boolean;
	message: string;
}

export interface LogSegmentEntry {
	path: string;
	kind: "events" | "stdout" | "stderr";
	index: number;
	firstSeq: number | null;
	lastSeq: number | null;
	firstTs: string | null;
	lastTs: string | null;
	bytes: number;
}

export interface LogSegmentsIndex {
	updatedAt: string;
	segments: LogSegmentEntry[];
}
