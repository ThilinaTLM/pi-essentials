import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { classifyLine, matchesReady, stripAnsi } from "./classify.js";
import {
	detectFramework,
	type FrameworkProfile,
	matchesAutoReady,
	UNKNOWN_PROFILE,
} from "./frameworks.js";
import { type ControlServer, startControlServer } from "./control-server.js";
import {
	activeSegmentSize,
	maybeRotate,
	rotateBytes,
	type SegmentKind,
} from "./log-segments.js";
import { getNodeExecutable } from "./node-bin.js";
import { signalExitCode } from "./process.js";
import { type PtyHandle, spawnPty } from "./pty.js";
import {
	createRun,
	ensureSchemaVersion,
	eventsPath,
	rawLogPath,
	readRun,
	runDir,
	updateRunState,
} from "./store.js";
import type {
	CreateRunOptions,
	ProcLogEvent,
	ProcRun,
	ProcStatus,
	PtyMode,
	StartDetachedResult,
} from "./types.js";

// Constructed from escape strings so Biome's noControlCharactersInRegex rule
// doesn't flag the literal bytes; same trick classify.ts uses for ANSI_PATTERN.
const HAS_ANSI = new RegExp(`[${"\\u001B"}${"\\u009B"}]`);

interface EventSinkOptions {
	run: ProcRun;
	ptyMode: PtyMode;
	tee: boolean;
	onEvent?(event: ProcLogEvent): void;
	onRawChunk?(chunk: Buffer): void;
}

export interface NormaliseEventLineOptions {
	/** Default false. See `ProcRunMeta.keepBlankLines`. */
	keepBlankLines?: boolean;
	/** Default true. See `ProcRunMeta.collapseProgress`. */
	collapseProgress?: boolean;
}

export interface NormalisedEventLine {
	/** Line as it should be persisted (post `\r` collapse). */
	line: string;
	/** False when the line is a pure ANSI redraw and should be dropped. */
	persist: boolean;
}

/**
 * Apply the per-line noise filters that decide what ends up in events.ndjson:
 *
 * 1. If `collapseProgress` (default true) and the line contains `\r`, keep
 *    only the segment after the final `\r` — mirrors what a terminal would
 *    render and keeps progress-bar redraws from inflating seq counts.
 * 2. If `keepBlankLines` is false (default) and the original line contained
 *    any ANSI escape AND the post-strip body is empty/whitespace, drop the
 *    event entirely (cursor-move / clear-screen noise).
 *
 * Pure: no I/O, no side effects. Exported so the supervisor and tests share
 * exactly one implementation.
 */
export function normaliseEventLine(
	rawLine: string,
	options: NormaliseEventLineOptions = {},
): NormalisedEventLine {
	const collapseProgress = options.collapseProgress !== false;
	const line =
		collapseProgress && rawLine.includes("\r")
			? rawLine.slice(rawLine.lastIndexOf("\r") + 1)
			: rawLine;
	const keepBlankLines = options.keepBlankLines === true;
	const hadAnsi = HAS_ANSI.test(rawLine);
	if (!keepBlankLines && hadAnsi && stripAnsi(line).trim() === "") {
		return { line, persist: false };
	}
	return { line, persist: true };
}

/**
 * Routes raw child output to:
 *  - the active raw log file (stdout.log / stderr.log)
 *  - structured events.ndjson (one JSON object per logical line)
 *  - optional tee to the supervisor's own stdout/stderr (foreground mode)
 *  - optional broadcast hooks (control socket, ready detection)
 *
 * Handles ANSI stripping, line classification, URL extraction, rotation
 * checks, and notification dispatch. State (lastEventAt, detectedUrls) is
 * flushed on a debounce so we don't fsync on every line.
 */
class EventSink {
	private seq = 0;
	private firstSeq: number | null = null;
	private lastSeq: number | null = null;
	private firstTs: string | null = null;
	private lastTs: string | null = null;
	private bytesSinceCheck = 0;
	// Logical bytes written to each active segment since its last rotation.
	// We track these ourselves because fs.stat lags behind Node WriteStream
	// buffers and would make small rotate thresholds fire at most once.
	private eventsBytes = 0;
	private stdoutBytes = 0;
	private stderrBytes = 0;
	private stdoutCarry = "";
	private stderrCarry = "";
	private readonly stdoutDecoder = new StringDecoder("utf8");
	private readonly stderrDecoder = new StringDecoder("utf8");
	private stdoutLog: WriteStream;
	private stderrLog: WriteStream;
	private eventsLog: WriteStream;
	private readonly urls = new Set<string>();
	private stateUpdateTimer: NodeJS.Timeout | undefined;
	private newUrls = false;
	private finished = false;

