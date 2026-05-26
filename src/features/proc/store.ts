import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
	CreateRunOptions,
	ProcRun,
	ProcRunFilter,
	ProcRunMeta,
	ProcRunState,
} from "./types.js";

const DEFAULT_LIMIT = 25;

/**
 * On-disk schema version. Bump when the layout of `~/.pi/proc` changes in
 * incompatible ways. Old roots are renamed to `proc.bak.<UTCstamp>` rather
 * than deleted, so users can recover if they need to.
 *
 * v3 (this version) added: state.restartCount, state.lastRestartAt,
 * meta.onExit. Old roots remain readable but won't have these fields.
 */
export const SCHEMA_VERSION = 3;
export const SCHEMA_VERSION_FILE = "SCHEMA_VERSION";

let schemaEnsuredFor: string | undefined;

export function getProcRoot(): string {
	return process.env.PI_PROC_DIR || path.join(homedir(), ".pi", "proc");
}

export function getRunsDir(root = getProcRoot()): string {
	return path.join(root, "runs");
}

export function getCursorsDir(root = getProcRoot()): string {
	return path.join(root, "cursors");
}

export function getSchemaVersionPath(root = getProcRoot()): string {
	return path.join(root, SCHEMA_VERSION_FILE);
}

export async function ensureProcDirs(root = getProcRoot()): Promise<void> {
	await Promise.all([
		mkdir(getRunsDir(root), { recursive: true }),
		mkdir(getCursorsDir(root), { recursive: true }),
	]);
}

/**
 * Make sure `~/.pi/proc` exists and matches the current schema version. If a
 * mismatched root is found, rename it aside and start fresh. This is safe
 * because we never store data the user would lose (logs are ephemeral) and
 * the personal-toolbelt README disclaims compatibility guarantees.
 */
export async function ensureSchemaVersion(
	root = getProcRoot(),
): Promise<{ reset: boolean; backupPath?: string }> {
	if (schemaEnsuredFor === root) return { reset: false };
	schemaEnsuredFor = root;

	if (!existsSync(root)) {
		await mkdir(root, { recursive: true });
		await writeFile(getSchemaVersionPath(root), `${SCHEMA_VERSION}\n`, "utf8");
		await ensureProcDirs(root);
		return { reset: false };
	}

	const versionPath = getSchemaVersionPath(root);
	let onDiskVersion: number | undefined;
	if (existsSync(versionPath)) {
		const raw = (await readFile(versionPath, "utf8")).trim();
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed)) onDiskVersion = parsed;
	}

	if (onDiskVersion === SCHEMA_VERSION) {
		await ensureProcDirs(root);
		return { reset: false };
	}

	const stamp = new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
	const backupPath = `${root}.bak.${stamp}`;
	await rename(root, backupPath);
	await mkdir(root, { recursive: true });
	await writeFile(getSchemaVersionPath(root), `${SCHEMA_VERSION}\n`, "utf8");
	await ensureProcDirs(root);
	return { reset: true, backupPath };
}

/** Reset module-level cache. Test-only. */
export function _resetSchemaCache(): void {
	schemaEnsuredFor = undefined;
}

