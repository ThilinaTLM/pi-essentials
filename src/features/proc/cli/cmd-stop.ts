import { reconcileAllRuns, stopResolvedRun } from "../process.js";
import { listRuns } from "../store.js";
import { ACTIVE_STATUSES } from "../types.js";
import { CliError } from "./errors.js";
import { writeLine } from "./output.js";
import { resolveTarget } from "./resolve.js";
import { didYouMean, suggest } from "./suggest.js";

export interface StopCommandOptions {
	all?: boolean;
	signal?: string;
	timeout?: string;
}

const VALID_SIGNALS = ["SIGTERM", "SIGINT", "SIGKILL"];

function parseSignal(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	if (!VALID_SIGNALS.includes(raw)) {
		throw new CliError(
			`Unknown --signal value "${raw}".`,
			`Allowed: ${VALID_SIGNALS.join(", ")}.`,
		);
	}
	return raw;
}

function parseTimeout(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) {
		throw new CliError(
			`--timeout expects a non-negative number of milliseconds, got "${raw}".`,
		);
	}
	return n;
}

export async function cmdStop(
	target: string | undefined,
	flags: StopCommandOptions,
): Promise<void> {
	const signal = parseSignal(flags.signal);
	const timeoutMs = parseTimeout(flags.timeout);

	if (flags.all) {
		await reconcileAllRuns();
		const runs = await listRuns({
			cwd: process.cwd(),
			statusIn: ACTIVE_STATUSES,
			limit: 100,
		});
		if (runs.length === 0) {
			writeLine("No active runs in this cwd.");
			return;
		}
		for (const run of runs) {
			const result = await stopResolvedRun({
				runId: run.meta.runId,
				signal,
				timeoutMs,
			});
			writeLine(result.message);
		}
		return;
	}

	if (!target) {
		throw new CliError(
			"stop requires a name, run id, or --all.",
			"Usage: pi-proc stop <name|runId> [--signal SIG] [--timeout ms]",
		);
	}

	const existing = await resolveTarget(target);
	if (!existing) {
		const inCwd = await listRuns({
			cwd: process.cwd(),
			statusIn: ACTIVE_STATUSES,
			limit: 100,
		});
		const names = inCwd
			.map((r) => r.meta.name)
			.filter((n): n is string => typeof n === "string");
		throw new CliError(
			`No active run matches "${target}".`,
			didYouMean(suggest(target, names)),
		);
	}

	const result = await stopResolvedRun({
		runId: existing.meta.runId,
		signal,
		timeoutMs,
	});
	writeLine(result.message);
	if (!result.stopped) process.exitCode = 1;
}
