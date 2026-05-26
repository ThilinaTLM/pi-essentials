import { deleteRun, listRuns } from "./store.js";
import { isTerminalStatus } from "./types.js";

/**
 * Soft cap: when the count of terminated runs *for the given cwd* exceeds
 * `high`, delete the oldest down to `low`. Active runs are never touched.
 *
 * Designed to be invoked silently from `start` so the run log doesn't grow
 * unbounded across hundreds of dev-server restarts.
 *
 * Defaults can be overridden via env vars so users can opt out without code
 * changes:
 *   PI_PROC_NO_AUTOPRUNE=1        disables entirely
 *   PI_PROC_AUTOPRUNE_HIGH=<N>    trigger threshold (default 200)
 *   PI_PROC_AUTOPRUNE_LOW=<N>     post-prune target (default 100)
 */
export interface AutoPruneOptions {
	cwd: string;
	high?: number;
	low?: number;
}

export interface AutoPruneResult {
	skipped: boolean;
	deletedCount: number;
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export async function autoPruneIfNeeded(
	options: AutoPruneOptions,
): Promise<AutoPruneResult> {
	if (process.env.PI_PROC_NO_AUTOPRUNE === "1") {
		return { skipped: true, deletedCount: 0 };
	}
	const high = options.high ?? envInt("PI_PROC_AUTOPRUNE_HIGH", 200);
	const low = options.low ?? envInt("PI_PROC_AUTOPRUNE_LOW", 100);
	if (low >= high) {
		// Misconfigured; bail out rather than enter an infinite-prune loop.
		return { skipped: true, deletedCount: 0 };
	}

	const all = await listRuns({ cwd: options.cwd, limit: 10_000 });
	const terminated = all.filter((r) => isTerminalStatus(r.state.status));
	if (terminated.length <= high) {
		return { skipped: false, deletedCount: 0 };
	}

	const sorted = terminated.sort(
		(a, b) =>
			new Date(b.meta.startedAt).getTime() -
			new Date(a.meta.startedAt).getTime(),
	);
	const victims = sorted.slice(low);
	for (const run of victims) {
		await deleteRun(run.meta.runId);
	}
	return { skipped: false, deletedCount: victims.length };
}
