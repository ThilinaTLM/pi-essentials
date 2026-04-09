import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text, visibleWidth } from "@mariozechner/pi-tui";
import { getSettings, loadSettings } from "../../shared/settings.js";
import { formatModelLabel } from "../../shared/ui/model.js";
import { statusGlyph } from "../../shared/ui/status.js";
import {
	getPermissionLevel,
	type PermissionLevel,
} from "../permissions/index.js";

const WELCOME_MESSAGE_TYPE = "pi-welcome";
const WELCOME_FALLBACK_TEXT = "Pi coding agent";

type SessionEntryLike = {
	type?: string;
	message?: {
		role?: string;
		customType?: string;
	};
};

type WelcomeInfo = {
	current: string;
	explore: string | undefined;
	permissionLevel: PermissionLevel;
};

type ModelLookup = {
	find(provider: string, id: string): { name?: string; id: string } | undefined;
};

function getLogoColumns(theme: Theme): string[] {
	const on = "██";
	const off = "  ";
	const block = (cells: [number, number, number, number]) =>
		theme.fg("text", cells.map((cell) => (cell === 1 ? on : off)).join(""));

	return [
		block([1, 1, 1, 0]),
		block([1, 0, 1, 0]),
		block([1, 1, 0, 1]),
		block([1, 0, 0, 1]),
	];
}

function getModelLines(
	theme: Theme,
	info: WelcomeInfo,
	width: number,
): string[] {
	const heavy = `${statusGlyph(theme, "active")} ${theme.fg("accent", info.current)}`;
	const lite = info.explore
		? `${statusGlyph(theme, "idle")} ${theme.fg("muted", info.explore)}`
		: "";
	const perm =
		info.permissionLevel === "supervised"
			? `${statusGlyph(theme, "idle")} ${theme.fg("muted", "Supervised")}`
			: `${statusGlyph(theme, "active")} ${theme.fg("accent", "Auto")}`;

	const lines = [heavy, lite, "", perm];

	const maxWidth = lines.reduce(
		(max, line) => Math.max(max, visibleWidth(line)),
		0,
	);
	const padWidth = Math.min(maxWidth, width);

	return lines.map((line) => {
		const pad = padWidth - visibleWidth(line);
		return pad > 0 ? line + " ".repeat(pad) : line;
	});
}

function getLogoLines(theme: Theme, info: WelcomeInfo): string[] {
	const indent = "  ";
	const gap = "   ";
	const logo = getLogoColumns(theme);
	const models = getModelLines(theme, info, 30);
	const subtitle = theme.fg("muted", theme.bold("Pi coding agent"));

	const combined = logo.map((logoLine, i) => {
		const modelLine = models[i] ?? "";
		return `${indent}${logoLine}${gap}${modelLine}`;
	});

	return [...combined, "", `${indent}${subtitle}`];
}

function hasWelcomeMessage(entries: SessionEntryLike[]): boolean {
	return entries.some(
		(entry) =>
			entry.type === "message" &&
			entry.message?.role === "custom" &&
			entry.message.customType === WELCOME_MESSAGE_TYPE,
	);
}

function hasConversationMessages(entries: SessionEntryLike[]): boolean {
	return entries.some((entry) => entry.type === "message");
}

function shouldShowWelcome(
	reason: string,
	entries: SessionEntryLike[],
): boolean {
	if (hasConversationMessages(entries)) {
		return false;
	}
	return reason === "startup" || reason === "new";
}

export function registerWelcome(pi: ExtensionAPI): void {
	let info: WelcomeInfo = {
		current: "no-model",
		explore: undefined,
		permissionLevel: "auto",
	};

	function resolveModelId(
		modelId: string | undefined,
		registry?: ModelLookup,
	): string | undefined {
		if (!modelId) return undefined;
		if (!registry) return modelId;
		const [provider, id] = modelId.split("/", 2);
		if (!provider || !id) return modelId;
		const resolved = registry.find(provider, id);
		return resolved ? formatModelLabel(resolved) : modelId;
	}

	function updateInfo(
		model: { name?: string; id: string } | undefined,
		registry?: ModelLookup,
	): void {
		info = {
			current: formatModelLabel(model),
			explore: resolveModelId(getSettings().exploreModel, registry),
			permissionLevel: getPermissionLevel(),
		};
	}

	pi.registerMessageRenderer(
		WELCOME_MESSAGE_TYPE,
		(_message, _options, theme) =>
			new Text(getLogoLines(theme, info).join("\n"), 0, 0),
	);

	pi.on("session_start", async (event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		await loadSettings();
		updateInfo(ctx.model, ctx.modelRegistry);

		const entries = ctx.sessionManager.getEntries() as SessionEntryLike[];
		if (!shouldShowWelcome(event.reason, entries)) {
			return;
		}
		if (hasWelcomeMessage(entries)) {
			return;
		}

		pi.sendMessage(
			{
				customType: WELCOME_MESSAGE_TYPE,
				content: WELCOME_FALLBACK_TEXT,
				display: true,
				details: { variant: "logo", createdAt: Date.now() },
			},
			{ triggerTurn: false },
		);
	});

	pi.on("model_select", async (event, ctx) => {
		updateInfo(event.model, ctx.modelRegistry);
	});

	pi.on("context", async (event) => ({
		messages: event.messages.filter((message) => {
			const customMessage = message as { customType?: string };
			return customMessage.customType !== WELCOME_MESSAGE_TYPE;
		}),
	}));
}
