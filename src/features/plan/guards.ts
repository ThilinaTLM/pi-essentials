import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const PLANS_DIR = join(homedir(), ".pi", "plans");

const BLOCKED_BASH = [/\brm\s/, /\brm$/];

function resolvePath(filePath: string): string {
	if (filePath.startsWith("~/")) {
		return join(homedir(), filePath.slice(2));
	}
	return resolve(filePath);
}

function isAllowedPlanPath(filePath: string): boolean {
	return resolvePath(filePath).startsWith(PLANS_DIR);
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

export function isBlockedBashCommand(command: string): boolean {
	const trimmed = command.trim();
	return BLOCKED_BASH.some((pattern) => pattern.test(trimmed));
}

export function getPlanModeToolBlock(event: {
	toolName: string;
	input: { command?: unknown; path?: unknown; file_path?: unknown };
}): { block: true; reason: string } | undefined {
	if (event.toolName === "notebook_edit") {
		return {
			block: true,
			reason:
				"Plan mode active — notebook_edit is not allowed. Use write/edit only for files in the plans directory, or use plan_mode_present / plan_mode_force_exit.",
		};
	}

	if (event.toolName === "edit" || event.toolName === "write") {
		const filePath = getToolFilePath(event.input);
		if (!filePath || !isAllowedPlanPath(filePath)) {
			const action = event.toolName === "edit" ? "Edits" : "Writes";
			return {
				block: true,
				reason: `Plan mode active — ${action.toLowerCase()} are only allowed in ${PLANS_DIR}/. Attempted: ${filePath}`,
			};
		}
	}

	if (event.toolName === "bash") {
		const command = event.input.command;
		if (typeof command === "string" && isBlockedBashCommand(command)) {
			return {
				block: true,
				reason: `Plan mode active — destructive command blocked.\nCommand: ${command}`,
			};
		}
	}
}
