import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { CliError } from "./errors.js";
import { color, writeLine } from "./output.js";
import { BASH_COMPLETION, ZSH_COMPLETION } from "./completion-scripts.js";

export interface InstallCompletionOptions {
	print?: boolean;
}

const VALID_SHELLS = ["bash", "zsh"] as const;
type Shell = (typeof VALID_SHELLS)[number];

function defaultTarget(shell: Shell): string {
	if (shell === "bash") {
		return path.join(homedir(), ".bash_completion.d", "pi-proc");
	}
	return path.join(homedir(), ".zsh", "completions", "_pi-proc");
}

function postInstallHint(shell: Shell, target: string): string {
	if (shell === "bash") {
		return (
			`Ensure your bash setup sources ~/.bash_completion.d/* — many distros ` +
			`do so automatically. If not, add to ~/.bashrc:\n` +
			`  for f in ~/.bash_completion.d/*; do source "$f"; done`
		);
	}
	return (
		`Add the parent directory to fpath in ~/.zshrc (before \`compinit\`):\n` +
		`  fpath=("${path.dirname(target)}" $fpath)\n` +
		`  autoload -Uz compinit && compinit`
	);
}

export async function cmdInstallCompletion(
	shell: string,
	flags: InstallCompletionOptions,
): Promise<void> {
	if (!(VALID_SHELLS as readonly string[]).includes(shell)) {
		throw new CliError(
			`Unsupported shell "${shell}".`,
			`Supported: ${VALID_SHELLS.join(", ")}.`,
		);
	}
	const typedShell = shell as Shell;
	const script = typedShell === "bash" ? BASH_COMPLETION : ZSH_COMPLETION;

	if (flags.print) {
		process.stdout.write(script);
		return;
	}

	const target = defaultTarget(typedShell);
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, script, "utf8");
	writeLine(`Installed ${typedShell} completion to ${color.cyan(target)}.`);
	writeLine(color.dim(postInstallHint(typedShell, target)));
}
