import path from "node:path";
import { defineTool, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { statusGlyph } from "../../shared/ui/status.js";
import { renderToolHeader } from "../../shared/ui/tool-header.js";
import { formatRunCommand } from "./format.js";
import { reconcileAllRuns, reconcileRun, stopResolvedRun } from "./process.js";
import { formatLogEvents, getRunLabel, queryProcLogs } from "./query.js";
import { startDetachedRun } from "./runner.js";
import { listRuns, readRun, resolveRun } from "./store.js";
import {
	ACTIVE_STATUSES,
	isTerminalStatus,
	type ProcRun,
	type ProcStatus,
} from "./types.js";
import {
	formatReadyLine,
	waitForReady,
	type WaitForReadyOutcome,
	type WaitOutcome,
} from "./wait-ready.js";

// Back-compat re-exports for anything that imported these from tools.ts.
export { waitForReady, formatReadyLine };
export type { WaitOutcome, WaitForReadyOutcome };

const StatusSchema = Type.Union([
	Type.Literal("starting"),
	Type.Literal("running"),
	Type.Literal("exited"),
	Type.Literal("failed"),
	Type.Literal("stopped"),
	Type.Literal("crashed"),
	Type.Literal("orphaned"),
	Type.Literal("stale"),
	Type.Literal("all"),
]);

const SignalSchema = Type.Union([
	Type.Literal("SIGTERM"),
	Type.Literal("SIGINT"),
	Type.Literal("SIGKILL"),
]);

const ConflictSchema = Type.Union([
	Type.Literal("fail"),
	Type.Literal("replace"),
	Type.Literal("reuse"),
]);

/**
 * Tool result whose `content[].text` payload is JSON the agent can parse
 * directly. `details` is the same structured object — single source of truth
 * for the LLM-visible text and the local TUI renderer.
 */
function jsonResult<T extends object>(details: T) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(details) }],
		details,
	};
}

function getResultDetails<T = unknown>(result: unknown): T | undefined {
	if (!result || typeof result !== "object") return undefined;
	return (result as { details?: T }).details;
}

/** Render a string[] as one Text node per line, using the theme's text fg. */
function renderLines(lines: readonly string[], theme: Theme): Container {
	const body = new Container();
	for (const line of lines)
		body.addChild(new Text(theme.fg("text", line), 0, 0));
	return body;
}

type RunSummary = ReturnType<typeof summariseRun>;

interface StartDetails {
	summary?: string;
	run?: RunSummary;
	ready?: boolean;
	outcome?: WaitOutcome;
	terminalStatus?: ProcStatus;
	urls?: string[];
	startupLines?: string[];
	readyTimeoutMs?: number;
	hint?: string;
	conflict?: boolean;
	reused?: boolean;
}

function renderStartLines(result: unknown): string[] {
	const d = getResultDetails<StartDetails>(result) ?? {};
	const lines: string[] = [];
	if (d.summary) lines.push(d.summary);
	if (d.run) {
		lines.push(`  cwd: ${d.run.cwd}`);
		lines.push(`  cmd: ${d.run.command}`);
	}
	if (d.urls && d.urls.length > 0)
		lines.push(`Detected URLs: ${d.urls.join(", ")}`);
	if (d.startupLines && d.startupLines.length > 0) {
		lines.push("Recent startup output:");
		for (const line of d.startupLines) lines.push(`  ${line}`);
	}
	if (d.hint) lines.push(d.hint);
	if (lines.length === 0) lines.push(JSON.stringify(d));
	return lines;
}

interface ListDetails {
	summary?: string;
	scope?: "cwd" | "all";
	cwd?: string;
	status?: string;
	count?: number;
	runs?: RunSummary[];
	elsewhere?: number;
	nameFilter?: string;
}

function renderListLines(result: unknown): string[] {
	const d = getResultDetails<ListDetails>(result) ?? {};
	const lines: string[] = [];
	if (d.summary) lines.push(d.summary);
	for (const run of d.runs ?? []) {
		lines.push(
			`  ${run.status.padEnd(9)} ${(run.name ?? "-").padEnd(12)} ${run.runId}  ${run.command}`,
		);
	}
	return lines.length > 0 ? lines : ["(no runs)"];
}

