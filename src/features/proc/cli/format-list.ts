import os from "node:os";
import { formatRunCommand } from "../format.js";
import {
	ACTIVE_STATUSES,
	isTerminalStatus,
	type ProcRun,
	type ProcStatus,
} from "../types.js";
import { color, padEndVisible, visibleWidth } from "./output.js";

export function statusBadge(status: ProcStatus): string {
	switch (status) {
		case "running":
		case "starting":
			return color.green(status);
		case "exited":
		case "stopped":
			return color.dim(status);
		case "failed":
		case "crashed":
		case "orphaned":
		case "stale":
			return color.red(status);
		default:
			return status;
	}
}

export function formatCwd(cwd: string): string {
	const home = os.homedir();
	if (home && (cwd === home || cwd.startsWith(`${home}/`)))
		return `~${cwd.slice(home.length)}`;
	return cwd;
}

export function truncateMiddle(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	if (width <= 1) return "…";
	const keep = width - 1;
	const head = Math.ceil(keep / 2);
	const tail = keep - head;
	return `${text.slice(0, head)}…${tail > 0 ? text.slice(text.length - tail) : ""}`;
}

export function truncateEnd(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	if (width <= 1) return "…";
	return `${text.slice(0, width - 1)}…`;
}

/** Compact human-friendly duration: "2s", "5m", "3h12m", "2d4h". */
export function formatDuration(ms: number): string {
	if (ms < 0) return "0s";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	const remMin = min - hr * 60;
	if (hr < 24) return remMin > 0 ? `${hr}h${remMin}m` : `${hr}h`;
	const days = Math.floor(hr / 24);
	const remHr = hr - days * 24;
	return remHr > 0 ? `${days}d${remHr}h` : `${days}d`;
}

function runAgeMs(run: ProcRun, now = Date.now()): number {
	const started = Date.parse(run.meta.startedAt);
	if (Number.isNaN(started)) return 0;
	return now - started;
}

function runDurationMs(run: ProcRun, now = Date.now()): number {
	const started = Date.parse(run.meta.startedAt);
	if (Number.isNaN(started)) return 0;
	const ended = run.state.endedAt ? Date.parse(run.state.endedAt) : now;
	return Math.max(0, ended - started);
}

function formatExit(run: ProcRun): string {
	if (run.state.exitCode !== null) return String(run.state.exitCode);
	if (run.state.signal) return String(run.state.signal);
	return "-";
}

function firstUrl(run: ProcRun): string {
	return run.state.detectedUrls[0] ?? "";
}

interface Row {
	status: string;
	name: string;
	runId: string;
	age: string;
	exit: string;
	restarts: string;
	cwd: string;
	url: string;
	cmd: string;
}

function buildRow(run: ProcRun, now: number): Row {
	const active = !isTerminalStatus(run.state.status);
	return {
		status: run.state.status,
		name: run.meta.name ?? "-",
		runId: run.meta.runId,
		age: active
			? formatDuration(runAgeMs(run, now))
			: formatDuration(runDurationMs(run, now)),
		exit: formatExit(run),
		restarts: formatRestarts(run),
		cwd: formatCwd(run.meta.cwd),
		url: firstUrl(run),
		cmd: formatRunCommand(run.meta),
	};
}

function formatRestarts(run: ProcRun): string {
	const count = run.state.restartCount ?? 0;
	const policy = run.meta.onExit;
	if (count === 0 && (!policy || policy.kind !== "restart")) return "";
	const max = policy?.kind === "restart" ? (policy.max ?? 5) : undefined;
	return max !== undefined ? `${count}/${max}` : `${count}`;
}

