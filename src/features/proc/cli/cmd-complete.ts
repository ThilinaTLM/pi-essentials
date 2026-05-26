import { listRuns } from "../store.js";
import { ACTIVE_STATUSES } from "../types.js";

export const KNOWN_SUBCOMMANDS = [
	"run",
	"start",
	"attach",
	"tail",
	"logs",
	"list",
	"stop",
	"restart",
	"prune",
	"reconcile",
	"install-completion",
	"help",
];

/**
 * Hidden subcommand: `pi-proc __complete <context>` emits newline-separated
 * candidates for the shell completion scripts to consume.
 *
 * Contexts:
 *   subcommands       all top-level subcommand names
 *   run-names         every run name (active + terminated) in cwd
 *   active-run-names  only active run names in cwd
 */
export async function cmdComplete(context: string): Promise<void> {
	switch (context) {
		case "subcommands":
			process.stdout.write(`${KNOWN_SUBCOMMANDS.join("\n")}\n`);
			return;
		case "run-names": {
			const runs = await listRuns({ cwd: process.cwd(), limit: 500 });
			const names = Array.from(
				new Set(
					runs
						.map((r) => r.meta.name)
						.filter((n): n is string => typeof n === "string"),
				),
			).sort();
			process.stdout.write(`${names.join("\n")}\n`);
			return;
		}
		case "active-run-names": {
			const runs = await listRuns({
				cwd: process.cwd(),
				statusIn: ACTIVE_STATUSES,
				limit: 500,
			});
			const names = Array.from(
				new Set(
					runs
						.map((r) => r.meta.name)
						.filter((n): n is string => typeof n === "string"),
				),
			).sort();
			process.stdout.write(`${names.join("\n")}\n`);
			return;
		}
		default:
			// Silent — completion contexts are best-effort.
			return;
	}
}
