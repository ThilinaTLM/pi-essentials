import { tailRunEvents } from "./log-tailer.js";
import { readRun } from "./store.js";
import {
	isTerminalStatus,
	type ProcLogEvent,
	type ProcRun,
	type ProcStatus,
	TERMINAL_STATUSES,
} from "./types.js";

export type WaitOutcome = "ready" | "timeout" | "exited";

export interface WaitForReadyOutcome {
	reachedReady: boolean;
	outcome: WaitOutcome;
	terminalStatus?: ProcStatus;
	startupLines: string[];
	urls: string[];
}

function tidyStartupLines(lines: string[]): string[] {
	const collapsed: string[] = [];
	for (const raw of lines) {
		const line = raw.replace(/\s+$/, "");
		if (line === "" && collapsed[collapsed.length - 1] === "") continue;
		collapsed.push(line);
	}
	while (collapsed.length && collapsed[collapsed.length - 1] === "")
		collapsed.pop();
	return collapsed;
}

/**
 * Block until a detached run signals "ready" (its supervisor sets
 * `state.readyAt`), exits, or `readyTimeoutMs` elapses. Returns a normalised
 * outcome so callers (tool + CLI `start --wait-ready`) can render it
 * uniformly.
 */
export async function waitForReady(
	runId: string,
	readyTimeoutMs: number,
	startupTailLines = 10,
): Promise<WaitForReadyOutcome> {
	const tailer = await tailRunEvents(runId, { maxWaitMs: readyTimeoutMs });
	const events: ProcLogEvent[] = [];
	const urls = new Set<string>();
	let resolved = false;
	let reached = false;
	let sawTerminal = false;

	const done = new Promise<void>((resolve) => {
		const finish = () => {
			if (resolved) return;
			resolved = true;
			tailer.close();
			resolve();
		};
		tailer.onEvent(async (event) => {
			events.push(event);
			for (const url of event.line.match(/https?:\/\/[^\s)\]}'"]+/g) ?? [])
				urls.add(url);
			const fresh = await readRun(runId);
			if (fresh?.state.readyAt) {
				reached = true;
				finish();
			} else if (fresh && isTerminalStatus(fresh.state.status)) {
				sawTerminal = true;
				finish();
			}
		});
		tailer.onTerminal((status) => {
			if (TERMINAL_STATUSES.includes(status as ProcStatus)) sawTerminal = true;
			finish();
		});
	});

	await done;

	const fresh = await readRun(runId);
	for (const url of fresh?.state.detectedUrls ?? []) urls.add(url);

	let outcome: WaitOutcome;
	let terminalStatus: ProcStatus | undefined;
	if (fresh?.state.readyAt) {
		reached = true;
		outcome = "ready";
	} else if (fresh && isTerminalStatus(fresh.state.status)) {
		outcome = "exited";
		terminalStatus = fresh.state.status;
	} else if (sawTerminal) {
		outcome = "exited";
		terminalStatus = fresh?.state.status;
	} else {
		outcome = "timeout";
	}

	const tail = Math.max(0, Math.min(startupTailLines, 30));
	const startupLines =
		tail === 0
			? []
			: tidyStartupLines(events.slice(-tail).map((e) => e.ansiStripped));

	return {
		reachedReady: reached,
		outcome,
		terminalStatus,
		startupLines,
		urls: Array.from(urls),
	};
}

export function formatReadyLine(
	outcome: WaitForReadyOutcome,
	run: ProcRun,
	readyTimeoutMs: number,
): string {
	if (outcome.outcome === "ready") {
		const readyAt = run.state.readyAt;
		if (readyAt) {
			const elapsed = Date.parse(readyAt) - Date.parse(run.meta.startedAt);
			if (Number.isFinite(elapsed) && elapsed >= 0) {
				return `Ready: yes (took ${elapsed}ms)`;
			}
		}
		return "Ready: yes";
	}
	if (outcome.outcome === "timeout") {
		return `Ready: not signalled within ${readyTimeoutMs}ms (process still running).`;
	}
	const status = outcome.terminalStatus ?? run.state.status;
	const code = run.state.exitCode;
	const sig = run.state.signal;
	const detail =
		code !== null ? `exit ${code}` : sig ? `signal ${sig}` : "no exit info";
	return `Ready: no — process reached terminal status '${status}' (${detail}) before signalling ready.`;
}
