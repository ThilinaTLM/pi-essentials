import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const PLANS_DIR = join(homedir(), ".pi", "plans");

const PLAN_ALLOWED_TOOLS = new Set([
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

const SAFE_BASH_ROOT_COMMANDS = new Set([
	"awk",
	"basename",
	"cat",
	"cut",
	"dirname",
	"fd",
	"file",
	"find",
	"git",
	"grep",
	"head",
	"jq",
	"ls",
	"pwd",
	"realpath",
	"rg",
	"sed",
	"sort",
	"stat",
	"tail",
	"tree",
	"uniq",
	"wc",
	"which",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
	"blame",
	"branch",
	"diff",
	"grep",
	"log",
	"ls-files",
	"rev-parse",
	"show",
	"status",
]);

const BLOCKED_BASH_PATTERNS = [
	/`/,
	/\$\(/,
	/<\(/,
	/>\(/,
	/\btee\b/,
	/\bxargs\b/,
	/\b(find|fd)\b[^\n]*\s-exec\b/,
	/\bsed\s+-i\b/,
	/\bperl\s+-i\b/,
];

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

function stripQuotedStrings(command: string): string {
	let result = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (const char of command) {
		if (quote) {
			if (quote === '"' && escaped) {
				escaped = false;
				continue;
			}
			if (quote === '"' && char === "\\") {
				escaped = true;
				continue;
			}
			if (char === quote) {
				quote = null;
				result += " ";
			}
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			result += " ";
			continue;
		}

		result += char;
	}

	return result;
}

function getCommandTokens(segment: string): string[] {
	const tokens = segment.trim().split(/\s+/).filter(Boolean);
	while (tokens[0]?.includes("=") && !tokens[0].startsWith("/")) {
		tokens.shift();
	}
	return tokens;
}

function isAllowedBashSegment(segment: string): boolean {
	const tokens = getCommandTokens(segment);
	if (tokens.length === 0) return true;

	const [rootCommand, subcommand] = tokens;
	if (!SAFE_BASH_ROOT_COMMANDS.has(rootCommand)) {
		return false;
	}

	if (rootCommand !== "git") {
		return true;
	}

	return typeof subcommand === "string" && SAFE_GIT_SUBCOMMANDS.has(subcommand);
}

export function isAllowedPlanBashCommand(command: string): boolean {
	const normalized = stripQuotedStrings(command).trim();
	if (!normalized) return false;

	if (/[<>]/.test(normalized)) {
		return false;
	}

	if (/[(){}]/.test(normalized)) {
		return false;
	}

	if (/(^|[^&])&([^&]|$)/.test(normalized)) {
		return false;
	}

	if (BLOCKED_BASH_PATTERNS.some((pattern) => pattern.test(normalized))) {
		return false;
	}

	const segments = normalized
		.split(/&&|\|\||[;|]/)
		.map((segment) => segment.trim())
		.filter(Boolean);
	if (segments.length === 0) {
		return false;
	}

	return segments.every((segment) => isAllowedBashSegment(segment));
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
					why: "bash is restricted to read-only inspection commands during planning.",
					instead:
						"Use read/explore/grep/find/ls, or run a read-only bash command such as rg, git diff, git status, or find.",
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
