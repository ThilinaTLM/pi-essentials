import {
	attachToRun,
	defaultDetachKey,
	sendInput,
	sendResize,
} from "../control-client.js";
import { listRuns } from "../store.js";
import {
	ACTIVE_STATUSES,
	isTerminalStatus,
	type ProcRun,
} from "../types.js";
import { CliError } from "./errors.js";
import { formatDuration } from "./format-list.js";
import { color, writeErrLine } from "./output.js";
import { pickRun } from "./pick-run.js";
import { resolveTargetOrThrow } from "./resolve.js";

function ageMs(run: ProcRun): number {
	const started = Date.parse(run.meta.startedAt);
	return Number.isFinite(started) ? Date.now() - started : 0;
}

function detachHotkeyLabel(): string {
	const env = process.env.PI_PROC_DETACH_KEY;
	if (env === undefined) return "Ctrl-\\";
	if (env === "") return "(disabled)";
	// Surface custom hotkeys best-effort: if it's a single ctrl char, render it.
	const ch = env.charCodeAt(0);
	if (env.length === 1 && ch < 32) return `Ctrl-${String.fromCharCode(64 + ch)}`;
	return env;
}

function printAttachBanner(run: ProcRun, quiet: boolean): void {
	if (quiet) return;
	const label = run.meta.name ?? run.meta.runId;
	const firstUrl = run.state.detectedUrls[0];
	writeErrLine(
		color.dim(
			`[pi-proc] attached to ${color.bold(label)} (run ${run.meta.runId})`,
		),
	);
	writeErrLine(
		color.dim(
			`          status=${run.state.status}  age=${formatDuration(ageMs(run))}  pid=${run.state.childPid ?? "?"}`,
		),
	);
	if (firstUrl) writeErrLine(color.dim(`          last URL: ${firstUrl}`));
	writeErrLine(color.dim(`          detach: ${detachHotkeyLabel()}`));
}

export interface AttachCommandOptions {
	quiet?: boolean;
}

export async function cmdAttach(
	target: string | undefined,
	flags: AttachCommandOptions = {},
): Promise<void> {
	let run: ProcRun;
	if (target) {
		run = await resolveTargetOrThrow(target, process.cwd(), "attach");
	} else {
		const candidates = await listRuns({
			cwd: process.cwd(),
			statusIn: ACTIVE_STATUSES,
			limit: 100,
		});
		run = await pickRun(candidates, {
			verb: "attach",
			emptyHint:
				'Start one with: pi-proc start <name> -- <cmd>, or pass a target name/runId.',
		});
	}

	if (isTerminalStatus(run.state.status)) {
		throw new CliError(
			`Run ${run.meta.name ?? run.meta.runId} is ${run.state.status}.`,
			'Use "pi-proc tail" to read past output.',
		);
	}

	const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const detachKey = defaultDetachKey();
	const label = run.meta.name ?? run.meta.runId;

	printAttachBanner(run, Boolean(flags.quiet));

	const session = await attachToRun(run.meta.runId, {
		cols: process.stdout.columns ?? 80,
		rows: process.stdout.rows ?? 24,
		interactive: isInteractive,
		onData: (chunk) => process.stdout.write(chunk),
		onExit: (info) => {
			writeErrLine(
				`\r\n${color.dim(`[pi-proc] run ${label} ${info.status}${
					info.exitCode !== null ? ` (exit ${info.exitCode})` : ""
				}`)}`,
			);
			cleanup();
			process.exit(info.exitCode ?? 0);
		},
	});

	function cleanup(): void {
		try {
			if (isInteractive && process.stdin.isTTY) process.stdin.setRawMode(false);
		} catch {
			// ignore
		}
		process.stdin.pause();
	}

	if (isInteractive) {
		try {
			process.stdin.setRawMode(true);
		} catch {
			// ignore
		}
		process.stdin.resume();
		process.stdin.on("data", (chunk: Buffer) => {
			if (detachKey && chunk.includes(detachKey)) {
				writeErrLine(
					`\r\n${color.dim(`[pi-proc] detached from ${label} (run continues in background)`)}`,
				);
				session.close();
				cleanup();
				process.exit(0);
			}
			sendInput(session.socket, chunk);
		});
		process.stdout.on("resize", () => {
			sendResize(
				session.socket,
				process.stdout.columns ?? 80,
				process.stdout.rows ?? 24,
			);
		});
	}
}
