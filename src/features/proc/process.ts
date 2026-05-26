import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listRuns, resolveRun, updateRunState } from "./store.js";
import {
	ACTIVE_STATUSES,
	isTerminalStatus,
	type ProcRun,
	type ProcStatus,
	type StopResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals | string, number>> = {
	SIGHUP: 1,
	SIGINT: 2,
	SIGTERM: 15,
	SIGKILL: 9,
};

export function signalExitCode(signal: NodeJS.Signals | string | null): number {
	if (!signal) return 1;
	return 128 + (SIGNAL_NUMBERS[signal] ?? 1);
}

export function isPidAlive(pid: number | null | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function killWindows(pid: number, force: boolean): Promise<void> {
	const args = ["/PID", String(pid), "/T"];
	if (force) args.push("/F");
	await execFileAsync("taskkill", args).catch(() => undefined);
}

function killUnix(
	pid: number,
	signal: NodeJS.Signals | string,
	processGroup: boolean,
): void {
	try {
		process.kill(processGroup ? -pid : pid, signal as NodeJS.Signals);
	} catch {
		// Ignore races where the process has already exited.
	}
}

/**
 * Reconcile a single run's persisted status against actual OS process state.
 * Writes the corrected status back to state.json. Unlike the old in-memory
 * `refreshRunStatus`, this never returns a different status than what is
 * persisted on disk after this call.
 */
export async function reconcileRun(run: ProcRun): Promise<ProcRun> {
	if (isTerminalStatus(run.state.status)) return run;

	const childAlive = isPidAlive(run.state.childPid);
	const supervisorAlive = isPidAlive(run.state.supervisorPid);

	if (childAlive) {
		// Even if supervisor is gone, child is still running — flag as orphaned
		// so the user knows log capture is broken.
		if (!supervisorAlive && run.meta.foreground === false) {
			const next = await updateRunState(run.meta.runId, {
				status: "orphaned",
				endedAt: new Date().toISOString(),
			});
			return next ? { meta: run.meta, state: next } : run;
		}
		return run;
	}

	if (supervisorAlive) {
		// Child gone but supervisor still up: it's mid-shutdown. Trust the
		// supervisor to update state imminently; don't second-guess it here.
		return run;
	}

	// Neither alive: process exited without state being written (likely
	// SIGKILL'd or supervisor crashed). Mark crashed.
	const next = await updateRunState(run.meta.runId, {
		status: "crashed",
		endedAt: run.state.endedAt ?? new Date().toISOString(),
	});
	return next ? { meta: run.meta, state: next } : run;
}

export async function reconcileAllRuns(): Promise<ProcRun[]> {
	const runs = await listRuns({ statusIn: ACTIVE_STATUSES, limit: 1000 });
	return Promise.all(runs.map((run) => reconcileRun(run)));
}

interface StopOptions {
	signal?: NodeJS.Signals | string;
	timeoutMs?: number;
	reason?: "user" | "restart" | "replace";
}

/**
 * Stop a run gracefully (SIGTERM, escalating to SIGKILL after `timeoutMs`).
 * On success the run is marked `stopped`, not `failed`, so `list` accurately
 * reflects user-initiated terminations.
 */
export async function stopRun(
	run: ProcRun,
	options: StopOptions = {},
): Promise<StopResult> {
	const signal = options.signal ?? "SIGTERM";
	const timeoutMs = options.timeoutMs ?? 5000;
	const reason = options.reason ?? "user";

	if (isTerminalStatus(run.state.status)) {
		return {
			run,
			stopped: true,
			message: `Run ${run.meta.name ?? run.meta.runId} already ${run.state.status}.`,
		};
	}

	const pid = run.state.childPid ?? run.state.supervisorPid;
	if (!pid) {
		return { run, stopped: false, message: "No pid recorded for run." };
	}

	if (process.platform === "win32") {
		await killWindows(pid, signal === "SIGKILL");
	} else if (!run.meta.foreground && run.state.supervisorPid) {
		killUnix(run.state.supervisorPid, signal, true);
	} else if (run.state.childPid) {
		killUnix(run.state.childPid, signal, false);
	} else {
		killUnix(pid, signal, false);
	}

	const deadline = Date.now() + Math.max(0, timeoutMs);
	while (Date.now() < deadline) {
		if (
			!isPidAlive(run.state.childPid) &&
			!isPidAlive(run.state.supervisorPid)
		) {
			break;
		}
		await delay(50);
	}

	const stillAlive =
		isPidAlive(run.state.childPid) || isPidAlive(run.state.supervisorPid);
	if (stillAlive && signal !== "SIGKILL") {
		if (process.platform === "win32") {
			await killWindows(pid, true);
		} else if (!run.meta.foreground && run.state.supervisorPid) {
			killUnix(run.state.supervisorPid, "SIGKILL", true);
		} else if (run.state.childPid) {
			killUnix(run.state.childPid, "SIGKILL", false);
		}
		await delay(200);
	}

	// Give the supervisor a brief window to write its own terminal state. If
	// it has, we keep that (e.g. clean exit code already captured); only mark
	// stopped/crashed ourselves if state is still active.
	await delay(200);
	const fresh = await resolveRun({ runId: run.meta.runId });
	if (fresh && !isTerminalStatus(fresh.state.status)) {
		const finalStatus: ProcStatus = "stopped";
		const next = await updateRunState(run.meta.runId, {
			status: finalStatus,
			signal,
			endedAt: new Date().toISOString(),
		});
		return {
			run: next ? { meta: run.meta, state: next } : run,
			stopped: true,
			message: `Sent ${signal} to ${run.meta.name ?? run.meta.runId} (${reason}).`,
		};
	}

	return {
		run: fresh ?? run,
		stopped: true,
		message: `Stopped ${run.meta.name ?? run.meta.runId}.`,
	};
}

export interface StopResolvedOptions {
	runId?: string;
	name?: string;
	cwd?: string;
	signal?: NodeJS.Signals | string;
	timeoutMs?: number;
	reason?: StopOptions["reason"];
}

function describeTerminalRun(run: ProcRun): string {
	const parts: string[] = [`runId ${run.meta.runId.slice(0, 8)}`];
	if (run.state.exitCode !== null) parts.push(`exit ${run.state.exitCode}`);
	else if (run.state.signal) parts.push(`signal ${run.state.signal}`);
	if (run.state.endedAt) parts.push(`ended ${run.state.endedAt}`);
	return `Already ${run.state.status} (${parts.join(", ")}).`;
}

export async function stopResolvedRun(
	options: StopResolvedOptions,
): Promise<StopResult> {
	const run = await resolveRun({
		runId: options.runId,
		name: options.name,
		cwd: options.cwd,
		statusIn: ACTIVE_STATUSES,
	});
	if (!run) {
		// Distinguish "already done" from "wrong name". A second lookup without
		// the active-status filter catches runs that terminated before this call.
		const terminal = await resolveRun({
			runId: options.runId,
			name: options.name,
			cwd: options.cwd,
		});
		if (terminal && isTerminalStatus(terminal.state.status)) {
			return {
				run: terminal,
				stopped: true,
				message: describeTerminalRun(terminal),
			};
		}
		const target = options.runId ?? options.name ?? "(unspecified)";
		return {
			run: null,
			stopped: false,
			message: `No process matched ${target}.`,
		};
	}
	const reconciled = await reconcileRun(run);
	if (isTerminalStatus(reconciled.state.status)) {
		return {
			run: reconciled,
			stopped: true,
			message: describeTerminalRun(reconciled),
		};
	}
	return stopRun(reconciled, {
		signal: options.signal,
		timeoutMs: options.timeoutMs,
		reason: options.reason,
	});
}

/**
 * Backwards-compatibility shim for old callers. New code should call
 * `reconcileRun` directly so the corrected status is persisted.
 */
export function refreshRunStatus(run: ProcRun): ProcRun {
	if (isTerminalStatus(run.state.status)) return run;
	const alive =
		isPidAlive(run.state.childPid) || isPidAlive(run.state.supervisorPid);
	if (alive) return run;
	return {
		...run,
		state: { ...run.state, status: "orphaned" },
	};
}
