import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse as shellParse } from "shell-quote";

export const PLANS_DIR = join(homedir(), ".pi", "plans");

// --- Allowed tools in plan mode ---

const PLAN_ALLOWED_TOOLS = new Set([
	"ask_user",
	"explore",
	"find",
	"grep",
	"ls",
	"plan_mode_enter",
	"plan_mode_force_exit",
	"plan_mode_present",
	"read",
	"todos_get",
	"todos_set",
	"web_fetch",
	"web_search",
]);

// --- Blocklists ---

const BLOCKED_BASH_ROOT_COMMANDS = new Set([
	"apt",
	"apt-get",
	"bash",
	"brew",
	"bun",
	"cargo",
	"chmod",
	"chgrp",
	"chown",
	"code",
	"corepack",
	"cp",
	"dash",
	"dd",
	"deno",
	"dnf",
	"doas",
	"emacs",
	"eval",
	"exec",
	"fish",
	"function",
	"gem",
	"just",
	"kill",
	"killall",
	"ln",
	"make",
	"mkdir",
	"mkfs",
	"mount",
	"mv",
	"nano",
	"npm",
	"npx",
	"pip",
	"pip3",
	"pkill",
	"pnpm",
	"rm",
	"rmdir",
	"sh",
	"shred",
	"sudo",
	"task",
	"tee",
	"touch",
	"truncate",
	"umount",
	"vi",
	"vim",
	"yum",
	"yarn",
	"zsh",
]);

const BLOCKED_GIT_SUBCOMMANDS = new Set([
	"add",
	"am",
	"apply",
	"bisect",
	"checkout",
	"cherry-pick",
	"clean",
	"clone",
	"commit",
	"fetch",
	"gc",
	"init",
	"merge",
	"mv",
	"pull",
	"push",
	"rebase",
	"reflog",
	"reset",
	"restore",
	"revert",
	"rm",
	"stash",
	"submodule",
	"switch",
	"tag",
	"worktree",
]);

const WRAPPER_ROOT_COMMANDS = new Set([
	"command",
	"env",
	"nice",
	"nohup",
	"time",
	"timeout",
]);

const INTERPRETER_EVAL_COMMANDS = new Set([
	"deno",
	"node",
	"perl",
	"php",
	"python",
	"python3",
	"ruby",
]);

// --- Shell-quote types ---

type ParseEntry = string | { op?: string; comment?: string };

function isOpEntry(
	entry: ParseEntry,
): entry is { op: string; comment?: string } {
	return typeof entry === "object" && "op" in entry;
}

function isCommentEntry(
	entry: ParseEntry,
): entry is { comment: string; op?: string } {
	return typeof entry === "object" && "comment" in entry;
}

// --- Shell parsing ---

function parseCommand(command: string): ParseEntry[] | null {
	try {
		const result = shellParse(command, (key: string) => `$${key}`);
		if (!Array.isArray(result)) return null;
		return result as ParseEntry[];
	} catch {
		return null;
	}
}

/**
 * Quote-aware check for command substitution ($() and backticks).
 * Detects $() outside single quotes (where it's command substitution)
 * and backticks outside single quotes.
 * Unlike the old regex-based check, this correctly allows $() inside single quotes.
 */
function hasCommandSubstitution(command: string): boolean {
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];

		if (escaped) {
			escaped = false;
			continue;
		}

		if (char === "\\" && inDoubleQuote) {
			escaped = true;
			continue;
		}

		if (char === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			continue;
		}

		if (char === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			continue;
		}

		if (!inSingleQuote) {
			if (char === "$" && command[i + 1] === "(") return true;
			if (char === "`") return true;
		}
	}

	return false;
}

/**
 * Check parse output for unsafe shell constructs:
 * process substitution, subshells, backgrounding.
 */
function hasUnsafeConstructs(entries: ParseEntry[]): boolean {
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!isOpEntry(entry)) continue;

		const op = entry.op;

		// Process substitution
		if (op === "<(" || op === ">(") return true;

		// Subshell
		if (op === "(" || op === ")") return true;

		// Background operator
		if (op === "&") {
			// Allow &> (redirect both streams) when target is /dev/null
			if (
				i + 2 < entries.length &&
				isOpEntry(entries[i + 1]) &&
				(entries[i + 1] as { op: string }).op === ">" &&
				entries[i + 2] === "/dev/null"
			) {
				continue;
			}
			return true;
		}

		// Here-string
		if (op === "<<<") return true;
	}

	return false;
}

