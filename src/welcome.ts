import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

const WELCOME_MESSAGE_TYPE = "pi-welcome";
const WELCOME_FALLBACK_TEXT = "Pi coding agent";

type SessionEntryLike = {
	type?: string;
	message?: {
		role?: string;
		customType?: string;
	};
};

function getLogoLines(theme: Theme): string[] {
	const indent = "  ";
	const on = "██";
	const off = "  ";
	const block = (cells: [number, number, number, number]) =>
		theme.fg(
			"text",
			indent + cells.map((cell) => (cell === 1 ? on : off)).join(""),
		);
	const subtitle = `${indent}${theme.fg("muted", theme.bold("Pi coding agent"))}`;

	return [
		block([1, 1, 1, 0]),
		block([1, 0, 1, 0]),
		block([1, 1, 0, 1]),
		block([1, 0, 0, 1]),
		"",
		subtitle,
	];
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
	pi.registerMessageRenderer(
		WELCOME_MESSAGE_TYPE,
		(_message, _options, theme) =>
			new Text(getLogoLines(theme).join("\n"), 0, 0),
	);

	pi.on("session_start", async (event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

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

	pi.on("context", async (event) => ({
		messages: event.messages.filter((message) => {
			const customMessage = message as { customType?: string };
			return customMessage.customType !== WELCOME_MESSAGE_TYPE;
		}),
	}));
}
