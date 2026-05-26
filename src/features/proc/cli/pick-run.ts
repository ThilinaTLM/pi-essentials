import * as clack from "@clack/prompts";
import { formatRunCommand } from "../format.js";
import type { ProcRun } from "../types.js";
import { CliError } from "./errors.js";
import { color } from "./output.js";

function isInteractive(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function describe(run: ProcRun): string {
	const name = run.meta.name ?? run.meta.runId.slice(0, 12);
	return `${name} — ${formatRunCommand(run.meta)}`;
}

/**
 * Let the user pick a run from `candidates`. If exactly one candidate is
 * present, returns it without prompting. If multiple and the session is a
 * TTY, opens a clack select. If multiple and not a TTY, throws a CliError
 * listing the candidates so the caller can re-run with an explicit target.
 */
export async function pickRun(
	candidates: ProcRun[],
	context: { verb: string; emptyHint?: string },
): Promise<ProcRun> {
	if (candidates.length === 0) {
		throw new CliError(
			`No matching runs for ${context.verb}.`,
			context.emptyHint,
		);
	}
	if (candidates.length === 1) return candidates[0];

	if (!isInteractive()) {
		const lines = candidates
			.map((r) => `  ${describe(r)} (run id ${r.meta.runId})`)
			.join("\n");
		throw new CliError(
			`Multiple candidates for ${context.verb}; specify one explicitly.`,
			`Candidates:\n${lines}`,
		);
	}

	const choice = await clack.select({
		message: `Pick a run to ${context.verb}:`,
		options: candidates.map((r) => ({
			value: r.meta.runId,
			label: describe(r),
			hint: r.state.status,
		})),
	});

	if (clack.isCancel(choice)) {
		throw new CliError(`Cancelled.`, undefined, 130);
	}

	const picked = candidates.find((r) => r.meta.runId === choice);
	if (!picked) {
		throw new CliError(`Selection ${color.dim(String(choice))} not found.`);
	}
	return picked;
}
