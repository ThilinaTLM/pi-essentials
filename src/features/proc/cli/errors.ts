import { color } from "./output.js";

/**
 * Thrown by CLI handlers for *expected* error conditions (missing target,
 * invalid flag combinations, etc.). `main()` formats these as
 *   Error: <message>
 *   Hint: <hint>
 * without a stack trace and exits with `exitCode`.
 *
 * Unexpected errors (bugs) escape as plain `Error` and main() prints them
 * with stack so they're easy to debug.
 */
export class CliError extends Error {
	constructor(
		message: string,
		public readonly hint?: string,
		public readonly exitCode = 1,
	) {
		super(message);
		this.name = "CliError";
	}
}

export interface FormattedCliError {
	message: string;
	exitCode: number;
}

export function formatCliError(err: unknown): FormattedCliError {
	if (err instanceof CliError) {
		const hintLine = err.hint ? `\n${color.dim("Hint:")} ${err.hint}` : "";
		return {
			message: `${color.red("Error:")} ${err.message}${hintLine}`,
			exitCode: err.exitCode,
		};
	}
	if (err instanceof Error) {
		// Bugs: preserve the stack so they're easy to track down.
		return { message: err.stack ?? err.message, exitCode: 1 };
	}
	return { message: String(err), exitCode: 1 };
}
