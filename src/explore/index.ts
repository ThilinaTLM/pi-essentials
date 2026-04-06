import { defineTool, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	formatToolCall,
	formatUsageStats,
	getDisplayItems,
	getFinalOutput,
} from "./format.js";
import {
	aggregateUsage,
	emptyUsage,
	mapWithConcurrencyLimit,
	runExploreAgent,
} from "./runner.js";
import type { DisplayItem, ExploreDetails, ExploreResult } from "./types.js";

const MAX_PARALLEL = 5;
const MAX_CONCURRENCY = 3;
const COLLAPSED_ITEM_COUNT = 10;

export const exploreTool = defineTool({
	name: "explore",
	label: "Explore",
	description: [
		"Spawn read-only sub-agents to explore the codebase in isolated processes.",
		'Single mode: { task: "..." }. Parallel mode: { tasks: [{ task: "..." }, ...] } (max 5).',
		"When to use: Do a quick high-level scan first (grep/find) to assess scope.",
		"If the answer needs reading many files, tracing cross-module dependencies, or understanding a subsystem, dispatch explore agents for the heavy reading.",
		"Use parallel mode when investigating several independent areas.",
		"Do NOT use for simple lookups you can answer with a few read/grep calls.",
		"Optionally pass context to share what you already know with the sub-agent.",
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
		context: Type.Optional(
			Type.String({
				description:
					"Additional context from the parent agent to help guide exploration (e.g., what you already know, specific areas to focus on)",
			}),
		),
	}),

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const hasSingle = Boolean(params.task);
		const hasParallel = (params.tasks?.length ?? 0) > 0;

		if (Number(hasSingle) + Number(hasParallel) !== 1) {
			throw new Error(
				"Provide exactly one of: task (single mode) or tasks (parallel mode).",
			);
		}

		const model = ctx?.model;
		if (!model) throw new Error("No model available.");
		const modelId = `${model.provider}/${model.id}`;

		const makeDetails =
			(mode: "single" | "parallel") =>
			(results: ExploreResult[]): ExploreDetails => ({ mode, results });

		// --- Single mode ---
		if (params.task) {
			const result = await runExploreAgent(
				ctx.cwd,
				modelId,
				params.task,
				params.context,
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
					params.context,
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
		const text =
			context.lastComponent instanceof Text
				? context.lastComponent
				: new Text("", 0, 0);

		if (args.tasks && args.tasks.length > 0) {
			let content =
				theme.fg("toolTitle", theme.bold("explore ")) +
				theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
			for (const t of args.tasks.slice(0, 3)) {
				const preview =
					t.task.length > 50 ? `${t.task.slice(0, 50)}...` : t.task;
				content += `\n  ${theme.fg("dim", preview)}`;
			}
			if (args.tasks.length > 3) {
				content += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
			}
			text.setText(content);
			return text;
		}

		const preview = args.task
			? args.task.length > 70
				? `${args.task.slice(0, 70)}...`
				: args.task
			: "...";
		text.setText(
			theme.fg("toolTitle", theme.bold("explore ")) + theme.fg("dim", preview),
		);
		return text;
	},

	renderResult(result, { expanded }, theme) {
		const details = result.details as ExploreDetails | undefined;
		if (!details || details.results.length === 0) {
			const t = result.content[0];
			return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
		}

		const mdTheme = getMarkdownTheme();
		const fg = theme.fg.bind(theme);

		const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
			const toShow = limit ? items.slice(-limit) : items;
			const skipped = limit && items.length > limit ? items.length - limit : 0;
			let out = "";
			if (skipped > 0)
				out += theme.fg("muted", `... ${skipped} earlier items\n`);
			for (const item of toShow) {
				if (item.type === "text") {
					const preview = expanded
						? item.text
						: item.text.split("\n").slice(0, 3).join("\n");
					out += `${theme.fg("toolOutput", preview)}\n`;
				} else {
					out += `${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, fg)}\n`;
				}
			}
			return out.trimEnd();
		};

		// --- Single ---
		if (details.mode === "single" && details.results.length === 1) {
			const r = details.results[0];
			const isError =
				r.exitCode !== 0 ||
				r.stopReason === "error" ||
				r.stopReason === "aborted";
			const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const displayItems = getDisplayItems(r.messages);
			const finalOutput = getFinalOutput(r.messages);

			if (expanded) {
				const container = new Container();
				let header = `${icon} ${theme.fg("toolTitle", theme.bold("explore"))}`;
				if (isError && r.stopReason)
					header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				container.addChild(new Text(header, 0, 0));
				if (isError && r.errorMessage)
					container.addChild(
						new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
					);
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
				container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
				if (displayItems.length === 0 && !finalOutput) {
					container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
				} else {
					for (const item of displayItems) {
						if (item.type === "toolCall")
							container.addChild(
								new Text(
									`${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, fg)}`,
									0,
									0,
								),
							);
					}
					if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					}
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
				}
				return container;
			}

			// Collapsed
			let out = `${icon} ${theme.fg("toolTitle", theme.bold("explore"))}`;
			if (isError && r.stopReason)
				out += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
			if (isError && r.errorMessage)
				out += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
			else if (displayItems.length === 0)
				out += `\n${theme.fg("muted", "(no output)")}`;
			else out += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
			const usageStr = formatUsageStats(r.usage, r.model);
			if (usageStr) out += `\n${theme.fg("dim", usageStr)}`;
			return new Text(out, 0, 0);
		}

		// --- Parallel ---
		const running = details.results.filter((r) => r.exitCode === -1).length;
		const successCount = details.results.filter((r) => r.exitCode === 0).length;
		const failCount = details.results.filter((r) => r.exitCode > 0).length;
		const isRunning = running > 0;
		const icon = isRunning
			? theme.fg("warning", "⏳")
			: failCount > 0
				? theme.fg("warning", "◐")
				: theme.fg("success", "✓");
		const status = isRunning
			? `${successCount + failCount}/${details.results.length} done, ${running} running`
			: `${successCount}/${details.results.length} tasks`;

		if (expanded && !isRunning) {
			const container = new Container();
			container.addChild(
				new Text(
					`${icon} ${theme.fg("toolTitle", theme.bold("explore "))}${theme.fg("accent", status)}`,
					0,
					0,
				),
			);

			for (const r of details.results) {
				const rIcon =
					r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						`${theme.fg("muted", "─── ")}${theme.fg("dim", r.task)} ${rIcon}`,
						0,
						0,
					),
				);

				for (const item of displayItems) {
					if (item.type === "toolCall")
						container.addChild(
							new Text(
								`${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, fg)}`,
								0,
								0,
							),
						);
				}

				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}

				const taskUsage = formatUsageStats(r.usage, r.model);
				if (taskUsage)
					container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
			}

			const totalUsage = formatUsageStats(aggregateUsage(details.results));
			if (totalUsage) {
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0),
				);
			}
			return container;
		}

		// Collapsed (or still running)
		let out = `${icon} ${theme.fg("toolTitle", theme.bold("explore "))}${theme.fg("accent", status)}`;
		for (const r of details.results) {
			const rIcon =
				r.exitCode === -1
					? theme.fg("warning", "⏳")
					: r.exitCode === 0
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");
			const displayItems = getDisplayItems(r.messages);
			const taskPreview =
				r.task.length > 50 ? `${r.task.slice(0, 50)}...` : r.task;
			out += `\n\n${theme.fg("muted", "─── ")}${theme.fg("dim", taskPreview)} ${rIcon}`;
			if (displayItems.length === 0)
				out += `\n${theme.fg("muted", r.exitCode === -1 ? "(exploring...)" : "(no output)")}`;
			else out += `\n${renderDisplayItems(displayItems, 5)}`;
		}
		if (!isRunning) {
			const totalUsage = formatUsageStats(aggregateUsage(details.results));
			if (totalUsage) out += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
		}
		return new Text(out, 0, 0);
	},
});
