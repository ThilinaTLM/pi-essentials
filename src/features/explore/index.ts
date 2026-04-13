import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getSettings } from "../../shared/settings.js";
import { shortenModelId } from "../../shared/ui/model.js";
import { statusPill } from "../../shared/ui/status.js";
import { renderToolHeader } from "../../shared/ui/tool-header.js";
import { registerExploreModelCommand } from "./command.js";
import { formatToolCall, getDisplayItems, getFinalOutput } from "./format.js";
import {
	emptyUsage,
	mapWithConcurrencyLimit,
	runExploreAgent,
} from "./runner.js";
import type { ExploreDetails, ExploreResult } from "./types.js";

const MAX_PARALLEL = 5;
const MAX_CONCURRENCY = 3;
const RECENT_STEP_COUNT = 3;
const TASK_PREVIEW_LENGTH = 90;

export const exploreTool = defineTool({
	name: "explore",
	label: "Explore",
	description: [
		"Spawn read-only sub-agents to investigate the codebase in isolated processes.",
		'Single mode: { task: "...", context: "..." }. Parallel mode: { tasks: [{ task: "..." }, ...], context: "...", split_rationale: "..." } (max 5).',
		"Before using this tool, do your own quick grep/find/read lookup to size the problem.",
		"Use explore only when the remaining work requires reading many files, tracing dependencies, or understanding a subsystem.",
		"Always pass context summarizing what you already checked, what you found, and what remains unclear.",
		"In parallel mode, use the fewest agents necessary and split only into truly independent investigations.",
		"Do NOT use explore tool for simple lookups you can answer directly with a few read/grep calls.",
	].join(" "),
	parameters: Type.Object({
		task: Type.Optional(
			Type.String({
				description: "What to explore in the codebase (single mode)",
			}),
		),
		tasks: Type.Optional(
			Type.Array(
				Type.Object({
					task: Type.String({ description: "What to explore" }),
				}),
				{
					description:
						"Array of exploration tasks for parallel execution (max 5)",
				},
			),
		),
		context: Type.String({
			description:
				"Required. Summarize the parent agent's own quick grep/find/read lookup, what it found, and what remains unresolved. Mention relevant files or commands when possible.",
		}),
		split_rationale: Type.Optional(
			Type.String({
				description:
					"Required in parallel mode. Explain why these tasks are independent enough to split and why this is the right number of sub-agents.",
			}),
		),
	}),

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const hasSingle = Boolean(params.task);
		const hasParallel = (params.tasks?.length ?? 0) > 0;
		const context = params.context.trim();
		const validateTask = (task: string, label: string) => {
			if (task.trim().length < 15) {
				throw new Error(
					`${label} is too vague. Make it specific enough for a sub-agent to investigate independently.`,
				);
			}
		};

		if (Number(hasSingle) + Number(hasParallel) !== 1) {
			throw new Error(
				"Provide exactly one of: task (single mode) or tasks (parallel mode).",
			);
		}

		if (context.length < 40) {
			throw new Error(
				"Explore requires parent-agent pre-lookup. Provide context summarizing your own grep/find/read work, what you found, and what remains unclear.",
			);
		}

		if (params.task) validateTask(params.task, "Task");

		const exploreModel = getSettings().exploreModel;
		let modelId: string;
		if (exploreModel) {
			const [provider, id] = exploreModel.split("/", 2);
			const resolved = ctx?.modelRegistry.find(provider, id);
			if (!resolved)
				throw new Error(`Configured explore model not found: ${exploreModel}`);
			if (!ctx?.modelRegistry.hasConfiguredAuth(resolved))
				throw new Error(`No API key for explore model: ${exploreModel}`);
			modelId = exploreModel;
		} else {
			const model = ctx?.model;
			if (!model) throw new Error("No model available.");
			modelId = `${model.provider}/${model.id}`;
		}

		const makeDetails =
			(mode: "single" | "parallel") =>
			(results: ExploreResult[]): ExploreDetails => ({ mode, results });

		// --- Single mode ---
		if (params.task) {
			const result = await runExploreAgent(
				ctx.cwd,
				modelId,
				params.task,
				context,
				signal,
				onUpdate,
				makeDetails("single"),
			);

			const isError =
				result.exitCode !== 0 ||
				result.stopReason === "error" ||
				result.stopReason === "aborted";
			if (isError) {
				const errorMsg =
					result.errorMessage ||
					result.stderr ||
					getFinalOutput(result.messages) ||
					"(no output)";
				return {
					content: [{ type: "text", text: `Explore failed: ${errorMsg}` }],
					details: makeDetails("single")([result]),
					isError: true,
				};
			}

			return {
				content: [
					{
						type: "text",
						text: getFinalOutput(result.messages) || "(no output)",
					},
				],
				details: makeDetails("single")([result]),
			};
		}

		// --- Parallel mode ---
		const tasks = params.tasks ?? [];
		if (tasks.length > MAX_PARALLEL) {
			throw new Error(
				`Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL}.`,
			);
		}
		if (tasks.length === 1) {
			throw new Error(
				"Parallel explore needs at least 2 tasks. Use task for single-agent exploration.",
			);
		}
		const splitRationale = params.split_rationale?.trim();
		if (!splitRationale) {
			throw new Error(
				"Parallel explore requires split_rationale explaining why the tasks are independent and why this is the right number of sub-agents.",
			);
		}
		for (const [index, task] of tasks.entries()) {
			validateTask(task.task, `Task ${index + 1}`);
		}
		const normalizedTasks = tasks.map((task) => task.task.trim().toLowerCase());
		if (new Set(normalizedTasks).size !== normalizedTasks.length) {
			throw new Error("Parallel explore tasks must be distinct.");
		}

		const allResults: ExploreResult[] = tasks.map((t) => ({
			task: t.task,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: emptyUsage(),
		}));

		const emitParallelUpdate = () => {
			if (!onUpdate) return;
			const running = allResults.filter((r) => r.exitCode === -1).length;
			const done = allResults.filter((r) => r.exitCode !== -1).length;
			onUpdate({
				content: [
					{
						type: "text",
						text: `Exploring: ${done}/${allResults.length} done, ${running} running...`,
					},
				],
				details: makeDetails("parallel")([...allResults]),
			});
		};

		const results = await mapWithConcurrencyLimit(
			tasks,
			MAX_CONCURRENCY,
			async (t, index) => {
				const result = await runExploreAgent(
					ctx.cwd,
					modelId,
					t.task,
					`${context}\n\nSplit rationale: ${splitRationale}`,
					signal,
					(partial) => {
						if (partial.details?.results[0]) {
							allResults[index] = partial.details.results[0];
							emitParallelUpdate();
						}
					},
					makeDetails("parallel"),
				);
				allResults[index] = result;
				emitParallelUpdate();
				return result;
			},
		);

		const successCount = results.filter((r) => r.exitCode === 0).length;
		const summaries = results.map((r) => {
			const output = getFinalOutput(r.messages);
			return `[Task: ${r.task}] ${r.exitCode === 0 ? "completed" : "failed"}: ${output || "(no output)"}`;
		});

		return {
			content: [
				{
					type: "text",
					text: `Explored: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
				},
			],
			details: makeDetails("parallel")(results),
		};
	},

	renderCall(args, theme, context) {
		const agentCount = args.tasks?.length ?? (args.task ? 1 : 0);
		const label = agentCount === 1 ? "agent" : "agents";
		return renderToolHeader(theme, context.lastComponent, {
			title: "Explore",
			arg: `${agentCount} ${label}`,
		});
	},

	renderResult(result, _options, theme) {
		const details = result.details as ExploreDetails | undefined;
		if (!details || details.results.length === 0) {
			const t = result.content[0];
			return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
		}

		const fg = theme.fg.bind(theme);
		const preview = (text: string, max = TASK_PREVIEW_LENGTH) =>
			text.length > max ? `${text.slice(0, max - 3)}...` : text;
		const getToolCalls = (r: ExploreResult) =>
			getDisplayItems(r.messages).filter(
				(item) => item.type === "toolCall",
			) as Array<{
				type: "toolCall";
				name: string;
				args: Record<string, unknown>;
			}>;
		const isResultError = (r: ExploreResult) =>
			r.exitCode > 0 || r.stopReason === "error" || r.stopReason === "aborted";
		const getStatusBadge = (r: ExploreResult) => {
			if (r.exitCode === -1) {
				return statusPill(
					theme,
					"pending",
					getToolCalls(r).length === 0 ? "starting" : "exploring",
				);
			}
			if (isResultError(r)) return statusPill(theme, "fail", "failed");
			return statusPill(theme, "ok", "done");
		};
		const getRecentSteps = (r: ExploreResult) => {
			const toolCalls = getToolCalls(r);
			const recent = toolCalls.slice(-RECENT_STEP_COUNT);
			return {
				recent,
				remaining: Math.max(0, toolCalls.length - recent.length),
			};
		};
		const renderAgentLines = (
			r: ExploreResult,
			index: number,
			total: number,
		): string[] => {
			const isLastAgent = index === total - 1;
			const agentPrefix = isLastAgent ? "└──" : "├──";
			const childPrefix = isLastAgent ? "    " : "│   ";
			const modelTag = r.model
				? ` ${theme.fg("muted", `(${shortenModelId(r.model)})`)}`
				: "";
			const lines = [
				`${theme.fg("muted", agentPrefix)} ${theme.fg("muted", `A${index + 1}`)}${modelTag} ${getStatusBadge(r)} ${theme.fg("dim", preview(r.task))}`,
			];

			const { recent, remaining } = getRecentSteps(r);
			const childItems = recent.map((call) =>
				formatToolCall(call.name, call.args, fg),
			);
			if (remaining > 0) {
				childItems.push(theme.fg("muted", `...${remaining} more`));
			}
			if (childItems.length === 0) {
				childItems.push(
					theme.fg("muted", r.exitCode === -1 ? "(starting...)" : "(no steps)"),
				);
			}
			if (isResultError(r) && r.errorMessage) {
				childItems.push(
					theme.fg("error", `error: ${preview(r.errorMessage, 70)}`),
				);
			}

			for (let i = 0; i < childItems.length; i++) {
				const branch = i === childItems.length - 1 ? "└─" : "├─";
				lines.push(
					`${theme.fg("muted", childPrefix + branch)} ${childItems[i]}`,
				);
			}
			return lines;
		};

		const lines: string[] = [];

		for (let i = 0; i < details.results.length; i++) {
			lines.push(
				...renderAgentLines(details.results[i], i, details.results.length),
			);
		}

		return new Text(lines.join("\n"), 0, 0);
	},
});

export function registerExplore(pi: ExtensionAPI): void {
	pi.registerTool(exploreTool);
	registerExploreModelCommand(pi);
}
