import { reconcileAllRuns } from "../process.js";
import { listRuns } from "../store.js";
import {
	ACTIVE_STATUSES,
	isTerminalStatus,
	type ProcStatus,
	TERMINAL_STATUSES,
} from "../types.js";
import { CliError } from "./errors.js";
import { listToJson, renderListTable } from "./format-list.js";
import { color, writeLine } from "./output.js";

export interface ListCommandOptions {
	all?: boolean;
	exact?: boolean;
	status?: string;
	limit?: string;
	terminated?: boolean;
	json?: boolean;
}

const LIST_DEFAULT_LIMIT = 10;
const LIST_MAX_LIMIT = 10_000;

function parseListLimit(raw: string | undefined): number {
	if (!raw) return LIST_DEFAULT_LIMIT;
	if (raw === "all" || raw === "0") return LIST_MAX_LIMIT;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 1) {
		throw new CliError(
			`--limit expects a positive integer or "all", got "${raw}".`,
		);
	}
	return Math.min(LIST_MAX_LIMIT, Math.floor(n));
}

function parseStatus(
	raw: string | undefined,
): ProcStatus | undefined {
	if (!raw) return undefined;
	const allowed: ProcStatus[] = [
		"starting",
		"running",
		"exited",
		"failed",
		"stopped",
		"crashed",
		"orphaned",
		"stale",
	];
	if (!allowed.includes(raw as ProcStatus)) {
		throw new CliError(
			`Unknown --status value "${raw}".`,
			`Allowed: ${allowed.join(", ")}.`,
		);
	}
	return raw as ProcStatus;
}

export async function cmdList(flags: ListCommandOptions): Promise<void> {
	const scopeAll = Boolean(flags.all);
	const exact = Boolean(flags.exact);
	const statusFilter = parseStatus(flags.status);
	const limit = parseListLimit(flags.limit);

	await reconcileAllRuns();
	const cwd = scopeAll ? undefined : process.cwd();
	let runs = await listRuns({
		cwd,
		cwdMode: exact ? "exact" : "descendant",
		status: statusFilter,
		limit,
	});

	if (flags.terminated) {
		runs = runs.filter((r) => isTerminalStatus(r.state.status));
	}

	if (flags.json) {
		process.stdout.write(`${JSON.stringify(listToJson(runs), null, 2)}\n`);
		return;
	}

	if (runs.length === 0 && cwd) {
		const elsewhere = await listRuns({ limit: 1000 });
		if (elsewhere.length > 0) {
			writeLine(
				`No runs found in or under ${color.cyan(cwd)}. ${elsewhere.length} run(s) exist elsewhere — use ${color.dim("pi-proc list --all")} to see them.`,
			);
			return;
		}
	}

	writeLine(renderListTable(runs));
}

// Re-export so legacy test imports still work via the back-compat shim.
export { renderListTable, listToJson, TERMINAL_STATUSES, ACTIVE_STATUSES };
