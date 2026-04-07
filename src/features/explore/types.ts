import type { AgentToolResult } from "@mariozechner/pi-coding-agent";

export interface SubagentMessage {
	role: string;
	content: Array<
		| { type: "text"; text: string }
		| { type: "toolCall"; name: string; arguments: Record<string, unknown> }
	>;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
		totalTokens?: number;
	};
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface ExploreResult {
	task: string;
	exitCode: number;
	messages: SubagentMessage[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface ExploreDetails {
	mode: "single" | "parallel";
	results: ExploreResult[];
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

export type OnUpdateCallback = (
	partial: AgentToolResult<ExploreDetails>,
) => void;
