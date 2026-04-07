import type { Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

export function getOrCreateText(lastComponent: unknown): Text {
	return lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
}

export function renderToolTitle(
	theme: Theme,
	lastComponent: unknown,
	title: string,
	suffix = "",
): Text {
	const text = getOrCreateText(lastComponent);
	text.setText(theme.fg("toolTitle", theme.bold(title)) + suffix);
	return text;
}
