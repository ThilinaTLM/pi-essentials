const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

export function isMutatingTool(toolName: string): boolean {
	return MUTATING_TOOLS.has(toolName);
}

export function summarizeToolCall(
	toolName: string,
	input: Record<string, unknown>,
): string {
	switch (toolName) {
		case "bash": {
			const cmd = typeof input.command === "string" ? input.command : "";
			return `bash: $ ${cmd}`;
		}
		case "edit":
			return `edit: ${input.path ?? "unknown file"}`;
		case "write":
			return `write: ${input.path ?? "unknown file"}`;
		default:
			return toolName;
	}
}
