import pc from "picocolors";
import { stripAnsi } from "../classify.js";

export const color = pc;

/**
 * Width of a string after stripping ANSI escapes. Used wherever we need to
 * pad colored output to a column width — the raw `.length` is wrong because
 * escape sequences inflate it.
 *
 * Note: this is byte/codepoint-naive — wide CJK glyphs and emoji aren't
 * accounted for. Acceptable for the kinds of identifiers we render
 * (statuses, run names, runIds, paths).
 */
export function visibleWidth(s: string): number {
	return stripAnsi(s).length;
}

export function padEndVisible(s: string, width: number, char = " "): string {
	const need = Math.max(0, width - visibleWidth(s));
	return s + char.repeat(need);
}

export function padStartVisible(
	s: string,
	width: number,
	char = " ",
): string {
	const need = Math.max(0, width - visibleWidth(s));
	return char.repeat(need) + s;
}

/** Convenience: write `${line}\n` to stdout. */
export function writeLine(line = ""): void {
	process.stdout.write(`${line}\n`);
}

/** Convenience: write to stderr (status/diagnostic messages). */
export function writeErrLine(line = ""): void {
	process.stderr.write(`${line}\n`);
}