function renderRows(rows: Row[], runs: ProcRun[]): string {
	if (rows.length === 0) return "";
	const termCols = process.stdout.columns ?? 120;
	const gap = 2;
	const widths = {
		status: Math.max(8, ...rows.map((r) => r.status.length)),
		name: Math.max(4, ...rows.map((r) => r.name.length)),
		runId: 22,
		age: Math.max(3, ...rows.map((r) => r.age.length)),
		exit: Math.max(4, ...rows.map((r) => r.exit.length)),
		restarts: Math.max(0, ...rows.map((r) => r.restarts.length)),
	};
	const hasRestarts = widths.restarts > 0;
	if (hasRestarts) widths.restarts = Math.max(widths.restarts, 8);
	const fixed =
		widths.status +
		widths.name +
		widths.runId +
		widths.age +
		widths.exit +
		(hasRestarts ? widths.restarts + gap : 0) +
		gap * 6;
	const remaining = Math.max(20, termCols - fixed);
	const longestCwd = Math.max(3, ...rows.map((r) => r.cwd.length));
	const longestUrl = Math.max(3, ...rows.map((r) => r.url.length));
	const cwdWidth = Math.min(40, longestCwd, Math.max(10, remaining - 30));
	const urlWidth = longestUrl > 0 ? Math.min(30, longestUrl) : 0;
	const cmdWidth = Math.max(
		10,
		remaining - cwdWidth - (urlWidth > 0 ? urlWidth + gap : 0) - gap,
	);

	const headerParts = [
		color.bold("STATUS").padEnd(widths.status + ansiBoldPad("STATUS")),
		color.bold("NAME").padEnd(widths.name + ansiBoldPad("NAME")),
		color.bold("RUNID").padEnd(widths.runId + ansiBoldPad("RUNID")),
		color.bold("AGE").padEnd(widths.age + ansiBoldPad("AGE")),
		color.bold("EXIT").padEnd(widths.exit + ansiBoldPad("EXIT")),
	];
	if (hasRestarts) {
		headerParts.push(padEndVisible(color.bold("RESTARTS"), widths.restarts));
	}
	headerParts.push(padEndVisible(color.bold("CWD"), cwdWidth));
	if (urlWidth > 0) {
		headerParts.push(padEndVisible(color.bold("URL"), urlWidth));
	}
	headerParts.push(color.bold("CMD"));
	const header = headerParts.join("  ");

	const lines = rows.map((row, idx) => {
		const run = runs[idx];
		const ageStr = row.age.padEnd(widths.age);
		const exitStr = row.exit.padEnd(widths.exit);
		const cwd = padEndVisible(truncateMiddle(row.cwd, cwdWidth), cwdWidth);
		const cmd = truncateEnd(row.cmd, cmdWidth);
		const parts = [
			padEndVisible(
				statusBadge(row.status as ProcStatus),
				widths.status,
			),
			row.name.padEnd(widths.name),
			color.dim(row.runId.padEnd(widths.runId)),
			run && !isTerminalStatus(run.state.status)
				? color.cyan(ageStr)
				: color.dim(ageStr),
			color.dim(exitStr),
		];
		if (hasRestarts) {
			parts.push(
				row.restarts
					? color.yellow(row.restarts.padEnd(widths.restarts))
					: " ".repeat(widths.restarts),
			);
		}
		parts.push(cwd);
		if (urlWidth > 0) {
			parts.push(
				row.url ? color.cyan(truncateEnd(row.url, urlWidth)) : color.dim("-"),
			);
		}
		parts.push(cmd);
		return parts.join("  ");
	});

	return `${header}\n${lines.join("\n")}`;
}

// Quick fudge factor: color.bold() wraps in escape codes. We need padEnd to
// pad to visible width, so add (bytes - visible) chars to the width.
function ansiBoldPad(text: string): number {
	return visibleWidth(color.bold(text)) === text.length
		? color.bold(text).length - text.length
		: 0;
}

export interface RenderListOptions {
	/** Group active runs above terminated ones with section headers. Default true. */
	group?: boolean;
}

export function renderListTable(
	runs: ProcRun[],
	options: RenderListOptions = {},
): string {
	if (runs.length === 0) return "No runs found.";
	const group = options.group ?? true;
	const now = Date.now();

	if (!group) {
		const rows = runs.map((run) => buildRow(run, now));
		return renderRows(rows, runs);
	}

	const active = runs.filter((r) => ACTIVE_STATUSES.includes(r.state.status));
	const terminated = runs.filter(
		(r) => !ACTIVE_STATUSES.includes(r.state.status),
	);
	const parts: string[] = [];
	if (active.length > 0) {
		const rows = active.map((run) => buildRow(run, now));
		parts.push(color.bold(`# Active (${active.length})`));
		parts.push(renderRows(rows, active));
	}
	if (terminated.length > 0) {
		if (parts.length > 0) parts.push("");
		const rows = terminated.map((run) => buildRow(run, now));
		parts.push(color.dim(`# Terminated (${terminated.length})`));
		parts.push(renderRows(rows, terminated));
	}
	return parts.join("\n");
}

export interface ListJsonRow {
	runId: string;
	name: string | null;
	status: ProcStatus;
	cwd: string;
	command: string;
	startedAt: string;
	endedAt: string | null;
	exitCode: number | null;
	signal: string | null;
	urls: string[];
	pid: number | null;
	supervisorPid: number | null;
	ageMs: number;
	durationMs: number;
	restartCount: number;
	lastRestartAt: string | null;
}

export function listToJson(runs: ProcRun[]): { runs: ListJsonRow[] } {
	const now = Date.now();
	return {
		runs: runs.map((run) => ({
			runId: run.meta.runId,
			name: run.meta.name ?? null,
			status: run.state.status,
			cwd: run.meta.cwd,
			command: formatRunCommand(run.meta),
			startedAt: run.meta.startedAt,
			endedAt: run.state.endedAt,
			exitCode: run.state.exitCode,
			signal: run.state.signal ? String(run.state.signal) : null,
			urls: run.state.detectedUrls,
			pid: run.state.childPid,
			supervisorPid: run.state.supervisorPid,
			ageMs: runAgeMs(run, now),
			durationMs: runDurationMs(run, now),
			restartCount: run.state.restartCount ?? 0,
			lastRestartAt: run.state.lastRestartAt ?? null,
		})),
	};
}