interface StopResultEntry {
	target?: { runId?: string; name?: string };
	stopped?: boolean;
	run?: RunSummary | null;
	message?: string;
}

interface StopDetails {
	summary?: string;
	stopped?: boolean | number;
	run?: RunSummary | null;
	results?: StopResultEntry[];
}

function renderStopLines(result: unknown): string[] {
	const d = getResultDetails<StopDetails>(result) ?? {};
	const lines: string[] = [];
	if (d.summary) lines.push(d.summary);
	for (const entry of d.results ?? []) {
		const mark = entry.stopped ? "✓" : "✗";
		const label = entry.run
			? `${entry.run.name ?? entry.target?.runId ?? entry.target?.name} (runId ${entry.run.runId.slice(0, 8)})`
			: (entry.target?.runId ?? entry.target?.name ?? "?");
		lines.push(`  ${mark} ${label}: ${entry.message ?? ""}`);
	}
	return lines.length > 0 ? lines : ["(no result)"];
}

interface LogEventEntry {
	seq?: number;
	ts?: string;
	level?: string;
	stream?: string;
	line?: string;
}

interface LogIncidentEntry {
	startSeq: number;
	endSeq: number;
	level: string;
	tags: string[];
	summary: string;
	fingerprint: string;
	memberCount: number;
}

interface LogTemplateEntry {
	template: string;
	count: number;
	level: string;
	firstSeq: number;
	lastSeq: number;
	exampleLine: string;
}

interface LogDetails {
	summary?: string;
	run?: { name?: string; runId: string; status: string } | null;
	mode?: string;
	matchedCount?: number;
	returnedCount?: number;
	cursorUpdated?: boolean;
	events?: LogEventEntry[];
	incidents?: LogIncidentEntry[];
	templates?: LogTemplateEntry[];
}

function summariseRun(run: ProcRun): {
	runId: string;
	name?: string;
	status: string;
	cwd: string;
	command: string;
	argv: string[];
	childPid: number | null;
	supervisorPid: number | null;
	ptyMode: string | null;
	startedAt: string;
	endedAt: string | null;
	detectedUrls: string[];
	readyAt: string | null;
	exitCode: number | null;
	signal: NodeJS.Signals | string | null;
	uptimeMs: number | null;
} {
	const startedMs = Date.parse(run.meta.startedAt);
	const endedMs = run.state.endedAt
		? Date.parse(run.state.endedAt)
		: Date.now();
	const uptimeMs =
		Number.isFinite(startedMs) && Number.isFinite(endedMs)
			? Math.max(0, endedMs - startedMs)
			: null;
	return {
		runId: run.meta.runId,
		name: run.meta.name,
		status: run.state.status,
		cwd: run.meta.cwd,
		command: formatRunCommand(run.meta),
		argv: run.meta.argv,
		childPid: run.state.childPid,
		supervisorPid: run.state.supervisorPid,
		ptyMode: run.state.ptyMode,
		startedAt: run.meta.startedAt,
		endedAt: run.state.endedAt,
		detectedUrls: run.state.detectedUrls,
		readyAt: run.state.readyAt,
		exitCode: run.state.exitCode,
		signal: run.state.signal,
		uptimeMs,
	};
}

