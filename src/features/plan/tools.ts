import { mkdir, readFile } from "node:fs/promises";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { renderToolHeader } from "../../shared/ui/tool-header.js";
import { PLANS_DIR } from "./guards.js";
import { enterPlanMode, exitPlanMode, isPlanActive } from "./state.js";
import {
	type PlanPresentationDetails,
	presentPlanReview,
	renderPlanPresentationResult,
} from "./ui.js";

function requireContext<T>(ctx: T | undefined): T {
	if (!ctx) {
		throw new Error("Extension context unavailable.");
	}
	return ctx;
}

export const planEnterTool = defineTool({
	name: "plan_mode_enter",
	label: "Enter Plan Mode",
	description: `Enter plan mode — a read-only research and planning phase. You can read files, search, and run safe commands, but only write and edit files in ${PLANS_DIR}/. Use this for complex tasks that need requirements discovery, codebase research, and discussion with the user before implementation.`,
	parameters: Type.Object({}),
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		if (isPlanActive()) {
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
		return renderToolHeader(theme, context.lastComponent, {
			title: "Enter Plan Mode",
		});
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
		if (!isPlanActive()) {
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
		return renderToolHeader(theme, context.lastComponent, {
			title: "Exit Plan Mode",
		});
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
		if (!isPlanActive()) {
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

		const choice = await presentPlanReview(context, params.file_path, content);
		if (choice === "accept") {
			exitPlanMode(context);
			return {
				content: [
					{
						type: "text",
						text: `Plan accepted. Read the plan file at ${params.file_path} and start implementing it now.`,
					},
				],
				details: {
					content,
					action: "accepted",
					filePath: params.file_path,
				} satisfies PlanPresentationDetails,
			};
		}

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
			} satisfies PlanPresentationDetails,
		};
	},
	renderCall(_args, theme, context) {
		return renderToolHeader(theme, context.lastComponent, { title: "Plan" });
	},
	renderResult(result, _options, theme) {
		return renderPlanPresentationResult(
			result.details as PlanPresentationDetails | undefined,
			theme,
		);
	},
});
