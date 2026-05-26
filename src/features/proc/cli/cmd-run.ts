import path from "node:path";
import { runForeground } from "../runner.js";
import type { CreateRunOptions } from "../types.js";
import { CliError } from "./errors.js";

export interface RunCommandOptions {
	cwd?: string;
	shell?: boolean;
	forceColor?: boolean;
	quiet?: boolean;
	ready?: string;
	readyUrl?: boolean;
}

/**
 * Build a `runForeground` options bag from commander flags + the positional
 * command tokens captured after `--`.
 */
export function buildRunOptions(
	flags: RunCommandOptions,
	commandArgs: string[],
	overrides: { name?: string } = {},
): Omit<CreateRunOptions, "foreground"> & { quiet?: boolean } {
	if (commandArgs.length === 0) {
		throw new CliError(
			"No command provided.",
			"Pass the command after `--`, e.g. `pi-proc run -- node server.js`.",
		);
	}
	const shell = Boolean(flags.shell);
	return {
		name: overrides.name,
		cwd: flags.cwd ? path.resolve(flags.cwd) : process.cwd(),
		command: shell ? commandArgs.join(" ") : commandArgs[0],
		argv: commandArgs,
		shell,
		forceColor: Boolean(flags.forceColor),
		readyPattern: flags.ready,
		readyOnUrl: Boolean(flags.readyUrl),
		quiet: Boolean(flags.quiet),
	};
}

export async function cmdRun(
	flags: RunCommandOptions,
	commandArgs: string[],
): Promise<number> {
	const options = buildRunOptions(flags, commandArgs);
	return runForeground(options);
}
