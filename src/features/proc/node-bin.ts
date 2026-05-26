import { basename } from "node:path";

/**
 * Best-effort detection of a Node.js executable suitable for spawning helper
 * processes. The currently running process may be the `pi` binary itself
 * (which embeds Node), in which case `process.execPath` would re-launch pi
 * rather than node. We only trust `process.execPath` when the basename matches
 * `node`; otherwise prefer explicit env overrides, then fall back to plain
 * "node" on PATH.
 */
export function getNodeExecutable(): string {
	const executable = basename(process.execPath).toLowerCase();
	if (executable === "node" || executable === "node.exe")
		return process.execPath;
	return process.env.NODE_BINARY ?? process.env.NODE ?? "node";
}