export function makeRunId(now = new Date()): string {
	const stamp = now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "");
	return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export function hashKey(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function runDir(runId: string, root = getProcRoot()): string {
	return path.join(getRunsDir(root), runId);
}

export function metaPath(runId: string, root = getProcRoot()): string {
	return path.join(runDir(runId, root), "meta.json");
}

export function statePath(runId: string, root = getProcRoot()): string {
	return path.join(runDir(runId, root), "state.json");
}

export function eventsPath(runId: string, root = getProcRoot()): string {
	return path.join(runDir(runId, root), "events.ndjson");
}

export function segmentsIndexPath(runId: string, root = getProcRoot()): string {
	return path.join(runDir(runId, root), "segments.json");
}

export function rawLogPath(
	runId: string,
	stream: "stdout" | "stderr",
	root = getProcRoot(),
): string {
	return path.join(runDir(runId, root), `${stream}.log`);
}

export function controlSocketPath(runId: string, root = getProcRoot()): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pi-proc-${runId}`;
	}
	return path.join(runDir(runId, root), "control.sock");
}

export async function writeJsonAtomic(
	filePath: string,
	value: unknown,
): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(3).toString("hex")}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tmpPath, filePath);
}

async function readJson<T>(filePath: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as T;
	} catch {
		return null;
	}
}

export async function createRun(
	options: CreateRunOptions,
	root = getProcRoot(),
): Promise<ProcRun> {
	await ensureSchemaVersion(root);
	const runId = makeRunId();
	const dir = runDir(runId, root);
	await mkdir(dir, { recursive: true });

	const meta: ProcRunMeta = {
		runId,
		name: options.name,
		cwd: path.resolve(options.cwd),
		command: options.command,
		argv: options.argv,
		shell: options.shell ?? false,
		startedAt: new Date().toISOString(),
		logDir: dir,
		foreground: options.foreground,
		forceColor: options.forceColor ?? false,
		env: options.env,
		classify: options.classify,
		readyPattern: options.readyPattern,
		readyOnUrl: options.readyOnUrl,
		onExit: options.onExit,
		keepBlankLines: options.keepBlankLines ?? false,
		collapseProgress: options.collapseProgress ?? true,
	};
	const state: ProcRunState = {
		status: "starting",
		supervisorPid: process.pid,
		childPid: null,
		lastEventAt: null,
		exitCode: null,
		signal: null,
		endedAt: null,
		detectedUrls: [],
		ptyMode: null,
		readyAt: null,
		restartCount: 0,
	};

	await Promise.all([
		writeJsonAtomic(metaPath(runId, root), meta),
		writeJsonAtomic(statePath(runId, root), state),
		writeFile(eventsPath(runId, root), "", { flag: "a" }),
		writeFile(rawLogPath(runId, "stdout", root), "", { flag: "a" }),
		writeFile(rawLogPath(runId, "stderr", root), "", { flag: "a" }),
	]);

	return { meta, state };
}

export async function readRun(
	runId: string,
	root = getProcRoot(),
): Promise<ProcRun | null> {
	const meta = await readJson<ProcRunMeta>(metaPath(runId, root));
	const state = await readJson<ProcRunState>(statePath(runId, root));
	if (!meta || !state) return null;
	return { meta, state };
}

export async function updateRunState(
	runId: string,
	patch: Partial<ProcRunState>,
	root = getProcRoot(),
): Promise<ProcRunState | null> {
	const current = await readJson<ProcRunState>(statePath(runId, root));
	if (!current) return null;
	const next = { ...current, ...patch };
	await writeJsonAtomic(statePath(runId, root), next);
	return next;
}

/**
 * Returns true when `runCwd` is `filterCwd` itself or any descendant of it.
 * Used by `listRuns` so that querying from a project root surfaces runs in
 * any subproject (e.g. asking from `/foo` finds runs in `/foo/web` and
 * `/foo/api`). With `mode: "exact"` the comparison is strict.
 */
export function isCwdMatch(
	runCwd: string,
	filterCwd: string,
	mode: "descendant" | "exact" = "descendant",
): boolean {
	const filter = path.resolve(filterCwd);
	const child = path.resolve(runCwd);
	if (child === filter) return true;
	if (mode === "exact") return false;
	return child.startsWith(filter + path.sep);
}

export async function listRuns(
	filter: ProcRunFilter = {},
	root = getProcRoot(),
): Promise<ProcRun[]> {
	await ensureSchemaVersion(root);
	let ids: string[] = [];
	try {
		ids = await readdir(getRunsDir(root));
	} catch {
		return [];
	}

	const cwdMode = filter.cwdMode ?? "descendant";
	const runs = (await Promise.all(ids.map((id) => readRun(id, root))))
		.filter((run): run is ProcRun => Boolean(run))
		.filter((run) => {
			if (filter.runId && run.meta.runId !== filter.runId) return false;
			if (filter.name && run.meta.name !== filter.name) return false;
			if (filter.cwd && !isCwdMatch(run.meta.cwd, filter.cwd, cwdMode))
				return false;
			if (filter.statusIn && !filter.statusIn.includes(run.state.status))
				return false;
			if (
				filter.status &&
				filter.status !== "all" &&
				run.state.status !== filter.status
			) {
				return false;
			}
			return true;
		})
		.sort(
			(a, b) =>
				new Date(b.meta.startedAt).getTime() -
				new Date(a.meta.startedAt).getTime(),
		);

	return runs.slice(0, filter.limit ?? DEFAULT_LIMIT);
}

export async function resolveRun(
	filter: Omit<ProcRunFilter, "limit">,
	root = getProcRoot(),
): Promise<ProcRun | null> {
	if (filter.runId) return readRun(filter.runId, root);
	const runs = await listRuns({ ...filter, limit: 1 }, root);
	return runs[0] ?? null;
}

export async function deleteRun(
	runId: string,
	root = getProcRoot(),
): Promise<void> {
	await rm(runDir(runId, root), { recursive: true, force: true });
}

export function cursorPath(cursorKey: string, root = getProcRoot()): string {
	return path.join(getCursorsDir(root), `${hashKey(cursorKey)}.json`);
}

export async function readCursor(
	cursorKey: string,
	root = getProcRoot(),
): Promise<Record<string, number>> {
	return (
		(await readJson<Record<string, number>>(cursorPath(cursorKey, root))) ?? {}
	);
}

export async function writeCursor(
	cursorKey: string,
	cursor: Record<string, number>,
	root = getProcRoot(),
): Promise<void> {
	await writeJsonAtomic(cursorPath(cursorKey, root), cursor);
}

export function commandExists(filePath: string): boolean {
	return existsSync(filePath);
}
