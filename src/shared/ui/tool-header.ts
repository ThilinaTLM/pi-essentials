import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { type Component, Container, Text } from "@mariozechner/pi-tui";

export interface ToolHeaderOptions {
	title: string;
	arg?: string;
	tag?: {
		text: string;
		tone: Extract<ThemeColor, "warning" | "accent" | "muted">;
	};
}

// Formats a single-line tool header: "Title (arg) [tag]".
// Parens hold a single piece of context (query, URL, agent count, …).
export function formatToolHeader(
	theme: Theme,
	opts: ToolHeaderOptions,
): string {
	const parts = [theme.fg("toolTitle", theme.bold(opts.title))];
	if (opts.arg !== undefined && opts.arg !== "") {
		const open = theme.fg("muted", "(");
		const close = theme.fg("muted", ")");
		const arg = theme.fg("accent", opts.arg);
		parts.push(`${open}${arg}${close}`);
	}
	if (opts.tag) {
		parts.push(theme.fg(opts.tag.tone, `[${opts.tag.text}]`));
	}
	return parts.join(" ");
}

// Builds the standard tool-call frame: a header line followed by an
// always-on thin rule. Used from a tool's `renderCall`. The result body
// is produced separately by `renderResult`, so pi's ToolExecutionComponent
// stacks them as  header / rule / body  inside its state-colored Box.
export function renderToolHeader(
	theme: Theme,
	lastComponent: unknown,
	opts: ToolHeaderOptions,
): Component {
	const header = formatToolHeader(theme, opts);

	// Reuse the existing frame if this renderer has already been invoked
	// once (e.g. streaming updates) so the TUI diff stays cheap.
	if (
		lastComponent instanceof Container &&
		lastComponent.children.length === 2
	) {
		const [textChild] = lastComponent.children;
		if (textChild instanceof Text) {
			textChild.setText(header);
			return lastComponent;
		}
	}

	const container = new Container();
	container.addChild(new Text(header, 0, 0));
	container.addChild(
		new DynamicBorder((s: string) => theme.fg("borderMuted", s)),
	);
	return container;
}
