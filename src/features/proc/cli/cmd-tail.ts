import { existsSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { listSegments } from "../log-segments.js";
import { CliError } from "./errors.js";
import { writeLine } from "./output.js";
import { resolveTargetOrThrow } from "./resolve.js";

export interface TailCommandOptions {
	follow?: boolean;
	lines?: string;
	stream?: string;
}

function parseLines(raw: string | undefined): number {
	if (!raw) return 200;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 1) {
		throw new CliError(
			`-n / --lines expects a positive integer, got "${raw}".`,
		);
	}
	return Math.floor(n);
}

function parseStream(raw: string | undefined): "stdout" | "stderr" {
	if (!raw) return "stdout";
	if (raw !== "stdout" && raw !== "stderr") {
		throw new CliError(
			`--stream expects "stdout" or "stderr", got "${raw}".`,
		);
	}
	return raw;
}

export async function cmdTail(
	target: string,
	flags: TailCommandOptions,
): Promise<void> {
	const follow = Boolean(flags.follow);
	const lines = parseLines(flags.lines);
	const stream = parseStream(flags.stream);

	if (!target) {
		throw new CliError(
			"tail requires a name or run id.",
			"Usage: pi-proc tail <name|runId> [-f] [-n N]",
		);
	}
	const run = await resolveTargetOrThrow(target, process.cwd(), "tail");
	const segments = await listSegments(run.meta.runId, stream);
	if (segments.length === 0) {
		writeLine("(no output captured)");
		return;
	}

	if (!follow) {
		const tailBuf: string[] = [];
		for (const seg of [...segments].reverse()) {
			if (!existsSync(seg.path)) continue;
			const text = await readFile(seg.path, "utf8");
			const segLines = text.split(/\r?\n/);
			tailBuf.unshift(...segLines);
			if (tailBuf.length >= lines) break;
		}
		writeLine(tailBuf.slice(-lines).join("\n"));
		return;
	}

	const active = segments[segments.length - 1].path;
	let position = 0;
	if (existsSync(active)) {
		const s = await stat(active);
		position = Math.max(0, s.size - 16 * 1024);
		const content = await readFile(active, "utf8");
		process.stdout.write(content.slice(content.length - 16 * 1024));
	}
	const interval = setInterval(async () => {
		if (!existsSync(active)) return;
		const s = await stat(active);
		if (s.size <= position) return;
		const fd = await open(active, "r");
		try {
			const buffer = Buffer.alloc(s.size - position);
			await fd.read(buffer, 0, buffer.length, position);
			process.stdout.write(buffer);
			position = s.size;
		} finally {
			await fd.close();
		}
	}, 200);
	const stop = () => {
		clearInterval(interval);
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}
