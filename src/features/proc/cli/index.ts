import { Command, type CommanderError } from "commander";
import { superviseRunWithRestart } from "../runner.js";
import { ensureSchemaVersion } from "../store.js";
import { cmdAttach } from "./cmd-attach.js";
import { cmdComplete } from "./cmd-complete.js";
import { cmdInstallCompletion } from "./cmd-install-completion.js";
import { cmdList } from "./cmd-list.js";
import { cmdLogs } from "./cmd-logs.js";
import { cmdPrune } from "./cmd-prune.js";
import { cmdReconcile } from "./cmd-reconcile.js";
import { cmdRestart } from "./cmd-restart.js";
import { cmdRun } from "./cmd-run.js";
import { cmdStart } from "./cmd-start.js";
import { cmdStop } from "./cmd-stop.js";
import { cmdTail } from "./cmd-tail.js";
import { CliError, formatCliError } from "./errors.js";
import { color, writeErrLine } from "./output.js";

// Re-exports for back-compat with tests and external callers.
export { renderListTable, listToJson } from "./format-list.js";
export { CliError, formatCliError } from "./errors.js";
export { suggest, didYouMean } from "./suggest.js";
export { visibleWidth, padEndVisible } from "./output.js";

function build(): Command {
	const cli = new Command("pi-proc")
		.description("Managed background processes with log capture")
		.showSuggestionAfterError(true)
		.exitOverride() // we route exits through main() so we control formatting
		.configureOutput({
			// Silence commander's direct stderr writes — main() re-formats and
			// prints the translated CliError. Otherwise users see the message
			// twice (once from commander, once from us).
			writeErr: () => {},
		});

	cli
		.command("run [cmd...]", { isDefault: false })
		.description("Run a command in the foreground with PTY")
		.option("--cwd <path>", "Working directory (default: $PWD)")
		.option("--shell", "Run the joined command via the platform shell")
		.option("--force-color", "Set FORCE_COLOR=1 / CLICOLOR_FORCE=1 for the child")
		.option("--quiet", "Suppress the one-line banner")
		.option("--ready <pattern>", "Mark ready when this regex matches an output line")
		.option("--ready-url", "Mark ready on the first detected URL")
		.allowExcessArguments(true)
		.action(async (commandArgs: string[], flags) => {
			const code = await cmdRun(flags, commandArgs);
			process.exit(code);
		});

	cli
		.command("start <name> [cmd...]")
		.description("Start a named detached background run")
		.option("--cwd <path>", "Working directory (default: $PWD)")
		.option("--shell", "Run via shell")
		.option("--force-color", "Force colored child output")
		.option("--quiet", "Suppress the one-line banner")
		.option("--replace", "If a run with this name+cwd is active, stop it first")
		.option("--reuse", "If a run with this name+cwd is active, return it")
		.option("--ready <pattern>", "Ready-when regex")
		.option("--ready-url", "Ready-on-first-URL")
		.option(
			"--wait-ready [ms]",
			"Block until the run signals ready (default 30000 ms). Prints detected URLs.",
		)
		.option(
			"--on-exit <policy>",
			'Behaviour on child exit: "none" (default) or "restart[:max=5,backoff=1s]"',
		)
		.allowExcessArguments(true)
		.action(async (name: string, commandArgs: string[], flags) => {
			await cmdStart(name, flags, commandArgs);
		});

	cli
		.command("attach [target]")
		.description("Attach to a detached run (interactive)")
		.option("--quiet", "Suppress the attach banner")
		.action(async (target: string | undefined, flags) => {
			await cmdAttach(target, flags);
		});

	cli
		.command("tail <target>")
		.description("Read-only tail of a run's raw output")
		.option("-f, --follow", "Follow live output")
		.option("-n, --lines <N>", "Number of lines to print (default 200)")
		.option("--stream <s>", '"stdout" (default) or "stderr"')
		.action(async (target: string, flags) => {
			await cmdTail(target, flags);
		});

	cli
		.command("logs [target]")
		.description("Query structured log events")
		.option(
			"--mode <m>",
			"recent | errors | warnings | startup | since_last_query | first_failure | incidents | templates | rare",
		)
		.option("--errors", "Alias for --mode errors")
		.option("--warn, --warnings", "Alias for --mode warnings")
		.option("--first-failure", "Alias for --mode first_failure (root-cause view)")
		.option("--incidents", "Alias for --mode incidents (grouped error blocks)")
		.option("--templates", "Alias for --mode templates (frequency table)")
		.option("--rare", "Alias for --mode rare (anomaly surface)")
		.option("--rare-threshold <N>", "Max template count to count as rare (default 2)")
		.option("--since <dur>", "e.g. 10m, 1h, 30s")
		.option("--until <dur>", "Upper bound")
		.option("--stream <s>", "stdout | stderr | both")
		.option("--level <l>", "debug | info | warn | error")
		.option("--contains <txt>", "Case-insensitive substring filter")
		.option("--regex <pat>", "Regex filter")
		.option("--limit <N>", "Max events to return (default 100, max 500)")
		.option("--context <N>", "Lines of context around matches (default 2)")
		.option("--cwd <path>", "Working directory for name resolution")
		.option("--json", "Emit structured JSON instead of formatted output")
		.action(async (target: string | undefined, flags) => {
			await cmdLogs(target, flags);
		});

	cli
		.command("list")
		.description("List runs (default: cwd + subdirs)")
		.option("--all", "Show runs across every project on the machine")
		.option("--exact", "Restrict to the literal cwd (no subdirs)")
		.option(
			"--status <s>",
			"starting|running|exited|failed|stopped|crashed|orphaned",
		)
		.option("--limit <N|all>", "Max rows (default 10, --limit all removes cap)")
		.option("--terminated", "Show only terminated runs")
		.option("--json", "Emit structured JSON instead of a table")
		.action(async (flags) => {
			await cmdList(flags);
		});

	cli
		.command("stop [target]")
		.description("Stop one run or --all runs in this cwd")
		.option("--all", "Stop every active run in this cwd")
		.option("--signal <SIG>", "SIGTERM (default) | SIGINT | SIGKILL")
		.option(
			"--timeout <ms>",
			"Grace period before escalating to SIGKILL (default 5000)",
		)
		.action(async (target: string | undefined, flags) => {
			await cmdStop(target, flags);
		});

	cli
		.command("restart <target>")
		.description("Stop then start with the same options")
		.action(async (target: string) => {
			await cmdRestart(target);
		});

	cli
		.command("prune")
		.description("Delete terminated runs from disk")
		.option("--keep <N>", "Retain the N most recent terminated runs (default 50)")
		.option("--older-than <dur>", "Additionally drop anything older than e.g. 7d")
		.option(
			"--status <list>",
			"Comma-separated statuses to prune (e.g. crashed,failed)",
		)
		.option("--name <glob>", "Name glob (e.g. test-* or build-?-*)")
		.option("--dry-run", "Print what would be deleted without deleting")
		.action(async (flags) => {
			await cmdPrune(flags);
		});

	cli
		.command("reconcile")
		.description("Re-check pid liveness for active proc runs")
		.action(async () => {
			await cmdReconcile();
		});

	cli
		.command("install-completion <shell>")
		.description("Install shell completion (bash | zsh)")
		.option("--print", "Print the completion script to stdout instead of writing")
		.action(async (shell: string, flags) => {
			await cmdInstallCompletion(shell, flags);
		});

	// Hidden completion endpoint used by the shell scripts.
	cli
		.command("__complete <context...>", { hidden: true })
		.action(async (context: string[]) => {
			await cmdComplete(context[0] ?? "");
		});

	// Hidden supervisor entry point used by detached runs.
	cli
		.command("__supervise <runId>", { hidden: true })
		.action(async (runId: string) => {
			process.exit(
				await superviseRunWithRestart(runId, {
					tee: false,
					allowControlSocket: true,
				}),
			);
		});

	return cli;
}