/**
 * Check parse output for unsafe redirects.
 * Allows: > /dev/null, N> /dev/null, >> /dev/null, N>&M (fd-to-fd)
 * Blocks: everything else
 */
function hasUnsafeRedirects(entries: ParseEntry[]): boolean {
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!isOpEntry(entry)) continue;

		const op = entry.op;

		// Output redirect > or >>
		if (op === ">" || op === ">>") {
			const target = entries[i + 1];
			if (typeof target === "string" && target === "/dev/null") {
				i++; // skip target
				continue;
			}
			return true;
		}

		// Input redirect <
		if (op === "<") {
			return true;
		}

		// fd-to-fd redirect like N>&M (e.g. 2>&1)
		if (op === ">&") {
			const target = entries[i + 1];
			if (typeof target === "string" && /^\d$/.test(target)) {
				i++; // skip target fd
				continue;
			}
			return true;
		}
	}

	return false;
}

/**
 * Split parse output into command segments at pipeline/list operators,
 * collecting string tokens for each segment.
 */
function extractSegments(entries: ParseEntry[]): string[][] {
	const segments: string[][] = [[]];

	for (const entry of entries) {
		// Skip comments
		if (isCommentEntry(entry)) continue;

		// String tokens go into the current segment
		if (typeof entry === "string") {
			segments[segments.length - 1].push(entry);
			continue;
		}

		if (isOpEntry(entry)) {
			const op = entry.op;

			// Segment boundary operators: start a new segment
			if (op === "|" || op === "||" || op === "&&" || op === ";") {
				if (segments[segments.length - 1].length > 0) {
					segments.push([]);
				}
			}
		}
	}

	return segments.filter((s) => s.length > 0);
}

// --- Command segment checking ---

function stripEnvVarAssignments(tokens: string[]): string[] {
	let i = 0;
	while (
		i < tokens.length &&
		/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")
	) {
		i++;
	}
	return tokens.slice(i);
}

function normalizeCommandName(command: string): string {
	return (command.split("/").pop() ?? command).trim();
}

function stripLeadingOptions(tokens: string[]): string[] {
	let index = 0;
	while (tokens[index]?.startsWith("-")) index++;
	return tokens.slice(index);
}

function unwrapCommandTokens(tokens: string[]): string[] {
	let current = tokens;

	for (let depth = 0; depth < 5; depth++) {
		const rootCommand = normalizeCommandName(current[0] ?? "");
		if (!WRAPPER_ROOT_COMMANDS.has(rootCommand)) break;

		if (rootCommand === "env") {
			let index = 1;
			while (index < current.length) {
				const token = current[index];
				if (token === "-u" || token === "--unset" || token === "-S") {
					index += 2;
					continue;
				}
				if (token.startsWith("-")) {
					index++;
					continue;
				}
				if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
					index++;
					continue;
				}
				break;
			}
			current = current.slice(index);
			continue;
		}

		if (rootCommand === "timeout") {
			const withoutOptions = stripLeadingOptions(current.slice(1));
			current = withoutOptions.slice(1);
			continue;
		}

		if (rootCommand === "nice") {
			let index = 1;
			if (current[index] === "-n") index += 2;
			else if (current[index]?.startsWith("-n")) index++;
			while (current[index]?.startsWith("-")) index++;
			current = current.slice(index);
			continue;
		}

		current = stripLeadingOptions(current.slice(1));
	}

	return current;
}

function getXargsInvokedCommandIndex(tokens: string[]): number | undefined {
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (
			token === "-E" ||
			token === "-I" ||
			token === "-L" ||
			token === "-P" ||
			token === "-d" ||
			token === "-n" ||
			token === "-s"
		) {
			i++;
			continue;
		}
		if (token.startsWith("-")) continue;
		return i;
	}
	return undefined;
}

function getGitSubcommandIndex(tokens: string[]): number | undefined {
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (
			token === "-C" ||
			token === "-c" ||
			token === "--git-dir" ||
			token === "--namespace" ||
			token === "--work-tree"
		) {
			i++;
			continue;
		}
		if (
			token === "--bare" ||
			token === "--no-pager" ||
			token === "--paginate" ||
			token.startsWith("--git-dir=") ||
			token.startsWith("--namespace=") ||
			token.startsWith("--work-tree=")
		) {
			continue;
		}
		if (token.startsWith("-")) continue;
		return i;
	}
	return undefined;
}