	constructor(private readonly options: EventSinkOptions) {
		this.stdoutLog = createWriteStream(
			rawLogPath(options.run.meta.runId, "stdout"),
			{ flags: "a" },
		);
		this.stderrLog = createWriteStream(
			rawLogPath(options.run.meta.runId, "stderr"),
			{ flags: "a" },
		);
		this.eventsLog = createWriteStream(eventsPath(options.run.meta.runId), {
			flags: "a",
		});
		for (const url of options.run.state.detectedUrls) this.urls.add(url);
	}

	write(stream: "stdout" | "stderr", chunk: Buffer): void {
		if (chunk.length === 0) return;
		this.bytesSinceCheck += chunk.length;
		if (stream === "stdout") {
			this.stdoutLog.write(chunk);
			this.stdoutBytes += chunk.length;
			if (this.options.tee) process.stdout.write(chunk);
		} else {
			this.stderrLog.write(chunk);
			this.stderrBytes += chunk.length;
			if (this.options.tee) process.stderr.write(chunk);
		}
		this.options.onRawChunk?.(chunk);

		const decoder =
			stream === "stdout" ? this.stdoutDecoder : this.stderrDecoder;
		const carry = stream === "stdout" ? this.stdoutCarry : this.stderrCarry;
		const decoded = decoder.write(chunk);
		const combined = `${carry}${decoded}`;
		const lines = combined.split(/\r?\n/);
		const newCarry = lines.pop() ?? "";
		for (const line of lines) this.writeEvent(stream, line);
		if (stream === "stdout") this.stdoutCarry = newCarry;
		else this.stderrCarry = newCarry;

		const checkEvery = Math.min(
			64 * 1024,
			Math.max(512, Math.floor(rotateBytes() / 4)),
		);
		if (this.bytesSinceCheck >= checkEvery) {
			this.bytesSinceCheck = 0;
			void this.checkRotation();
		}
	}

	finish(): void {
		if (this.finished) return;
		this.finished = true;
		const stdoutRest = this.stdoutDecoder.end();
		if (stdoutRest)
			this.stdoutCarry = this.flushCarry(
				"stdout",
				stdoutRest,
				this.stdoutCarry,
			);
		const stderrRest = this.stderrDecoder.end();
		if (stderrRest)
			this.stderrCarry = this.flushCarry(
				"stderr",
				stderrRest,
				this.stderrCarry,
			);
		if (this.stdoutCarry) this.writeEvent("stdout", this.stdoutCarry);
		if (this.stderrCarry) this.writeEvent("stderr", this.stderrCarry);
		if (this.stateUpdateTimer) clearTimeout(this.stateUpdateTimer);
		void this.flushState();
		this.stdoutLog.end();
		this.stderrLog.end();
		this.eventsLog.end();
	}

	private flushCarry(
		stream: "stdout" | "stderr",
		text: string,
		carry: string,
	): string {
		const combined = `${carry}${text}`;
		const lines = combined.split(/\r?\n/);
		const newCarry = lines.pop() ?? "";
		for (const line of lines) this.writeEvent(stream, line);
		return newCarry;
	}

	private writeEvent(stream: "stdout" | "stderr", rawLine: string): void {
		const meta = this.options.run.meta;
		const normalised = normaliseEventLine(rawLine, {
			keepBlankLines: meta.keepBlankLines,
			collapseProgress: meta.collapseProgress,
		});
		if (!normalised.persist) return;
		const line = normalised.line;
		const classified = classifyLine(line, meta.classify);

		const event: ProcLogEvent = {
			ts: new Date().toISOString(),
			runId: meta.runId,
			seq: this.seq++,
			stream,
			level: classified.level,
			line,
			ansiStripped: classified.ansiStripped,
			tags: classified.tags,
		};
		if (this.firstSeq === null) this.firstSeq = event.seq;
		this.lastSeq = event.seq;
		if (this.firstTs === null) this.firstTs = event.ts;
		this.lastTs = event.ts;
		for (const url of classified.urls) {
			if (!this.urls.has(url)) {
				this.urls.add(url);
				this.newUrls = true;
			}
		}
		const eventLine = `${JSON.stringify(event)}\n`;
		this.eventsLog.write(eventLine);
		this.eventsBytes += Buffer.byteLength(eventLine, "utf8");
		this.options.onEvent?.(event);
		this.scheduleStateFlush(event.ts);
	}

