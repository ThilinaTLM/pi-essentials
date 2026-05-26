import path from "node:path";
import { listRuns, readRun, resolveRun } from "../store.js";
import {
	ACTIVE_STATUSES,
	type ProcLogsQuery,
	type ProcRun,
} from "../types.js";
import { CliError } from "./errors.js";
import { didYouMean, suggest } from "./suggest.js";

const RUN_ID_RE = /^\d{8}T?\d{6}-[a-f0-9]{6}$/;

/** True if `target` looks like a runId (timestamp + hex suffix). */
export function looksLikeRunId(target: string): boolean {
	return RUN_ID_RE.test(target);
}

/**
 * Resolve a positional target string to a run. Tries runId first, then
 * looks up by name in the given cwd.
 */
export async function resolveTarget(
	target: string,
	cwd: string = process.cwd(),
): Promise<ProcRun | null> {
	const byRunId = await readRun(target);
	if (byRunId) return byRunId;
	return resolveRun({ name: target, cwd });
}

/**
 * Resolve a target or throw a CliError with a "did you mean?" hint built
 * from active and terminated run names in the given cwd.
 */
export async function resolveTargetOrThrow(
	target: string,
	cwd: string = process.cwd(),
	verbForError = "target",
): Promise<ProcRun> {
	const run = await resolveTarget(target, cwd);
	if (run) return run;
	const allInCwd = await listRuns({ cwd, limit: 200 });
	const names = Array.from(
		new Set(
			allInCwd
				.map((r) => r.meta.name)
				.filter((n): n is string => typeof n === "string"),
		),
	);
	const hint = didYouMean(suggest(target, names));
	throw new CliError(`No run matches "${target}" for ${verbForError}.`, hint);
}

/**
 * Convenience for `logs`-style commands that accept a target as a name or
 * runId. Mutates the query in place. Returns the resolved cwd default.
 */
export function setLogsTargetFromString(
	query: ProcLogsQuery,
	raw: string,
): void {
	if (looksLikeRunId(raw)) query.runId = raw;
	else query.name = raw;
}

export function normaliseCwd(value: string | undefined): string {
	return value ? path.resolve(value) : process.cwd();
}

export function activeRunNamesIn(cwd: string): Promise<string[]> {
	return listRuns({ cwd, statusIn: ACTIVE_STATUSES, limit: 200 }).then(
		(runs) =>
			Array.from(
				new Set(
					runs
						.map((r) => r.meta.name)
						.filter((n): n is string => typeof n === "string"),
				),
			),
	);
}