function hasAnyToken(tokens: string[], blocked: Set<string>): boolean {
	return tokens.some((token) => blocked.has(token));
}

function isBlockedGitInvocation(tokens: string[]): boolean {
	const rootCommand = normalizeCommandName(tokens[0] ?? "");
	if (rootCommand !== "git") return false;

	const subcommandIndex = getGitSubcommandIndex(tokens);
	if (subcommandIndex === undefined) return false;

	const subcommand = tokens[subcommandIndex];
	const args = tokens.slice(subcommandIndex + 1);

	if (subcommand === "branch") {
		return hasAnyToken(
			args,
			new Set(["-d", "-D", "-m", "-M", "--delete", "--move"]),
		);
	}

	if (subcommand === "config") {
		return !args.some(
			(arg) =>
				arg === "--get" ||
				arg === "--get-all" ||
				arg === "--get-regexp" ||
				arg === "--list" ||
				arg === "--name-only" ||
				arg === "--show-origin" ||
				arg === "-l",
		);
	}

	if (subcommand === "diff") {
		return args.some(
			(arg) => arg === "--output" || arg.startsWith("--output="),
		);
	}

	if (subcommand === "remote") {
		const remoteAction = args.find((arg) => !arg.startsWith("-"));
		return !(
			remoteAction === undefined ||
			remoteAction === "get-url" ||
			remoteAction === "show"
		);
	}

	return BLOCKED_GIT_SUBCOMMANDS.has(subcommand);
}

function isBlockedByCommandOptions(tokens: string[]): boolean {
	const rootCommand = normalizeCommandName(tokens[0] ?? "");

	if (rootCommand === "find" || rootCommand === "fd") {
		return hasAnyToken(
			tokens,
			new Set([
				"-X",
				"-delete",
				"-exec",
				"-execdir",
				"-ok",
				"-okdir",
				"-x",
				"--exec",
				"--exec-batch",
			]),
		);
	}

	if (
		(rootCommand === "sed" || rootCommand === "perl") &&
		tokens.some((token) => token === "-i" || token.startsWith("-i."))
	) {
		return true;
	}

	if (rootCommand === "curl" || rootCommand === "wget") {
		for (let i = 1; i < tokens.length; i++) {
			const token = tokens[i];
			if (
				token === "-O" ||
				token === "-o" ||
				token === "--output" ||
				token === "--remote-name" ||
				token.startsWith("-O") ||
				token.startsWith("-o") ||
				token.startsWith("--output=")
			) {
				return true;
			}

			const requestMethod =
				token === "-X" || token === "--request"
					? tokens[i + 1]
					: token.startsWith("-X")
						? token.slice(2)
						: token.startsWith("--request=")
							? token.slice("--request=".length)
							: undefined;
			if (
				requestMethod &&
				!["GET", "HEAD", "OPTIONS"].includes(requestMethod.toUpperCase())
			) {
				return true;
			}

			if (
				token === "-d" ||
				token === "-F" ||
				token === "--data" ||
				token === "--data-raw" ||
				token === "--form" ||
				token === "--post-data" ||
				token.startsWith("--data=") ||
				token.startsWith("--data-raw=") ||
				token.startsWith("--form=") ||
				token.startsWith("--post-data=")
			) {
				return true;
			}
		}
	}

	if (INTERPRETER_EVAL_COMMANDS.has(rootCommand)) {
		return tokens.some(
			(token) => token === "-c" || token === "-e" || token.startsWith("-e"),
		);
	}

	return false;
}

function isBlockedCommandSegment(tokens: string[]): boolean {
	const stripped = stripEnvVarAssignments(tokens);
	const unwrapped = unwrapCommandTokens(stripped);
	if (unwrapped.length === 0) return false;

	const rootCommand = normalizeCommandName(unwrapped[0]);

	if (rootCommand === "xargs") {
		const invokedIndex = getXargsInvokedCommandIndex(unwrapped);
		if (invokedIndex === undefined) return false;
		return isBlockedCommandSegment(unwrapped.slice(invokedIndex));
	}

	if (BLOCKED_BASH_ROOT_COMMANDS.has(rootCommand)) return true;
	if (isBlockedGitInvocation(unwrapped)) return true;
	return isBlockedByCommandOptions(unwrapped);
}