	private scheduleStateFlush(lastEventAt: string): void {
		if (this.stateUpdateTimer) return;
		this.stateUpdateTimer = setTimeout(() => {
			this.stateUpdateTimer = undefined;
			void updateRunState(this.options.run.meta.runId, {
				lastEventAt,
				...(this.newUrls ? { detectedUrls: Array.from(this.urls) } : {}),
			});
			this.newUrls = false;
		}, 500);
	}

	private async flushState(): Promise<void> {
		await updateRunState(this.options.run.meta.runId, {
			detectedUrls: Array.from(this.urls),
		});
	}

	private async checkRotation(): Promise<void> {
		try {
			for (const kind of ["events", "stdout", "stderr"] as SegmentKind[]) {
				const tracked =
					kind === "events"
						? this.eventsBytes
						: kind === "stdout"
							? this.stdoutBytes
							: this.stderrBytes;
				const onDisk = await activeSegmentSize(
					this.options.run.meta.runId,
					kind,
				);
				const bytes = Math.max(tracked, onDisk);
				const rotated = await maybeRotate(this.options.run.meta.runId, kind, {
					firstSeq: kind === "events" ? this.firstSeq : null,
					lastSeq: kind === "events" ? this.lastSeq : null,
					firstTs: kind === "events" ? this.firstTs : null,
					lastTs: kind === "events" ? this.lastTs : null,
					bytes,
				});
				if (rotated) {
					// Reopen the active stream — the old one now points at the rotated file.
					if (kind === "events") {
						this.eventsLog.end();
						this.eventsLog = createWriteStream(
							eventsPath(this.options.run.meta.runId),
							{ flags: "a" },
						);
						this.firstSeq = null;
						this.firstTs = null;
						this.eventsBytes = 0;
					} else {
						const target = kind === "stdout" ? this.stdoutLog : this.stderrLog;
						target.end();
						const replacement = createWriteStream(
							rawLogPath(this.options.run.meta.runId, kind),
							{ flags: "a" },
						);
						if (kind === "stdout") {
							this.stdoutLog = replacement;
							this.stdoutBytes = 0;
						} else {
							this.stderrLog = replacement;
							this.stderrBytes = 0;
						}
					}
				}
			}
		} catch {
			// Best-effort rotation; never crash the supervisor on log IO.
		}
	}
}

export function getCliPath(): string {
	return fileURLToPath(new URL("../../../bin/pi-proc.mjs", import.meta.url));
}

function buildEnv(run: ProcRun): NodeJS.ProcessEnv {
	const env = { ...process.env, ...run.meta.env };
	if (run.meta.forceColor) {
		env.FORCE_COLOR = "1";
		env.CLICOLOR_FORCE = "1";
	}
	return env;
}

function displayCommand(options: CreateRunOptions): string {
	if (options.shell) return options.command;
	return options.argv.join(" ");
}

export async function createManagedRun(
	options: CreateRunOptions,
): Promise<ProcRun> {
	await ensureSchemaVersion();
	return createRun({
		...options,
		command: options.command || displayCommand(options),
	});
}

export async function startDetachedRun(
	options: Omit<CreateRunOptions, "foreground">,
): Promise<StartDetachedResult> {
	const run = await createManagedRun({ ...options, foreground: false });
	const child = spawn(
		getNodeExecutable(),
		[getCliPath(), "__supervise", run.meta.runId],
		{
			cwd: run.meta.cwd,
			detached: true,
			stdio: "ignore",
			env: process.env,
			windowsHide: true,
		},
	);
	child.unref();
	await updateRunState(run.meta.runId, { supervisorPid: child.pid ?? null });
	return {
		run: {
			meta: run.meta,
			state: { ...run.state, supervisorPid: child.pid ?? null },
		},
		supervisorPid: child.pid ?? 0,
	};
}

