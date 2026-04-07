import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text, visibleWidth } from "@mariozechner/pi-tui";
import { getSettings, loadSettings } from "../../shared/settings.js";

const WELCOME_MESSAGE_TYPE = "pi-welcome";
const WELCOME_FALLBACK_TEXT = "Pi coding agent";

type SessionEntryLike = {
	type?: string;
	message?: {
		role?: string;
		customType?: string;
	};
};

type ModelInfo = {
	current: string;
	explore: string | undefined;
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

function getModelLines(theme: Theme, info: ModelInfo, width: number): string[] {
	const modelLabel = theme.fg("accent", info.current);
	const exploreLabel = info.explore
		? theme.fg("muted", info.explore)
		: undefined;

	const lines = ["", modelLabel, exploreLabel ?? "", ""];

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

function getLogoLines(theme: Theme, info: ModelInfo): string[] {
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
	let modelInfo: ModelInfo = { current: "no-model", explore: undefined };

	function updateModelInfo(
		model: { name?: string; id: string } | undefined,
	): void {
		modelInfo = {
			current: model ? model.name || model.id : "no-model",
			explore: getSettings().exploreModel ?? undefined,
		};
	}

	pi.registerMessageRenderer(
		WELCOME_MESSAGE_TYPE,
		(_message, _options, theme) =>
			new Text(getLogoLines(theme, modelInfo).join("\n"), 0, 0),
	);

	pi.on("session_start", async (event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		await loadSettings();
		updateModelInfo(ctx.model);

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

	pi.on("model_select", async (event) => {
		updateModelInfo(event.model);
	});

	pi.on("context", async (event) => ({
		messages: event.messages.filter((message) => {
			const customMessage = message as { customType?: string };
			return customMessage.customType !== WELCOME_MESSAGE_TYPE;
		}),
	}));
}