// --- Path guardrail ---

function resolvePath(filePath: string): string {
	if (filePath.startsWith("~/")) {
		return join(homedir(), filePath.slice(2));
	}
	return resolve(filePath);
}

export function isAllowedPlanPath(filePath: string): boolean {
	const resolvedPath = resolvePath(filePath);
	const relativePath = relative(PLANS_DIR, resolvedPath);
	return (
		relativePath === "" ||
		(!relativePath.startsWith("..") && !isAbsolute(relativePath))
	);
}

function getToolFilePath(input: {
	path?: unknown;
	file_path?: unknown;
}): string | undefined {
	return typeof input.path === "string"
		? input.path
		: typeof input.file_path === "string"
			? input.file_path
			: undefined;
}

// --- Main entry points ---

export function isAllowedPlanBashCommand(command: string): boolean {
	if (!command.trim()) return false;

	// Quote-aware check for command substitution on the raw string.
	// This catches $() and backticks outside single quotes.
	// shell-quote can't distinguish single vs double-quoted $(),
	// so we use a custom quote-aware check on the raw string.
	if (hasCommandSubstitution(command)) return false;

	// Parse with shell-quote for tokenization and operator detection.
	// Fail-closed: if parsing fails, block the command.
	const entries = parseCommand(command);
	if (!entries || entries.length === 0) return false;

	// Check for dangerous shell constructs
	if (hasUnsafeConstructs(entries)) return false;

	// Check for unsafe redirects
	if (hasUnsafeRedirects(entries)) return false;

	// Split into command segments and check each against blocklists
	const segments = extractSegments(entries);
	if (segments.length === 0) return false;

	return segments.every((segment) => !isBlockedCommandSegment(segment));
}

const PLAN_MODE_EXIT_GUIDANCE =
	"To exit plan mode: use plan_mode_present when the plan is ready, or plan_mode_force_exit to leave without presenting.";

function buildPlanModeRejectionReason(input: {
	why: string;
	instead: string;
	details?: string;
}): string {
	const lines = [
		"Plan mode is still active.",
		`Why rejected: ${input.why}`,
		`Do this instead: ${input.instead}`,
		PLAN_MODE_EXIT_GUIDANCE,
	];

	if (input.details) {
		lines.push(input.details);
	}

	return lines.join("\n");
}

export function getPlanModeToolBlock(event: {
	toolName: string;
	input: { command?: unknown; path?: unknown; file_path?: unknown };
}): { block: true; reason: string } | undefined {
	if (event.toolName === "notebook_edit") {
		return {
			block: true,
			reason: buildPlanModeRejectionReason({
				why: "notebook_edit is not allowed during planning.",
				instead: `Use write/edit only for plan files inside ${PLANS_DIR}/, or keep researching with read/search tools.`,
			}),
		};
	}

	if (event.toolName === "edit" || event.toolName === "write") {
		const filePath = getToolFilePath(event.input);
		if (!filePath || !isAllowedPlanPath(filePath)) {
			const action = event.toolName === "edit" ? "edit" : "write";
			return {
				block: true,
				reason: buildPlanModeRejectionReason({
					why: `${action} is only allowed for files inside ${PLANS_DIR}/.`,
					instead: `Write the plan in ${PLANS_DIR}/<feature-name>.md, or continue research without modifying project files.`,
					details: `Attempted path: ${filePath}`,
				}),
			};
		}
		return;
	}

	if (event.toolName === "bash") {
		const command = event.input.command;
		if (typeof command !== "string" || !isAllowedPlanBashCommand(command)) {
			return {
				block: true,
				reason: buildPlanModeRejectionReason({
					why: "bash is restricted to planning-safe commands and blocks obvious write/destructive patterns.",
					instead:
						"Use read/explore, run direct inspection commands such as rg, git diff, or git status, or choose a safer command form.",
					details: `Attempted command: ${command}`,
				}),
			};
		}
		return;
	}

	if (!PLAN_ALLOWED_TOOLS.has(event.toolName)) {
		return {
			block: true,
			reason: buildPlanModeRejectionReason({
				why: `${event.toolName} is not in the plan-mode allowlist.`,
				instead:
					"Use planning-safe tools for research, or edit/write only inside the plans directory if you are drafting the plan.",
			}),
		};
	}
}
