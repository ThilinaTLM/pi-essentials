import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { setFooterLeftItem } from "../../shared/footer-left.js";
import { loadSettings, saveSettings } from "../../shared/settings.js";
import { isMutatingTool, summarizeToolCall } from "./classify.js";
import { showApprovalDialog } from "./ui.js";

export type PermissionLevel = "auto" | "supervised";

let currentLevel: PermissionLevel = "auto";

export function getPermissionLevel(): PermissionLevel {
	return currentLevel;
}

export function registerPermissions(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event) => {
		const settings = await loadSettings();
		currentLevel = settings.permissionLevel ?? "auto";
		updateStatus();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (currentLevel !== "supervised") return;
		if (!isMutatingTool(event.toolName)) return;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason:
					"Blocked: supervised permission level requires interactive UI for approval",
			};
		}

		const result = await showApprovalDialog(
			ctx,
			event.toolName,
			event.input as Record<string, unknown>,
		);

		if (result.action === "reject") {
			const summary = summarizeToolCall(
				event.toolName,
				event.input as Record<string, unknown>,
			);
			const parts = [`User rejected: ${summary}`];
			if (result.reason) parts.push(`Reason: ${result.reason}`);
			return { block: true, reason: parts.join("\n") };
		}
	});

	pi.registerCommand("permissions", {
		description: "Toggle permission level (auto / supervised)",
		handler: async (_args, ctx) => {
			const next: PermissionLevel =
				currentLevel === "auto" ? "supervised" : "auto";
			await setLevel(next, ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+o", {
		description: "Toggle permission level",
		handler: async (ctx) => {
			const next: PermissionLevel =
				currentLevel === "auto" ? "supervised" : "auto";
			await setLevel(next, ctx);
		},
	});
}

async function setLevel(
	level: PermissionLevel,
	ctx: ExtensionContext,
): Promise<void> {
	currentLevel = level;

	const settings = await loadSettings();
	settings.permissionLevel = level;
	await saveSettings(settings);

	updateStatus();
	const label = level === "supervised" ? "🔒 Supervised" : "🔓 Auto";
	ctx.ui.notify(`Permission level: ${label}`, "info");
}

function updateStatus(): void {
	if (currentLevel === "supervised") {
		setFooterLeftItem("permissions", "🔒");
	} else {
		setFooterLeftItem("permissions", undefined);
	}
}