export const procProcessStartTool = defineTool({
	name: "proc_process_start",
	label: "Proc Start",
	description:
		"Start a managed background process (dev server, watcher, daemon) and capture its stdout/stderr for later querying. Returns once the process is ready (URL detected or pattern matched) or the readyTimeoutMs elapses. Returns JSON: { summary, run, ready, outcome, terminalStatus, urls, startupLines, hint }.",
	promptSnippet:
		"proc_process_start: start any long-running command (dev servers, watchers, file-system observers, queue workers, background daemons). Use this INSTEAD OF running such commands through the bash tool — bash blocks the session and loses captured-log integration.",
	promptGuidelines: [
		"For any command that does not return promptly (dev servers, file watchers, daemons), use proc_process_start, never the bash tool.",
		"Pass `readyOnUrl: true` for HTTP servers or `readyPattern` for other ready signals — the tool blocks until the process is actually ready or the timeout fires.",
		"After code changes that would trigger a recompile, prefer `proc_logs_query` with `mode: 'errors'` and a small `since` window over re-running the command.",
	],
	parameters: Type.Object({
		name: Type.Optional(
			Type.String({
				description:
					"Stable process name, e.g. 'web'. Strongly recommended — required for later restart/attach.",
			}),
		),
		command: Type.String({
			description:
				"Executable to spawn (e.g. 'pnpm'). When `args` is omitted and `shell: true`, this is the full shell line.",
		}),
		args: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Command arguments. Preferred over passing a shell string.",
			}),
		),
		cwd: Type.Optional(
			Type.String({
				description: "Working directory. Defaults to the session cwd.",
			}),
		),
		shell: Type.Optional(
			Type.Boolean({
				description:
					"Run via the platform shell. Disables PTY mode. Default false; only set true if you actually need shell features (pipes, &&, $VAR).",
			}),
		),
		env: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: "Extra environment variables for the child process.",
			}),
		),
		forceColor: Type.Optional(
			Type.Boolean({
				description: "Set FORCE_COLOR=1 to keep colors in non-TTY scenarios.",
			}),
		),
		onConflict: Type.Optional(
			ConflictSchema && {
				...ConflictSchema,
				description:
					"What to do if a run with the same name+cwd is already active. 'fail' (default), 'replace' (stop the old one first), 'reuse' (return the existing run).",
			},
		),
		readyPattern: Type.Optional(
			Type.String({
				description:
					"Resolve the start call when this regex matches an output line (case-insensitive).",
			}),
		),
		readyOnUrl: Type.Optional(
			Type.Boolean({
				description:
					"Resolve the start call as soon as any URL is detected in the output. Use this for HTTP servers.",
			}),
		),
		onExit: Type.Optional(
			Type.Object(
				{
					kind: Type.Union([
						Type.Literal("none"),
						Type.Literal("restart"),
					]),
					max: Type.Optional(Type.Number()),
					backoffMs: Type.Optional(Type.Number()),
				},
				{
					description:
						"Supervisor's policy on child exit. 'none' (default) treats any exit as terminal. 'restart' re-spawns with exponential backoff up to `max` attempts (default 5), starting at `backoffMs` (default 1000ms, doubling, capped at 60s).",
				},
			),
		),
		readyTimeoutMs: Type.Optional(
			Type.Number({
				description:
					"Maximum time to wait for the ready signal (default 3000, max 60000). For slow boots, keep this short and follow up with proc_logs_query({ waitMs }) for the actual ready pattern.",
			}),
		),
		startupTailLines: Type.Optional(
			Type.Number({
				description:
					"How many startup-output lines to include in the response (default 10, max 30, 0 = suppress entirely). Use 0 for chatty JVM/framework boots.",
			}),
		),
		keepBlankLines: Type.Optional(
			Type.Boolean({
				description:
					"By default, log events whose body is empty after ANSI stripping (cursor/clear-screen redraws) are dropped from events.ndjson. Set true to keep them. Raw stdout/stderr files are unaffected.",
			}),
		),
		collapseProgress: Type.Optional(
			Type.Boolean({
				description:
					"By default, carriage-return overwrites in a logical line (Gradle/npm/pip progress bars) are collapsed to the final segment so seq counts and `since_last_query` cursors stay meaningful. Set false to keep every intermediate redraw.",
			}),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const cwd = path.resolve(params.cwd ?? ctx.cwd);
		const hasArgs = Array.isArray(params.args);
		const shell = params.shell ?? false;
		const argv = hasArgs
			? [params.command, ...(params.args ?? [])]
			: [params.command];
		const command = shell ? argv.join(" ") : params.command;
		const onConflict = params.onConflict ?? "fail";
		const readyTimeoutMs = Math.min(
			Math.max(0, params.readyTimeoutMs ?? 3000),
			60_000,
		);
		const startupTailLines = Math.max(
			0,
			Math.min(params.startupTailLines ?? 10, 30),
		);

		const existing = await resolveRun({
			name: params.name,
			cwd,
			statusIn: ACTIVE_STATUSES,
		});
		if (existing && params.name) {
			if (onConflict === "fail") {
				return jsonResult({
					summary: `A run named "${params.name}" is already active in ${cwd} (runId ${existing.meta.runId}, status ${existing.state.status}). Pass onConflict:"replace" to stop it first, or onConflict:"reuse" to return the existing run.`,
					conflict: true,
					run: summariseRun(existing),
				});
			}
			if (onConflict === "reuse") {
				return jsonResult({
					summary: `Reusing existing run ${existing.meta.runId} (${existing.state.status}).`,
					conflict: false,
					reused: true,
					run: summariseRun(existing),
				});
			}
			const stop = await stopResolvedRun({
				runId: existing.meta.runId,
				reason: "replace",
			});
			if (!stop.stopped) {
				return jsonResult({
					summary: `Failed to replace existing run: ${stop.message}`,
					conflict: true,
					run: summariseRun(existing),
				});
			}
		}

		const started = await startDetachedRun({
			name: params.name,
			cwd,
			command,
			argv,
			shell,
			env: params.env,
			forceColor: params.forceColor ?? false,
			readyPattern: params.readyPattern,
			readyOnUrl: params.readyOnUrl ?? false,
			onExit: params.onExit,
			keepBlankLines: params.keepBlankLines,
			collapseProgress: params.collapseProgress,
		});

		const outcome = await waitForReady(
			started.run.meta.runId,
			readyTimeoutMs,
			startupTailLines,
		);
		const fresh = (await readRun(started.run.meta.runId)) ?? started.run;
		const summary = summariseRun(fresh);

		const summaryLine = `Started ${fresh.meta.name ?? fresh.meta.runId} (run id ${fresh.meta.runId}). Status: ${summary.status}. ${formatReadyLine(outcome, fresh, readyTimeoutMs)}`;

		return jsonResult({
			summary: summaryLine,
			run: summary,
			ready: outcome.reachedReady,
			outcome: outcome.outcome,
			terminalStatus: outcome.terminalStatus,
			urls: outcome.urls,
			startupLines: outcome.startupLines,
			readyTimeoutMs,
			hint: `Use proc_logs_query({ name: "${fresh.meta.name ?? fresh.meta.runId}" }) to inspect later output, proc_process_stop to terminate.`,
		});
	},
	renderCall(args, theme, context) {
		return renderToolHeader(theme, context.lastComponent, {
			title: "Proc Start",
			arg: args.name ?? args.command,
		});
	},
	renderResult(result, _options, theme) {
		return renderLines(renderStartLines(result), theme);
	},
});