function isCommanderError(err: unknown): err is CommanderError {
	return (
		err instanceof Error &&
		typeof (err as CommanderError).code === "string" &&
		(err as CommanderError).code.startsWith("commander.")
	);
}

function tidyCommanderMessage(message: string): string {
	// Commander's messages all start with "error: ". Strip it so our formatter
	// can prefix its own "Error:" without duplication.
	return message.replace(/^error:\s*/, "");
}

function translateCommanderError(err: CommanderError): CliError | null {
	// commander.helpDisplayed / version / help — these are clean exits, not errors.
	if (err.exitCode === 0) return null;
	const msg = tidyCommanderMessage(err.message);
	switch (err.code) {
		case "commander.unknownCommand":
			return new CliError(msg, "Run `pi-proc --help` to see subcommands.");
		case "commander.missingArgument":
		case "commander.missingMandatoryOptionValue":
		case "commander.optionMissingArgument":
			return new CliError(msg, "Run `pi-proc <command> --help` for usage.");
		case "commander.unknownOption":
			return new CliError(
				msg,
				"Run `pi-proc <command> --help` to see supported flags.",
			);
		case "commander.excessArguments":
			return new CliError(msg);
		default:
			return new CliError(msg);
	}
}

export async function main(args: string[]): Promise<void> {
	try {
		await ensureSchemaVersion();
		const cli = build();
		try {
			await cli.parseAsync(args, { from: "user" });
		} catch (err) {
			if (isCommanderError(err)) {
				const translated = translateCommanderError(err);
				if (!translated) {
					// Help/version display — commander already printed; exit 0.
					return;
				}
				throw translated;
			}
			throw err;
		}
	} catch (err) {
		const formatted = formatCliError(err);
		writeErrLine(formatted.message);
		process.exit(formatted.exitCode);
	}
}

// Re-export for back-compat with anything that imports `color` directly.
export { color };
