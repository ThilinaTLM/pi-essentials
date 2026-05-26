import { matchesGlob } from "../glob.js";
import { reconcileAllRuns } from "../process.js";
import { deleteRun, listRuns } from "../store.js";
import { isTerminalStatus, type ProcStatus } from "../types.js";
import { CliError } from "./errors.js";
import { color, writeLine } from "./output.js";

export interface PruneCommandOptions {
	keep?: string;
	olderThan?: string;
	dryRun?: boolean;
	status?: string;
	name?: string;
}

const UNIT_MS: Record<string, number> = {
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

function parseDuration(raw: string, flag: string): number {
	const match = raw.match(/^(\d+)(s|m|h|d)$/);
	if (!match) {
		throw new CliError(
			`${flag} expects e.g. 30s, 10m, 1h, 7d (got "${raw}").`,
		);
	}
	return Number(match[1]) * UNIT_MS[match[2]];
}

function parseKeep(raw: string | undefined): number {
	if (raw === undefined) return 50;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) {
		throw new CliError(
			`--keep expects a non-negative integer, got "${raw}".`,
		);
	}
	return Math.floor(n);
}

export async function cmdPrune(flags: PruneCommandOptions): Promise<void> {
	const keep = parseKeep(flags.keep);
	const olderThanMs = flags.olderThan
		? parseDuration(flags.olderThan, "--older-than")
		: undefined;
	const dryRun = Boolean(flags.dryRun);
	const statusFilter = parseStatusList(flags.status);
	const nameGlob = flags.name;

	await reconcileAllRuns();
	const all = await listRuns({ limit: 10_000 });
	const terminated = all.filter((r) => isTerminalStatus(r.state.status));
	// Pre-filter: apply --status / --name *before* counting survivors so the
	// --keep N cap applies within the filtered set, not the whole history.
	const eligible = terminated.filter((r) => {
		if (statusFilter.length > 0 && !statusFilter.includes(r.state.status)) {
			return false;
		}
		if (nameGlob) {
			if (!r.meta.name) return false;
			if (!matchesGlob(nameGlob, r.meta.name)) return false;
		}
		return true;
	});
	const cutoff = olderThanMs ? Date.now() - olderThanMs : undefined;
	const sorted = eligible.sort(
		(a, b) =>
			new Date(b.meta.startedAt).getTime() -
			new Date(a.meta.startedAt).getTime(),
	);
	const survivors = sorted.slice(0, keep);
	const survivorIds = new Set(survivors.map((r) => r.meta.runId));
	const victims = sorted.filter((r) => {
		if (survivorIds.has(r.meta.runId)) return false;
		if (cutoff && new Date(r.meta.startedAt).getTime() > cutoff) return false;
		return true;
	});
	for (const run of victims) {
		const label = run.meta.name ?? run.meta.runId;
		writeLine(
			`${dryRun ? color.dim("[dry-run] ") : ""}prune ${label} (${run.state.status})`,
		);
		if (!dryRun) await deleteRun(run.meta.runId);
	}
	const filterDesc = describeFilters(statusFilter, nameGlob);
	writeLine(
		`${dryRun ? "Would delete" : "Deleted"} ${victims.length} run(s)${filterDesc}; kept ${survivors.length}, ${all.length - terminated.length} still active.`,
	);
}

function describeFilters(
	statusFilter: ProcStatus[],
	nameGlob: string | undefined,
): string {
	const parts: string[] = [];
	if (statusFilter.length > 0) parts.push(`status ∈ ${statusFilter.join(",")}`);
	if (nameGlob) parts.push(`name ~ ${nameGlob}`);
	return parts.length > 0 ? ` (filtered by ${parts.join(", ")})` : "";
}

// Status filter helper exposed for tests + future phase D extension.
export function parseStatusList(raw: string | undefined): ProcStatus[] {
	if (!raw) return [];
	const items = raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
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
	for (const item of items) {
		if (!allowed.includes(item as ProcStatus)) {
			throw new CliError(
				`Unknown status "${item}" in --status list.`,
				`Allowed: ${allowed.join(", ")}.`,
			);
		}
	}
	return items as ProcStatus[];
}
