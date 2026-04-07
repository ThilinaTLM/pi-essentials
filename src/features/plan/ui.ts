import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
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

export interface PlanPresentationDetails {
	content: string;
	action: "accepted" | "changes_requested";
	filePath: string;
}

export function setPlanModeWidget(
	ctx: ExtensionContext,
	active: boolean,
): void {
	if (!active) {
		ctx.ui.setWidget("plan-mode", undefined);
		return;
	}

	ctx.ui.setWidget("plan-mode", (_tui, theme) => ({
		render: () => [theme.fg("warning", theme.bold("PLAN MODE"))],
		invalidate: () => {},
	}));
}

export async function presentPlanReview(
	ctx: ExtensionContext,
	content: string,
): Promise<"Accept & Execute" | "Request Changes" | null> {
	const options = ["Accept & Execute", "Request Changes"] as const;
	type Choice = (typeof options)[number];

	return ctx.ui.custom<Choice | null>((tui, theme, _kb, done) => {
		const loader = findLoader(tui);
		if (loader) {
			loader.stop();
			loader.setText("");
		}

		const container = new Container();
		const border = new DynamicBorder((value: string) =>
			theme.fg("accent", value),
		);
		const mdTheme = getMarkdownTheme();
		let selected = 0;
		const optionLines = options.map(() => new Text("", 1, 0));

		const updateOptions = () => {
			for (let i = 0; i < options.length; i++) {
				const num = `${i + 1}.`;
				if (i === selected) {
					optionLines[i].setText(theme.fg("accent", `${num} ${options[i]}`));
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
				if (loader) loader.start();
			},
		};
	});
}

export function renderPlanPresentationResult(
	details: PlanPresentationDetails | undefined,
	theme: ExtensionContext["ui"]["theme"],
): Container | Text {
	if (!details) return new Text("", 0, 0);

	const container = new Container();
	const mdTheme = getMarkdownTheme();

	container.addChild(new Markdown(details.content, 1, 1, mdTheme));
	container.addChild(new Text("", 0, 0));

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
}

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
