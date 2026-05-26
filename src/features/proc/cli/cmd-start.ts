import { autoPruneIfNeeded } from "../auto-prune.js";
import { stopResolvedRun } from "../process.js";
import { startDetachedRun } from "../runner.js";
import { readRun, resolveRun } from "../store.js";
import { ACTIVE_STATUSES, type OnExitPolicy } from "../types.js";
import { formatReadyLine, waitForReady } from "../wait-ready.js";
import { buildRunOptions, type RunCommandOptions } from "./cmd-run.js";
import { CliError } from "./errors.js";
import { color, writeLine } from "./output.js";

export interface StartCommandOptions extends RunCommandOptions {
	replace?: boolean;
	reuse?: boolean;
	waitReady?: string | boolean;
	onExit?: string;
}

const DEFAULT_WAIT_READY_MS = 30_000;

function parseWaitReady(raw: string | boolean | undefined): number | null {
	if (raw === undefined || raw === false) return null;
	if (raw === true) return DEFAULT_WAIT_READY_MS;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) {
		throw new CliError(
			`--wait-ready expects a non-negative number of milliseconds, got "${raw}".`,
		);
	}
	return Math.floor(n);
}

const UNIT_MS_MAP: Record<string, number> = {
	ms: 1,
	s: 1000,
	m: 60_000,
	h: 3_600_000,
};

function parseBackoff(raw: string): number {
	const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
	if (!match) {
		throw new CliError(
			`Backoff must be a number, optionally suffixed with ms|s|m|h (got "${raw}").`,
		);
	}
	const amount = Number(match[1]);
	const unit = (match[2] ?? "ms") as keyof typeof UNIT_MS_MAP;
	return Math.floor(amount * UNIT_MS_MAP[unit]);
}

/**
 * Parse the `--on-exit <policy>` flag. Accepted forms:
 *   none
 *   restart
 *   restart:max=5
 *   restart:max=5,backoff=1s
 */
export function parseOnExitPolicy(raw: string | undefined): OnExitPolicy | undefined {
	if (!raw) return undefined;
	if (raw === "none") return { kind: "none" };
	const match = raw.match(/^restart(?::(.+))?$/);
	if (!match) {
		throw new CliError(
			`--on-exit expects "none" or "restart[:opts]" (got "${raw}").`,
			'Examples: --on-exit restart, --on-exit restart:max=5,backoff=2s',
		);
	}
	const policy: OnExitPolicy = { kind: "restart" };
	const optsRaw = match[1];
	if (!optsRaw) return policy;
	for (const part of optsRaw.split(",")) {
		const [key, value] = part.split("=");
		if (key === "max") {
			const n = Number(value);
			if (!Number.isFinite(n) || n < 0)
				throw new CliError(`--on-exit max= expects a non-negative integer.`);
			policy.max = Math.floor(n);
		} else if (key === "backoff") {
			policy.backoffMs = parseBackoff(value ?? "");
		} else {
			throw new CliError(
				`Unknown --on-exit option "${key}".`,
				'Allowed: max=N, backoff=Ns (or Nms/Nm/Nh).',
			);
		}
	}
	return policy;
}

export async function cmdStart(
	name: string,
	flags: StartCommandOptions,
	commandArgs: string[],
): Promise<void> {
	if (!name) {
		throw new CliError(
			"start requires a name.",
			"Usage: pi-proc start <name> [opts] -- <cmd...>",
		);
	}
	if (flags.replace && flags.reuse) {
		throw new CliError(
			"--replace and --reuse are mutually exclusive.",
			"Pick one.",
		);
	}
	const baseOptions = buildRunOptions(flags, commandArgs, { name });
	const onExit = parseOnExitPolicy(flags.onExit);
	const options = onExit ? { ...baseOptions, onExit } : baseOptions;
	const conflict: "fail" | "replace" | "reuse" = flags.replace
		? "replace"
		: flags.reuse
			? "reuse"
			: "fail";

	const existing = await resolveRun({
		name: options.name,
		cwd: options.cwd,
		statusIn: ACTIVE_STATUSES,
	});
	if (existing) {
		if (conflict === "fail") {
			throw new CliError(
				`A run named "${options.name}" is already active here (run id ${existing.meta.runId}).`,
				"Pass --replace to stop it first, or --reuse to keep using it.",
			);
		}
		if (conflict === "reuse") {
			writeLine(
				`Reusing existing run ${color.cyan(existing.meta.runId)} (${existing.state.status}).`,
			);
			return;
		}
		const stop = await stopResolvedRun({
			runId: existing.meta.runId,
			reason: "replace",
		});
		writeLine(stop.message);
	}

	const started = await startDetachedRun(options);
	const label = started.run.meta.name ?? started.run.meta.runId;
	writeLine(
		`Started ${color.green(label)} (run id ${color.cyan(started.run.meta.runId)}, supervisor pid ${started.supervisorPid}).`,
	);

	const waitMs = parseWaitReady(flags.waitReady);
	if (waitMs !== null) {
		const outcome = await waitForReady(started.run.meta.runId, waitMs, 20);
		const fresh = (await readRun(started.run.meta.runId)) ?? started.run;
		writeLine(formatReadyLine(outcome, fresh, waitMs));
		if (outcome.urls.length > 0) {
			writeLine(`URLs: ${outcome.urls.join(", ")}`);
		}
		if (outcome.outcome === "exited") {
			// Early exit before ready — dump the captured tail so the user can see why.
			if (outcome.startupLines.length > 0) {
				writeLine(color.dim("-- last output --"));
				for (const line of outcome.startupLines) writeLine(line);
			}
			process.exitCode = 1;
		}
	}

	writeLine(`${color.dim("Attach with:")} pi-proc attach ${label}`);

	// Quiet GC: keep ~/.pi/proc from growing unbounded across many restarts.
	// Runs in the background; failure here must never block the start path.
	void autoPruneIfNeeded({ cwd: options.cwd }).catch(() => undefined);
}
