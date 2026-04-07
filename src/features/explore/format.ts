import { homedir } from "node:os";
import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import type { DisplayItem, SubagentMessage, UsageStats } from "./types.js";

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns)
		parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0)
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	fg: (color: ThemeColor, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = homedir();
		return typeof p === "string" && p.startsWith(home)
			? `~${p.slice(home.length)}`
			: p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview =
				command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return `${fg("muted", "$ ")}${fg("toolOutput", preview)}`;
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = fg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return `${fg("muted", "read ")}${text}`;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return `${fg("muted", "write ")}${fg("accent", shortenPath(rawPath))}`;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return `${fg("muted", "edit ")}${fg("accent", shortenPath(rawPath))}`;
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return `${fg("muted", "ls ")}${fg("accent", shortenPath(rawPath))}`;
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return `${fg("muted", "find ")}${fg("accent", pattern)}${fg("dim", ` in ${shortenPath(rawPath)}`)}`;
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return `${fg("muted", "grep ")}${fg("accent", `/${pattern}/`)}${fg("dim", ` in ${shortenPath(rawPath)}`)}`;
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview =
				argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return `${fg("accent", toolName)}${fg("dim", ` ${preview}`)}`;
		}
	}
}

export function getDisplayItems(messages: SubagentMessage[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({
						type: "toolCall",
						name: part.name,
						args: part.arguments,
					});
			}
		}
	}
	return items;
}

export function getFinalOutput(messages: SubagentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}