interface SuperviseOptions {
	tee: boolean;
	allowControlSocket: boolean;
}

export async function superviseRun(
	runId: string,
	options: SuperviseOptions,
): Promise<number> {
	const run = await readRun(runId);
	if (!run) throw new Error(`Unknown proc run: ${runId}`);
	await mkdir(runDir(runId), { recursive: true });

	let ptyHandle: PtyHandle | undefined;
	let pipeChild: ChildProcess | undefined;
	let ptyMode: PtyMode = "pipe";
	let controlServer: ControlServer | undefined;
	let readyEmitted = false;

	const command = run.meta.shell ? run.meta.command : run.meta.argv[0];
	const args = run.meta.shell ? [] : run.meta.argv.slice(1);
	if (!command) throw new Error("No command provided.");

	const env = buildEnv(run);

	const tryPty = !run.meta.shell;
	let ptyError: Error | undefined;
	if (tryPty) {
		try {
			ptyHandle = await spawnPty(command, args, {
				cwd: run.meta.cwd,
				env,
				cols:
					options.tee && process.stdout.isTTY ? process.stdout.columns : 120,
				rows: options.tee && process.stdout.isTTY ? process.stdout.rows : 30,
			});
			ptyMode = "pty";
		} catch (error) {
			ptyHandle = undefined;
			ptyError = error instanceof Error ? error : new Error(String(error));
		}
	}

	if (!ptyHandle) {
		pipeChild = spawn(command, args, {
			cwd: run.meta.cwd,
			env,
			shell: run.meta.shell,
			stdio: [options.tee ? "inherit" : "ignore", "pipe", "pipe"],
			windowsHide: !options.tee,
		});
		ptyMode = "pipe";
	}

	const childPid = ptyHandle?.pid ?? pipeChild?.pid ?? null;

	// Register the exit listener *immediately* after spawn so we never lose
	// the exit event during the setup awaits below. Some children (fast
	// scripts, tests) exit before we'd otherwise have a listener attached;
	// node-pty does not replay missed exits. We also buffer stdout chunks
	// until the EventSink is constructed so output isn't lost either.
	let earlyExit: { exitCode: number; signal: NodeJS.Signals | string | null } | null = null;
	const exitWaiters: Array<
		(info: { exitCode: number; signal: NodeJS.Signals | string | null }) => void
	> = [];
	const stdoutBuffer: Buffer[] = [];
	const stderrBuffer: Buffer[] = [];
	const earlyExitOf = (
		exitCode: number,
		signal: NodeJS.Signals | string | null,
	) => {
		const info = { exitCode, signal };
		earlyExit = info;
		for (const fn of exitWaiters.splice(0)) fn(info);
	};
	if (ptyHandle) {
		ptyHandle.onData((data) =>
			stdoutBuffer.push(Buffer.from(data, "utf8")),
		);
		ptyHandle.onExit(({ exitCode, signal }) => {
			const sig = signal
				? (signalNumberToName(signal) ?? null)
				: null;
			const code =
				exitCode !== null && exitCode !== undefined
					? exitCode
					: sig
						? signalExitCode(sig)
						: 1;
			earlyExitOf(code, sig);
		});
	} else if (pipeChild) {
		pipeChild.stdout?.on("data", (chunk: Buffer) => stdoutBuffer.push(chunk));
		pipeChild.stderr?.on("data", (chunk: Buffer) => stderrBuffer.push(chunk));
		pipeChild.on("error", () => earlyExitOf(1, null));
		pipeChild.on("close", (code, signal) => {
			const sig = signal ?? null;
			const exitCode =
				code ?? (sig ? signalExitCode(sig as NodeJS.Signals) : 1);
			earlyExitOf(exitCode, sig);
		});
	}

	await updateRunState(runId, {
		status: "running",
		supervisorPid: process.pid,
		childPid,
		ptyMode,
	});

	const refreshedRun = (await readRun(runId)) ?? run;

	// Framework auto-detection runs once per supervisor invocation. The
	// matched profile contributes its own ready patterns to the auto-ready
	// library used below. Detection is performed on the first ~50 event
	// lines and then cached on `framework`.
	const headLines: string[] = [];
	let framework: FrameworkProfile = UNKNOWN_PROFILE;
	const HEAD_LIMIT = 50;

	const sink = new EventSink({
		run: refreshedRun,
		ptyMode,
		tee: options.tee,
		onEvent: (event) => {
			controlServer?.broadcastEvent(event);

			if (
				framework === UNKNOWN_PROFILE &&
				headLines.length < HEAD_LIMIT
			) {
				headLines.push(event.ansiStripped);
				framework = detectFramework(headLines);
			}

			if (!readyEmitted && run.meta.readyPattern) {
				if (new RegExp(run.meta.readyPattern, "i").test(event.ansiStripped)) {
					readyEmitted = true;
					void updateRunState(runId, { readyAt: event.ts });
				}
			}
			if (
				!readyEmitted &&
				run.meta.readyOnUrl &&
				event.line.match(/https?:\/\//)
			) {
				readyEmitted = true;
				void updateRunState(runId, { readyAt: event.ts });
			}
			if (
				!readyEmitted &&
				matchesReady(event.ansiStripped, run.meta.classify)
			) {
				readyEmitted = true;
				void updateRunState(runId, { readyAt: event.ts });
			}
			// Auto-ready: catch-all library + framework-specific patterns. Opt-out
			// is via meta.classify.readyPatterns set to a sentinel — currently
			// always on, since the patterns are conservative ("Listening on",
			// "compiled successfully" etc.).
			if (
				!readyEmitted &&
				matchesAutoReady(event.ansiStripped, framework)
			) {
				readyEmitted = true;
				void updateRunState(runId, { readyAt: event.ts });
			}
		},
		onRawChunk: (chunk) => {
			controlServer?.broadcastData(chunk);
		},
	});

	if (ptyError) {
		sink.write(
			"stderr",
			Buffer.from(
				`[pi-proc] node-pty unavailable, using pipe mode: ${ptyError.message}\n`,
			),
		);
	}

	if (options.allowControlSocket) {
		try {
			controlServer = await startControlServer(runId, {
				onInput(buf) {
					if (ptyHandle) ptyHandle.write(buf);
					else if (pipeChild?.stdin) pipeChild.stdin.write(buf);
				},
				onResize(cols, rows) {
					ptyHandle?.resize(cols, rows);
				},
				onSignal(name) {
					try {
						if (ptyHandle) ptyHandle.kill(name);
						else if (pipeChild) pipeChild.kill(name as NodeJS.Signals);
					} catch {
						// ignore
					}
				},
			});
		} catch (error) {
			// Control socket is best-effort; supervisor still runs without it.
			sink.write(
				"stderr",
				Buffer.from(
					`[pi-proc] control socket unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
				),
			);
		}
	}

	// Replay any chunks captured before the sink existed, then re-route
	// future chunks straight to the sink.
	for (const chunk of stdoutBuffer.splice(0)) sink.write("stdout", chunk);
	for (const chunk of stderrBuffer.splice(0)) sink.write("stderr", chunk);
	if (ptyHandle) {
		ptyHandle.onData((data) => sink.write("stdout", Buffer.from(data, "utf8")));
	} else if (pipeChild) {
		pipeChild.stdout?.on("data", (chunk: Buffer) =>
			sink.write("stdout", chunk),
		);
		pipeChild.stderr?.on("data", (chunk: Buffer) =>
			sink.write("stderr", chunk),
		);
	}

	let interactiveCleanup: (() => void) | undefined;
	if (options.tee && ptyHandle && process.stdin.isTTY) {
		try {
			process.stdin.setRawMode(true);
		} catch {
			// non-TTY parent; ignore
		}
		process.stdin.resume();
		const onInput = (chunk: Buffer) => ptyHandle?.write(chunk);
		const onResize = () => {
			if (ptyHandle && process.stdout.isTTY)
				ptyHandle.resize(process.stdout.columns, process.stdout.rows);
		};
		process.stdin.on("data", onInput);
		process.stdout.on("resize", onResize);
		interactiveCleanup = () => {
			process.stdin.off("data", onInput);
			process.stdout.off("resize", onResize);
			try {
				if (process.stdin.isTTY) process.stdin.setRawMode(false);
			} catch {
				// ignore
			}
			process.stdin.pause();
		};
	}

	const forwardSignal = (signal: NodeJS.Signals) => {
		try {
			if (ptyHandle) ptyHandle.kill(signal);
			else if (pipeChild && !pipeChild.killed) pipeChild.kill(signal);
		} catch {
			// ignore
		}
	};
	if (options.tee) {
		process.once("SIGINT", forwardSignal);
		process.once("SIGTERM", forwardSignal);
	}

	async function finalize(
		status: ProcStatus,
		exitCode: number,
		signal: NodeJS.Signals | string | null,
	): Promise<void> {
		sink.finish();
		await updateRunState(runId, {
			status,
			exitCode,
			signal,
			endedAt: new Date().toISOString(),
		});
		controlServer?.broadcastExit({ status, exitCode, signal });
		await controlServer?.close();
		interactiveCleanup?.();
	}

	// Wait for the exit info captured by the early-registered listeners.
	const awaitExit = (): Promise<{
		exitCode: number;
		signal: NodeJS.Signals | string | null;
	}> =>
		new Promise((resolve) => {
			if (earlyExit) resolve(earlyExit);
			else exitWaiters.push(resolve);
		});

	if (!ptyHandle && !pipeChild) return 1;

	const { exitCode, signal } = await awaitExit();
	const status: ProcStatus =
		signal && exitCode !== 0
			? "stopped"
			: exitCode === 0
				? "exited"
				: "failed";
	await finalize(status, exitCode, signal);
	return exitCode;
}

function signalNumberToName(
	num: number | string | null,
): NodeJS.Signals | null {
	if (typeof num !== "number") return (num as NodeJS.Signals) ?? null;
	const map: Record<number, NodeJS.Signals> = {
		1: "SIGHUP",
		2: "SIGINT",
		9: "SIGKILL",
		15: "SIGTERM",
	};
	return map[num] ?? null;
}

export async function runForeground(
	options: Omit<CreateRunOptions, "foreground"> & { quiet?: boolean },
): Promise<number> {
	const run = await createManagedRun({ ...options, foreground: true });
	if (!options.quiet) {
		const label = run.meta.name
			? `${run.meta.name} (${run.meta.runId})`
			: run.meta.runId;
		process.stderr.write(
			`[pi-proc] run ${label} — logs ${run.meta.logDir} (proc_logs_query can read these)\n`,
		);
	}
	return superviseRun(run.meta.runId, {
		tee: true,
		allowControlSocket: false,
	});
}

/**
 * Wrap `superviseRun` in an outer loop that honours the run's onExit policy.
 * When the child exits non-zero and `meta.onExit.kind === "restart"`, the
 * supervisor sleeps for an exponential backoff, increments `restartCount`,
 * and re-spawns. After `max` failed restarts, the terminal status is
 * preserved as today.
 *
 * Clients attached via the control socket are disconnected across restarts
 * (each iteration opens a fresh socket). They can re-attach to pick up the
 * new child.
 */
export async function superviseRunWithRestart(
	runId: string,
	options: SuperviseOptions,
): Promise<number> {
	const initialRun = await readRun(runId);
	if (!initialRun) throw new Error(`Unknown proc run: ${runId}`);
	const policy = initialRun.meta.onExit ?? { kind: "none" };

	let exitCode = await superviseRun(runId, options);

	if (policy.kind !== "restart") return exitCode;

	const max = policy.max ?? 5;
	const baseBackoff = policy.backoffMs ?? 1000;
	const maxBackoff = 60_000;

	while (exitCode !== 0) {
		const current = await readRun(runId);
		if (!current) return exitCode;
		const restartCount = current.state.restartCount ?? 0;
		if (restartCount >= max) {
			// Give up; leave terminal status as-is.
			return exitCode;
		}

		const backoff = Math.min(maxBackoff, baseBackoff * 2 ** restartCount);
		await new Promise<void>((resolve) => setTimeout(resolve, backoff));

		// Reset state for the next attempt and bump the counter.
		await updateRunState(runId, {
			status: "starting",
			supervisorPid: process.pid,
			childPid: null,
			exitCode: null,
			signal: null,
			endedAt: null,
			readyAt: null,
			restartCount: restartCount + 1,
			lastRestartAt: new Date().toISOString(),
		});

		exitCode = await superviseRun(runId, options);
	}

	return exitCode;
}