export const procProcessListTool = defineTool({
	name: "proc_process_list",
	label: "Proc List",
	description:
		"List managed processes captured by pi-proc. Returns JSON: { summary, scope, cwd, status, count, runs: RunSummary[] } where each RunSummary includes `command` (full command line) and `argv` (string[]).",
	promptSnippet:
		"proc_process_list: list running or recent managed processes (defaults to this project's cwd).",
	parameters: Type.Object({
		cwd: Type.Optional(
			Type.String({
				description:
					"Working directory filter. Defaults to the session cwd. Matches the directory itself and any subdirectory unless `exact` is true.",
			}),
		),
		scope: Type.Optional(
			Type.Union([Type.Literal("cwd"), Type.Literal("all")], {
				description:
					"'cwd' (default) lists runs under this project (cwd + subdirs); 'all' lists every run on disk.",
			}),
		),
		exact: Type.Optional(
			Type.Boolean({
				description:
					"When true, only match the literal cwd, not subdirectories. Default false.",
			}),
		),
		name: Type.Optional(
			Type.String({ description: "Filter by process name." }),
		),
		status: Type.Optional(StatusSchema),
		limit: Type.Optional(
			Type.Number({ description: "Maximum runs to return (default 25)." }),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const scope = params.scope ?? "cwd";
		const cwd =
			scope === "cwd" ? path.resolve(params.cwd ?? ctx.cwd) : undefined;
		const statusLabel = params.status ?? "running";
		const scopeNote = cwd
			? `under ${cwd} (scope=cwd${params.exact ? ", exact" : ""})`
			: "across all cwds (scope=all)";
		await reconcileAllRuns();
		const runs = await listRuns({
			cwd,
			cwdMode: params.exact ? "exact" : "descendant",
			name: params.name,
			status: statusLabel,
			limit: params.limit ?? 25,
		});
		if (runs.length === 0) {
			if (cwd) {
				const elsewhere = await listRuns({
					status: statusLabel,
					limit: 1,
				});
				if (elsewhere.length > 0)
					return jsonResult({
						summary: `No proc runs ${scopeNote}, status=${statusLabel}. Other runs exist elsewhere — retry with scope:"all" to see them.`,
						scope,
						cwd,
						status: statusLabel,
						count: 0,
						runs: [],
						elsewhere: elsewhere.length,
					});
				return jsonResult({
					summary: `No proc runs ${scopeNote}, status=${statusLabel}.`,
					scope,
					cwd,
					status: statusLabel,
					count: 0,
					runs: [],
				});
			}
			return jsonResult({
				summary: `No proc runs ${scopeNote}, status=${statusLabel}.`,
				scope,
				status: statusLabel,
				count: 0,
				runs: [],
			});
		}
		return jsonResult({
			summary: `Active runs ${scopeNote}, status=${statusLabel}: ${runs.length}`,
			scope,
			cwd,
			status: statusLabel,
			nameFilter: params.name,
			count: runs.length,
			runs: runs.map(summariseRun),
		});
	},
	renderCall(_args, theme, context) {
		return renderToolHeader(theme, context.lastComponent, {
			title: "Proc List",
		});
	},
	renderResult(result, _options, theme) {
		return renderLines(renderListLines(result), theme);
	},
});

export const procProcessStopTool = defineTool({
	name: "proc_process_stop",
	label: "Proc Stop",
	description:
		"Stop a managed process by run id or name. Returns JSON: { summary, stopped, run?, results: { target, stopped, run, message }[] }.",
	parameters: Type.Object({
		runId: Type.Optional(Type.String({ description: "Run id to stop." })),
		name: Type.Optional(Type.String({ description: "Process name to stop." })),
		runIds: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Stop multiple runs by id. Combined with `runId`/`name`/`names` if also given.",
			}),
		),
		names: Type.Optional(
			Type.Array(Type.String(), {
				description: "Stop multiple runs by name (resolved within cwd).",
			}),
		),
		cwd: Type.Optional(
			Type.String({
				description:
					"Working directory for name resolution. Defaults to ctx.cwd.",
			}),
		),
		signal: Type.Optional(SignalSchema),
		timeoutMs: Type.Optional(
			Type.Number({
				description:
					"Grace period before SIGKILL escalation (default 5000 ms).",
			}),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const cwd = path.resolve(params.cwd ?? ctx.cwd);
		type Target = { runId?: string; name?: string; label: string };
		const targets: Target[] = [];
		if (params.runId)
			targets.push({ runId: params.runId, label: params.runId });
		if (params.name) targets.push({ name: params.name, label: params.name });
		for (const id of params.runIds ?? [])
			targets.push({ runId: id, label: id });
		for (const n of params.names ?? []) targets.push({ name: n, label: n });
		if (targets.length === 0)
			return jsonResult({
				summary: "Provide at least one of runId, name, runIds, or names.",
				stopped: 0,
				results: [],
			});

		const results = await Promise.all(
			targets.map(async (target) => {
				const result = await stopResolvedRun({
					runId: target.runId,
					name: target.name,
					cwd,
					signal: params.signal,
					timeoutMs: params.timeoutMs,
				});
				return { target, result };
			}),
		);

		const entries = results.map(({ target, result }) => ({
			target: { runId: target.runId, name: target.name },
			stopped: result.stopped,
			run: result.run ? summariseRun(result.run) : null,
			message: result.message,
		}));
		const stoppedCount = entries.filter((e) => e.stopped).length;

		if (targets.length === 1) {
			const { result } = results[0];
			return jsonResult({
				summary: result.message,
				stopped: result.stopped,
				run: result.run ? summariseRun(result.run) : null,
				results: entries,
			});
		}

		return jsonResult({
			summary: `Stopped ${stoppedCount}/${results.length} run(s).`,
			stopped: stoppedCount,
			results: entries,
		});
	},
	renderCall(args, theme, context) {
		return renderToolHeader(theme, context.lastComponent, {
			title: "Proc Stop",
			arg: args.runId ?? args.name,
			tag: { text: args.signal ?? "SIGTERM", tone: "warning" },
		});
	},
	renderResult(result, _options, theme) {
		return renderLines(renderStopLines(result), theme);
	},
});

export const procProcessRestartTool = defineTool({
	name: "proc_process_restart",
	label: "Proc Restart",
	description:
		"Stop a managed run then start it again with the same command/cwd/env/name. Returns JSON: { summary, run, ready, outcome, terminalStatus, urls, startupLines }.",
	promptSnippet:
		"proc_process_restart: stop and re-start a managed dev server (e.g. after changing env vars).",
	parameters: Type.Object({
		runId: Type.Optional(Type.String({ description: "Run id to restart." })),
		name: Type.Optional(Type.String({ description: "Name of the run." })),
		cwd: Type.Optional(
			Type.String({ description: "Working directory for name resolution." }),
		),
		readyTimeoutMs: Type.Optional(
			Type.Number({
				description:
					"Wait-for-ready window for the new run (default 3000, max 60000). For slow boots, keep this short and follow up with proc_logs_query({ waitMs }).",
			}),
		),
		startupTailLines: Type.Optional(
			Type.Number({
				description:
					"How many startup-output lines to include in the response (default 10, max 30, 0 = suppress).",
			}),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const cwd = path.resolve(params.cwd ?? ctx.cwd);
		const existing = params.runId
			? await readRun(params.runId)
			: await resolveRun({ name: params.name, cwd });
		if (!existing)
			return jsonResult({
				summary: "No matching run.",
				restarted: false,
			});
		const reconciled = await reconcileRun(existing);
		if (!isTerminalStatus(reconciled.state.status)) {
			await stopResolvedRun({
				runId: existing.meta.runId,
				reason: "restart",
			});
		}
		const started = await startDetachedRun({
			name: existing.meta.name,
			cwd: existing.meta.cwd,
			command: existing.meta.command,
			argv: existing.meta.argv,
			shell: existing.meta.shell,
			env: existing.meta.env,
			forceColor: existing.meta.forceColor,
			classify: existing.meta.classify,
			readyPattern: existing.meta.readyPattern,
			readyOnUrl: existing.meta.readyOnUrl,
			keepBlankLines: existing.meta.keepBlankLines,
			collapseProgress: existing.meta.collapseProgress,
		});
		const readyTimeoutMs = Math.min(
			Math.max(0, params.readyTimeoutMs ?? 3000),
			60_000,
		);
		const startupTailLines = Math.max(
			0,
			Math.min(params.startupTailLines ?? 10, 30),
		);
		const outcome = await waitForReady(
			started.run.meta.runId,
			readyTimeoutMs,
			startupTailLines,
		);
		const fresh = (await readRun(started.run.meta.runId)) ?? started.run;
		const summary = summariseRun(fresh);
		const summaryLine = `Restarted ${fresh.meta.name ?? fresh.meta.runId}. Status: ${fresh.state.status}. ${formatReadyLine(outcome, fresh, readyTimeoutMs)}`;
		return jsonResult({
			summary: summaryLine,
			run: summary,
			ready: outcome.reachedReady,
			outcome: outcome.outcome,
			terminalStatus: outcome.terminalStatus,
			urls: outcome.urls,
			startupLines: outcome.startupLines,
			readyTimeoutMs,
		});
	},
	renderCall(args, theme, context) {
		return renderToolHeader(theme, context.lastComponent, {
			title: "Proc Restart",
			arg: args.runId ?? args.name,
		});
	},
	renderResult(result, _options, theme) {
		return renderLines(renderStartLines(result), theme);
	},
});

export const procLogsQueryTool = defineTool({
	name: "proc_logs_query",
	label: "Proc Logs",
	description:
		"Query captured process logs with smart filters. Modes: 'recent' (default-like), 'errors' / 'warnings' (level filters), 'startup' (first 400 events), 'since_last_query' (cursor-based incremental), 'first_failure' (very first error incident + preceding context — best for root-cause), 'incidents' (all grouped error blocks), 'templates' (frequency table over masked line templates — fills `templates`), 'rare' (events whose template appears ≤ rareThreshold). Returns JSON: { summary, run, mode, format, matchedCount, returnedCount, cursorUpdated, events: { seq, ts, level, stream, line }[], incidents?, templates? }.",
	promptSnippet:
		"proc_logs_query: inspect logs from pi-proc-managed dev servers. Prefer this over re-running the dev server after code changes.",
	promptGuidelines: [
		"When a proc-managed dev server is running, prefer proc_logs_query over rerunning the dev server just to inspect errors.",
		"Use mode='errors' or mode='since_last_query' after code changes to find new failures without dumping full logs. For root-cause debugging, mode='first_failure' is usually the right first move — it returns the original error plus preceding context, even if downstream errors followed.",
		"When you pass `contains` or `regex` without an explicit `mode`, the search runs across all events (mode defaults to 'recent'). Set `mode: 'errors'` explicitly if you want to constrain a text search to error-level lines.",
		"In PTY mode, stdout/stderr are merged into the stdout stream — the `stream` filter is only useful when the run was started with `shell: true` (pipe fallback).",
		"Default `format` is 'compact' (just `HH:MM:SS line`). Pass `format: 'full'` when you need the seq/stream/level metadata, e.g. when correlating across runs.",
		"Use `waitMs` instead of polling in a loop: combine with `contains`/`regex` to block until a specific line appears, or with `mode: 'since_last_query'` to block until any new output is captured.",
		"`mode: 'since_last_query'` advances a per-agent-session cursor keyed by run id. The cursor persists across tool calls within a session; a new run starts with a fresh cursor entry, and the cursor is not reset by tool restart unless the session file changes.",
		"To recover a stack trace cut by `…[truncated]`, call again with `seq: <N>` to get that one event untruncated, or pass `maxLineBytes: 0` to disable truncation for the whole query.",
	],
	parameters: Type.Object({
		runId: Type.Optional(Type.String({ description: "Run id to query." })),
		name: Type.Optional(Type.String({ description: "Process name to query." })),
		cwd: Type.Optional(
			Type.String({
				description:
					"Working directory for name resolution. Defaults to ctx.cwd.",
			}),
		),
		since: Type.Optional(
			Type.String({
				description:
					"Duration (e.g. '10m', '1h') or ISO timestamp. Default: full history bounded by `limit`.",
			}),
		),
		until: Type.Optional(
			Type.String({ description: "Upper-bound duration or ISO timestamp." }),
		),
		stream: Type.Optional(
			Type.Union([
				Type.Literal("stdout"),
				Type.Literal("stderr"),
				Type.Literal("both"),
			]),
		),
		level: Type.Optional(
			Type.Union([
				Type.Literal("debug"),
				Type.Literal("info"),
				Type.Literal("warn"),
				Type.Literal("error"),
			]),
		),
		mode: Type.Optional(
			Type.Union([
				Type.Literal("recent"),
				Type.Literal("errors"),
				Type.Literal("warnings"),
				Type.Literal("startup"),
				Type.Literal("since_last_query"),
				Type.Literal("first_failure"),
				Type.Literal("incidents"),
				Type.Literal("templates"),
				Type.Literal("rare"),
			]),
		),
		rareThreshold: Type.Optional(
			Type.Number({
				description:
					"For mode: 'rare', max template count for an event to be considered rare (default 2).",
			}),
		),
		contains: Type.Optional(
			Type.String({ description: "Case-insensitive substring filter." }),
		),
		regex: Type.Optional(Type.String({ description: "Regex filter." })),
		caseSensitive: Type.Optional(Type.Boolean()),
		contextLines: Type.Optional(
			Type.Number({
				description: "Lines of context around matches (default 2).",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: "Max events to return (default 100, max 500).",
			}),
		),
		maxLineBytes: Type.Optional(
			Type.Number({
				description:
					"Truncate any event line beyond this byte length with '…[truncated]' (default 1024). Pass 0 to disable truncation.",
			}),
		),
		seq: Type.Optional(
			Type.Number({
				description:
					"Return the single event with this exact seq, untruncated. Useful when a stack trace was cut by maxLineBytes. Other filters are ignored when set.",
			}),
		),
		waitMs: Type.Optional(
			Type.Number({
				description:
					"When the initial scan returns no matches and the run is still running, block up to this many ms waiting for the first matching event (default 0 = no wait, max 60000). Pairs naturally with mode='since_last_query' for 'block until new output'.",
			}),
		),
		format: Type.Optional(
			Type.Union([Type.Literal("compact"), Type.Literal("full")], {
				description:
					"Output format. 'compact' (default) is `HH:MM:SS line`. 'full' adds `[label] #seq stream level:` prefix — useful when correlating across runs.",
			}),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		await reconcileAllRuns();
		// When the caller supplies a text filter without an explicit mode, run
		// the search across ALL events rather than restricting to error-level
		// lines. Explicit text intent should dominate over the mode default.
		const hasTextFilter = Boolean(params.contains || params.regex);
		const mode = params.mode ?? (hasTextFilter ? "recent" : "errors");
		const result = await queryProcLogs({
			...params,
			cwd: params.cwd ?? ctx.cwd,
			mode,
			limit: params.limit ?? 100,
			contextLines: params.contextLines ?? 2,
			cursorKey:
				mode === "since_last_query"
					? ctx.sessionManager.getSessionFile()
					: undefined,
		});
		const format = params.format ?? "compact";
		const label =
			format === "full" && result.run ? getRunLabel(result.run) : undefined;
		// Pre-format each event's display line so the agent can scan `events[].line`
		// without re-stringifying metadata it already has on the event object.
		const events = result.events.map((event) => {
			const displayLine = formatLogEvents([event], {
				label,
				maxLineBytes: params.maxLineBytes,
				format,
			});
			return {
				seq: event.seq,
				ts: event.ts,
				level: event.level,
				stream: event.stream,
				line: displayLine,
			};
		});
		return jsonResult({
			summary: result.summary,
			run: result.run
				? {
						runId: result.run.meta.runId,
						name: result.run.meta.name,
						status: result.run.state.status,
					}
				: null,
			mode,
			format,
			matchedCount: result.matchedCount,
			returnedCount: result.returnedCount,
			cursorUpdated: result.cursorUpdated ?? false,
			firstSeq: events[0]?.seq ?? null,
			lastSeq: events[events.length - 1]?.seq ?? null,
			firstTs: events[0]?.ts ?? null,
			lastTs: events[events.length - 1]?.ts ?? null,
			events,
			incidents: result.incidents,
			templates: result.templates,
		});
	},
	renderCall(args, theme, context) {
		return renderToolHeader(theme, context.lastComponent, {
			title: "Proc Logs",
			arg: args.runId ?? args.name ?? args.mode ?? "errors",
			tag: args.mode ? { text: args.mode, tone: "accent" } : undefined,
		});
	},
	renderResult(result, _options, theme) {
		const d = getResultDetails<LogDetails>(result) ?? {};
		const body = new Container();
		if (d.summary) body.addChild(new Text(theme.fg("text", d.summary), 0, 0));
		const events = d.events ?? [];
		if (events.length === 0) {
			if (!d.summary)
				body.addChild(new Text(theme.fg("muted", "No logs."), 0, 0));
			return body;
		}
		for (const event of events) {
			const level = event.level ?? "";
			const kind =
				level === "error" ? "fail" : level === "warn" ? "pending" : "idle";
			const tone =
				kind === "fail" ? "error" : kind === "pending" ? "warning" : "text";
			body.addChild(
				new Text(
					`${statusGlyph(theme, kind)} ${theme.fg(tone, event.line ?? "")}`,
					0,
					0,
				),
			);
		}
		return body;
	},
});
