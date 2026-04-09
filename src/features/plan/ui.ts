import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Text } from "@mariozechner/pi-tui";
import { showDialog } from "../../shared/ui/dialog.js";

export interface PlanPresentationDetails {
	content: string;
	action: "accepted" | "changes_requested";
	filePath: string;
}

export type PlanReviewChoice = "accept" | "changes";

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
	filePath: string,
	content: string,
): Promise<PlanReviewChoice | null> {
	const theme = ctx.ui.theme;
	const body = new Container();
	body.addChild(new Text(theme.fg("dim", filePath), 0, 0));
	body.addChild(new Text("", 0, 0));
	body.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));

	const result = await showDialog<PlanReviewChoice>(ctx, {
		title: "Plan",
		sections: [
			{ content: body },
			{
				options: [
					{ id: "accept", label: "Accept & Execute" },
					{ id: "changes", label: "Request Changes" },
				],
			},
		],
	});
	return result?.id ?? null;
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
