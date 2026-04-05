import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	DynamicBorder,
	defineTool,
	getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Container,
	Loader,
	Markdown,
	matchesKey,
	Spacer,
	Text,
	type TUI,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { exploreTool } from "./explore.js";

/**
 * Walk the TUI component tree and find the active Loader (spinner).
 * Used to pause the spinner during interactive custom UI to prevent
 * re-render storms that make the UI laggy.
 */
function findLoader(root: TUI): Loader | null {
	const walk = (node: { children?: Component[] }): Loader | null => {
		if (node instanceof Loader) return node;
		if (node.children) {
			for (const child of node.children) {
				const found = walk(child as unknown as { children?: Component[] });
				if (found) return found;
			}
		}
		return null;
	};
	return walk(root);
}

// --- State ---

let planActive = false;
let piRef: ExtensionAPI | null = null;

export function isPlanActive(): boolean {
	return planActive;
}

// --- Helpers ---

const PLANS_DIR = join(homedir(), ".pi", "plans");

function setPlanModeUI(ctx: ExtensionContext, active: boolean) {
	if (!active) {
		ctx.ui.setWidget("plan-mode", undefined);
		return;
	}

	ctx.ui.setWidget("plan-mode", (_tui, theme) => ({
		render: () => [theme.fg("warning", theme.bold("PLAN MODE"))],
		invalidate: () => {},
	}));
}

const PLAN_ONLY_TOOLS = [
	"plan_mode_force_exit",
	"plan_mode_present",
	"explore",
];

function setPlanToolsActive(active: boolean) {
	if (!piRef) return;
	const current = piRef.getActiveTools();
	if (active) {
		const toAdd = PLAN_ONLY_TOOLS.filter((n) => !current.includes(n));
		if (toAdd.length > 0) piRef.setActiveTools([...current, ...toAdd]);
	} else {
		const filtered = current.filter((n) => !PLAN_ONLY_TOOLS.includes(n));
		if (filtered.length !== current.length) piRef.setActiveTools(filtered);
	}
}

function exitPlanMode(ctx: ExtensionContext) {
	planActive = false;
	setPlanModeUI(ctx, false);
	setPlanToolsActive(false);
}

function enterPlanMode(ctx: ExtensionContext) {
	planActive = true;
	setPlanModeUI(ctx, true);
	setPlanToolsActive(true);
}

// --- Blocked bash patterns ---

const BLOCKED_BASH = [
	/\brm\s/,
	/\brm$/, // rm commands
];

export function isBlockedBashCommand(command: string): boolean {
	const trimmed = command.trim();
	return BLOCKED_BASH.some((pattern) => pattern.test(trimmed));
}

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

function requireContext(ctx: ExtensionContext | undefined): ExtensionContext {
	if (!ctx) {
		throw new Error("Extension context unavailable.");
	}
	return ctx;
}

// --- Tools ---

export const planEnterTool = defineTool({
	name: "plan_mode_enter",
	label: "Enter Plan Mode",
	description: `Enter plan mode — a read-only research and planning phase. You can read files, search, and run safe commands, but only write and edit files in ${PLANS_DIR}/. Use this for complex tasks that need requirements discovery, codebase research, and discussion with the user before implementation.`,
	parameters: Type.Object({}),
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		if (planActive) {
			throw new Error(
				"Already in plan mode. Use plan_mode_present to present your plan or plan_mode_force_exit to exit.",
			);
		}

		const context = requireContext(ctx);
		await mkdir(PLANS_DIR, { recursive: true });
		enterPlanMode(context);

		return {
			content: [
				{
					type: "text",
					text: `Plan mode active. Plans are saved to ${PLANS_DIR}/<feature-name>.md\n\nStart by understanding what the user needs — ask questions, research the codebase, and explore options before writing anything. You may write and edit plan files in ${PLANS_DIR}/. Use plan_mode_present only after all open questions are resolved.`,
				},
			],
			details: {},
		};
	},
	renderCall(_args, theme, context) {
		const text =
			context.lastComponent instanceof Text
				? context.lastComponent
				: new Text("", 0, 0);
		text.setText(theme.fg("toolTitle", theme.bold("Enter Plan Mode")));
		return text;
	},
	renderResult(_result, _options, theme) {
		return new Text(theme.fg("success", "Plan mode active"), 0, 0);
	},
});

