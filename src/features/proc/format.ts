import type { ProcRunMeta } from "./types.js";

/**
 * Human-readable command line for a run. Equivalent to what `ps -f` would
 * show: argv joined with spaces. Falls back to `meta.command` if argv is
 * empty (should not happen for runs created via the public APIs, but keeps
 * the helper total).
 *
 * Note: arguments containing spaces or shell metacharacters are not quoted —
 * same caveat as `ps -f`. The goal is informative display, not a
 * round-trippable command string.
 */
export function formatRunCommand(
	meta: Pick<ProcRunMeta, "command" | "argv">,
): string {
	if (meta.argv && meta.argv.length > 0) return meta.argv.join(" ");
	return meta.command;
}
