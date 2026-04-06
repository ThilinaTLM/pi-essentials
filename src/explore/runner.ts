import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getFinalOutput } from "./format.js";
import type {
	ExploreDetails,
	ExploreResult,
	OnUpdateCallback,
	SubagentMessage,
	UsageStats,
} from "./types.js";

const EXPLORE_SYSTEM_PROMPT = `You are a codebase explorer. Your ONLY job is to investigate the codebase and report findings. You must NOT modify any files — only read, search, and analyze.

Strategy:
1. Start with grep/find to locate relevant code quickly
2. Read targeted sections, not entire files
3. Follow imports and references to understand connections
4. When context is provided, build on it rather than re-discovering known information

Report your findings in this format:

## Files Explored
List each file you examined:
- \`path/to/file.ts\` (lines X-Y) — Brief description of what's there

## Findings
Your analysis, organized by topic. Include relevant code snippets inline with triple backticks. Focus on:
- Types, interfaces, and function signatures
- How components connect and depend on each other
- Patterns and conventions used

## Summary
Direct, concise answer to the exploration task.`;

export function emptyUsage(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

export function aggregateUsage(results: ExploreResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function writeSystemPromptToTemp(): { dir: string; filePath: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-explore-"));
	const filePath = join(dir, "explore-prompt.md");
	writeFileSync(filePath, EXPLORE_SYSTEM_PROMPT, {
		encoding: "utf-8",
		mode: 0o600,
	});
	return { dir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

export async function runExploreAgent(
	cwd: string,
	model: string,
	task: string,
	context: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: ExploreResult[]) => ExploreDetails,
): Promise<ExploreResult> {
	const result: ExploreResult = {
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
	};

	const emitUpdate = () => {
		onUpdate?.({
			content: [
				{
					type: "text",
					text: getFinalOutput(result.messages) || "(exploring...)",
				},
			],
			details: makeDetails([result]),
		});
	};

	const tmp = writeSystemPromptToTemp();

	try {
		const userMessage = context
			? `Context:\n${context}\n\nTask: ${task}`
			: `Task: ${task}`;

		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			model,
			"--tools",
			"read,bash",
			"--append-system-prompt",
			tmp.filePath,
			userMessage,
		];

		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: { type?: string; message?: SubagentMessage };
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message;
					result.messages.push(msg);

					if (msg.role === "assistant") {
						result.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!result.model && msg.model) result.model = msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as SubagentMessage);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: Buffer) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		result.exitCode = exitCode;
		if (wasAborted) throw new Error("Explore agent was aborted");
		return result;
	} finally {
		try {
			unlinkSync(tmp.filePath);
		} catch {
			/* ignore */
		}
		try {
			rmdirSync(tmp.dir);
		} catch {
			/* ignore */
		}
	}
}