export const planForceExitTool = defineTool({
	name: "plan_mode_force_exit",
	label: "Exit Plan Mode",
	description:
		"Exit plan mode without presenting the plan. Use when planning is no longer needed.",
	parameters: Type.Object({}),
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		if (!planActive) {
			throw new Error("Not in plan mode.");
		}
		const context = requireContext(ctx);
		exitPlanMode(context);
		return {
			content: [
				{ type: "text", text: "Exited plan mode. Full access restored." },
			],
			details: {},
		};
	},
	renderCall(_args, theme, context) {
		const text =
			context.lastComponent instanceof Text
				? context.lastComponent
				: new Text("", 0, 0);
		text.setText(theme.fg("toolTitle", theme.bold("Exit Plan Mode")));
		return text;
	},
	renderResult(_result, _options, theme) {
		return new Text(theme.fg("muted", "Plan mode exited."), 0, 0);
	},
});

export const planPresentTool = defineTool({
	name: "plan_mode_present",
	label: "Present Plan",
	description:
		"Present the finalized plan for user review. Only use this after all open questions and decisions are resolved through discussion. The user can accept, request changes, or discard.",
	parameters: Type.Object({
		file_path: Type.String({ description: "Path to the plan markdown file" }),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		if (!planActive) {
			throw new Error("Not in plan mode. Use plan_mode_enter first.");
		}

		const context = requireContext(ctx);
		let content: string;
		try {
			content = await readFile(params.file_path, "utf-8");
		} catch {
			throw new Error(`Could not read plan file: ${params.file_path}`);
		}

		if (!content.trim()) {
			throw new Error(
				"Plan file is empty. Write your plan first, then present it.",
			);
		}

		const options = ["Accept & Execute", "Request Changes"] as const;
		type Choice = (typeof options)[number];

		const choice = await context.ui.custom<Choice | null>(
			(tui, theme, _kb, done) => {
				// Pause the "Working..." spinner to prevent re-render storms
				// that make the plan review UI laggy and hard to scroll/select.
				const loader = findLoader(tui);
				if (loader) {
					loader.stop();
					loader.setText("");
				}

				const container = new Container();
				const border = new DynamicBorder((s: string) => theme.fg("accent", s));
				const mdTheme = getMarkdownTheme();

				let selected = 0;

				const optionLines = options.map(() => new Text("", 1, 0));

				const updateOptions = () => {
					for (let i = 0; i < options.length; i++) {
						const num = `${i + 1}.`;
						if (i === selected) {
							optionLines[i].setText(
								theme.fg("accent", `${num} ${options[i]}`),
							);
						} else {
							optionLines[i].setText(
								theme.fg("muted", `${num} `) + theme.fg("text", options[i]),
							);
						}
					}
					container.invalidate();
				};

				container.addChild(border);
				container.addChild(
					new Text(theme.fg("accent", theme.bold("Plan Review")), 1, 0),
				);
				container.addChild(new Text("", 0, 0));
				container.addChild(new Markdown(content, 1, 1, mdTheme));
				container.addChild(new Text("", 0, 0));
				container.addChild(border);
				for (const line of optionLines) container.addChild(line);
				container.addChild(new Spacer());

				updateOptions();

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (matchesKey(data, "up")) {
							selected = (selected - 1 + options.length) % options.length;
							updateOptions();
						} else if (matchesKey(data, "down")) {
							selected = (selected + 1) % options.length;
							updateOptions();
						} else if (data === "1" || data === "2") {
							done(options[parseInt(data, 10) - 1]);
						} else if (matchesKey(data, "enter")) {
							done(options[selected]);
						} else if (matchesKey(data, "escape")) {
							done(null);
						}
					},
					dispose: () => {
						// Resume the spinner when plan review closes
						if (loader) loader.start();
					},
				};
			},
		);

		if (choice === "Accept & Execute") {
			exitPlanMode(context);
			return {
				content: [
					{
						type: "text",
						text: `Plan accepted. Read the plan file at ${params.file_path} and start implementing it now.`,
					},
				],
				details: { content, action: "accepted", filePath: params.file_path },
			};
		}

		// Request Changes, cancelled, or null — stay in plan mode, stop agent turn
		context.abort();
		return {
			content: [
				{
					type: "text",
					text: `User wants changes to the plan. Update the plan file at ${params.file_path} and present again.`,
				},
			],
			details: {
				content,
				action: "changes_requested",
				filePath: params.file_path,
			},
		};
	},
	renderCall(_args, theme, context) {
		const text =
			context.lastComponent instanceof Text
				? context.lastComponent
				: new Text("", 0, 0);
		text.setText(theme.fg("toolTitle", theme.bold("Plan")));
		return text;
	},
	renderResult(result, _options, theme) {
		const details = result.details as
			| { content: string; action: string; filePath: string }
			| undefined;
		if (!details) return new Text("", 0, 0);

		const container = new Container();
		const mdTheme = getMarkdownTheme();

		// Render the full plan
		container.addChild(new Markdown(details.content, 1, 1, mdTheme));
		container.addChild(new Text("", 0, 0));

		// Status and file path at the bottom
		if (details.action === "accepted") {
			container.addChild(
				new Text(theme.fg("success", "Plan Accepted — Working on it."), 0, 0),
			);
		} else {
			container.addChild(
				new Text(
					theme.fg(
						"warning",
						"Changes Requested — Please describe what you'd like changed below.",
					),
					0,
					0,
				),
			);
		}
		container.addChild(new Text(theme.fg("dim", details.filePath), 0, 0));

		return container;
	},
});

