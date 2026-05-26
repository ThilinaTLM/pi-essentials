import path from "node:path";
import { reconcileAllRuns } from "../process.js";
import { formatLogEvents, queryProcLogs } from "../query.js";
import type {
	ProcLogLevel,
	ProcLogsQuery,
	ProcQueryMode,
	ProcStream,
} from "../types.js";
import { CliError } from "./errors.js";
import { writeLine } from "./output.js";
import { setLogsTargetFromString } from "./resolve.js";

export interface LogsCommandOptions {
	mode?: string;
	errors?: boolean;
	warn?: boolean;
	firstFailure?: boolean;
	incidents?: boolean;
	templates?: boolean;
	rare?: boolean;
	rareThreshold?: string;
	since?: string;
	until?: string;
	stream?: string;
	level?: string;
	contains?: string;
	regex?: string;
	limit?: string;
	context?: string;
	cwd?: string;
	json?: boolean;
}

const VALID_MODES: ProcQueryMode[] = [
	"recent",
	"errors",
	"warnings",
	"startup",
	"since_last_query",
	"first_failure",
	"incidents",
	"templates",
	"rare",
];

function parseMode(raw: string | undefined): ProcQueryMode | undefined {
	if (!raw) return undefined;
	if (!(VALID_MODES as string[]).includes(raw)) {
		throw new CliError(
			`Unknown --mode value "${raw}".`,
			`Allowed: ${VALID_MODES.join(", ")}.`,
		);
	}
	return raw as ProcQueryMode;
}

function parseStream(raw: string | undefined): ProcStream | "both" | undefined {
	if (!raw) return undefined;
	if (raw !== "stdout" && raw !== "stderr" && raw !== "both") {
		throw new CliError(
			`Unknown --stream value "${raw}".`,
			'Allowed: "stdout", "stderr", "both".',
		);
	}
	return raw;
}

function parseLevel(raw: string | undefined): ProcLogLevel | undefined {
	if (!raw) return undefined;
	if (raw !== "debug" && raw !== "info" && raw !== "warn" && raw !== "error") {
		throw new CliError(
			`Unknown --level value "${raw}".`,
			'Allowed: "debug", "info", "warn", "error".',
		);
	}
	return raw;
}

function parseInt32(raw: string | undefined, flag: string): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n)) {
		throw new CliError(`${flag} expects a number, got "${raw}".`);
	}
	return Math.floor(n);
}

export async function cmdLogs(
	target: string | undefined,
	flags: LogsCommandOptions,
): Promise<void> {
	await reconcileAllRuns();

	const query: ProcLogsQuery = { mode: "recent", stream: "both" };
	if (flags.errors) query.mode = "errors";
	if (flags.warn) query.mode = "warnings";
	if (flags.firstFailure) query.mode = "first_failure";
	if (flags.incidents) query.mode = "incidents";
	if (flags.templates) query.mode = "templates";
	if (flags.rare) query.mode = "rare";
	const explicitMode = parseMode(flags.mode);
	if (explicitMode) query.mode = explicitMode;
	const rareThresholdN = parseInt32(flags.rareThreshold, "--rare-threshold");
	if (rareThresholdN !== undefined) query.rareThreshold = rareThresholdN;
	if (flags.since !== undefined) query.since = flags.since;
	if (flags.until !== undefined) query.until = flags.until;
	if (flags.contains !== undefined) query.contains = flags.contains;
	if (flags.regex !== undefined) query.regex = flags.regex;
	const limit = parseInt32(flags.limit, "--limit");
	if (limit !== undefined) query.limit = limit;
	const context = parseInt32(flags.context, "--context");
	if (context !== undefined) query.contextLines = context;
	const stream = parseStream(flags.stream);
	if (stream) query.stream = stream;
	const level = parseLevel(flags.level);
	if (level) query.level = level;
	query.cwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd();

	if (target) setLogsTargetFromString(query, target);

	const result = await queryProcLogs(query);

	if (flags.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					summary: result.summary,
					mode: query.mode,
					run: result.run?.meta.runId ?? null,
					matchedCount: result.matchedCount,
					returnedCount: result.returnedCount,
					events: result.events,
					incidents: result.incidents,
					templates: result.templates,
				},
				null,
				2,
			)}\n`,
		);
		return;
	}

	writeLine(result.summary);

	if (result.templates && result.templates.length > 0) {
		writeLine("");
		writeLine("COUNT  LEVEL  TEMPLATE");
		for (const bucket of result.templates) {
			const countStr = String(bucket.count).padStart(5);
			const levelStr = bucket.level.padEnd(5);
			writeLine(`${countStr}  ${levelStr}  ${bucket.template}`);
		}
		return;
	}

	if (result.events.length > 0) {
		const label = result.run
			? (result.run.meta.name ?? result.run.meta.runId.slice(0, 8))
			: undefined;
		writeLine(formatLogEvents(result.events, { label, format: "full" }));
	}

	if (result.incidents && result.incidents.length > 0 && query.mode === "incidents") {
		writeLine("");
		writeLine(`-- ${result.incidents.length} incident(s) summarised:`);
		for (const inc of result.incidents) {
			writeLine(
				`  #${inc.startSeq}–${inc.endSeq} (${inc.memberCount} line${inc.memberCount === 1 ? "" : "s"}, fp ${inc.fingerprint}): ${inc.summary}`,
			);
		}
	}
}
