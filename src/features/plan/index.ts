import { mkdir } from "node:fs/promises";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getPlanModeToolBlock, PLANS_DIR } from "./guards.js";
import { buildPlanModeSystemPrompt } from "./prompt.js";
import {
	enterPlanMode,
	exitPlanMode,
	initializePlanState,
	isPlanActive,
	PLAN_MODE_STATE_ENTRY,
	restorePlanMode,
} from "./state.js";
import { planEnterTool, planForceExitTool, planPresentTool } from "./tools.js";

export function registerPlan(pi: ExtensionAPI) {
	initializePlanState(pi);

	pi.registerTool(planEnterTool);
	pi.registerTool(planForceExitTool);
	pi.registerTool(planPresentTool);

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const planModeEntry = [...entries]
			.reverse()
			.find(
				(entry) =>
					entry.type === "custom" && entry.customType === PLAN_MODE_STATE_ENTRY,
			) as { data?: { active?: boolean } } | undefined;

		restorePlanMode(ctx, planModeEntry?.data?.active === true);
	});

	const togglePlanMode = async (ctx: ExtensionContext) => {
		if (isPlanActive()) {
			exitPlanMode(ctx);
			ctx.ui.notify("Plan mode exited. Full access restored.", "info");
			return;
		}

		await mkdir(PLANS_DIR, { recursive: true });
		enterPlanMode(ctx);
		ctx.ui.notify("Plan mode active.", "info");
	};

	pi.registerCommand("plan", {
		description: "Toggle plan mode",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerShortcut("ctrl+alt+p", {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	pi.on("tool_call", async (event) => {
		if (!isPlanActive()) return;
		return getPlanModeToolBlock({
			toolName: event.toolName,
			input: event.input as {
				command?: unknown;
				path?: unknown;
				file_path?: unknown;
			},
		});
	});

	pi.on("before_agent_start", async (event) => {
		if (!isPlanActive()) return;
		return {
			systemPrompt: buildPlanModeSystemPrompt(event.systemPrompt),
		};
	});
}