// --- Extension registration ---

export function registerPlan(pi: ExtensionAPI) {
	piRef = pi;

	pi.registerTool(planEnterTool);
	pi.registerTool(planForceExitTool);
	pi.registerTool(planPresentTool);
	pi.registerTool(exploreTool);

	// Hide plan-only tools until plan mode is entered
	pi.on("session_start", async () => {
		setPlanToolsActive(planActive);
	});

	// Slash command — toggles plan mode
	pi.registerCommand("plan", {
		description: "Toggle plan mode",
		handler: async (_args, ctx) => {
			if (planActive) {
				exitPlanMode(ctx);
				ctx.ui.notify("Plan mode exited. Full access restored.", "info");
			} else {
				await mkdir(PLANS_DIR, { recursive: true });
				enterPlanMode(ctx);
				ctx.ui.notify("Plan mode active.", "info");
			}
		},
	});

	// Block destructive tools during plan mode
	pi.on("tool_call", async (event) => {
		if (!planActive) return;

		if (event.toolName === "notebook_edit") {
			return {
				block: true,
				reason:
					"Plan mode active — notebook_edit is not allowed. Use write/edit only for files in the plans directory, or use plan_mode_present / plan_mode_force_exit.",
			};
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			const filePath = getToolFilePath(
				event.input as {
					path?: unknown;
					file_path?: unknown;
				},
			);
			if (!filePath || !isAllowedPlanPath(filePath)) {
				const action = event.toolName === "edit" ? "Edits" : "Writes";
				return {
					block: true,
					reason: `Plan mode active — ${action.toLowerCase()} are only allowed in ${PLANS_DIR}/. Attempted: ${filePath}`,
				};
			}
		}

		// Block destructive bash commands
		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (isBlockedBashCommand(command)) {
				return {
					block: true,
					reason: `Plan mode active — destructive command blocked.\nCommand: ${command}`,
				};
			}
		}
	});

	// Inject plan mode context
	pi.on("before_agent_start", async () => {
		if (!planActive) return;

		return {
			message: {
				customType: "plan-mode-context",
				content: `[PLAN MODE ACTIVE]
You are in plan mode — a read-only research and planning mode.

Restrictions:
- READ files, search, grep, run safe bash commands
- WRITE and EDIT only in ${PLANS_DIR}/
- NO code modifications outside the plans directory

## Your Role

You are a technical partner, not an order-taker. Your job is to:
- **Research** the codebase and external options before suggesting anything
- **Challenge** assumptions — if the user's approach has trade-offs, explain them with evidence
- **Propose** alternatives when you find better options, with concrete reasoning
- **Ask** focused questions to eliminate ambiguity — don't guess, don't assume

Do not accept decisions at face value. If you disagree, say so and explain why with facts from the codebase or domain knowledge. The user wants your honest technical judgment.

## Workflow

1. **Understand** — Parse the requirements. Ask clarifying questions upfront. Do not proceed with ambiguity.
2. **Research** — Explore the codebase: file structure, key modules, types, patterns, dependencies. Understand what exists before proposing anything.
3. **Discuss** — Have an active back-and-forth with the user. Surface trade-offs, propose options, resolve unknowns. This is the most important step.
4. **Draft** — Once requirements are clear, write the plan to ${PLANS_DIR}/<feature-name>.md:
   - What problem this solves and why
   - Functional requirements
   - Implementation steps (specific files, functions, modules, approach)
   - Dependencies and order of operations
   - Mark unresolved items with [!QUESTION] or [!DECISION] callouts
5. **Refine** — Walk the user through the draft. Resolve every open item. Update until clean.
6. **Present** — Use plan_mode_present ONLY when all questions and decisions are resolved. The final plan must be self-contained and actionable with no open items.

## Plan Quality

- Every step must be specific — name files, functions, types, and modules
- Respect existing codebase patterns and conventions
- Call out breaking changes, migrations, or risks explicitly
- Keep steps small enough to be single reviewable units of work
- The final plan should be executable without follow-up questions`,
				display: false,
			},
		};
	});

	// Clean up plan mode context when not active
	pi.on("context", async (event) => {
		if (planActive) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as { customType?: string };
				return msg.customType !== "plan-mode-context";
			}),
		};
	});
}
