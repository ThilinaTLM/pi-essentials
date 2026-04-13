import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { showDialog } from "../../shared/ui/dialog/index.js";
import { formatToolHeader } from "../../shared/ui/tool-header.js";

export type ApprovalResult =
	| { action: "allow" }
	| { action: "reject"; reason?: string };

type Choice = "allow" | "reject" | "reject_with_reason";

const MAX_CONTENT_LINES = 20;

export async function showApprovalDialog(
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
): Promise<ApprovalResult> {
	const theme = ctx.ui.theme;
	const body = new Container();
	body.addChild(
		new Text(
			formatToolHeader(theme, {
				title: capitalize(toolName),
				arg: getToolArg(toolName, input),
			}),
			0,
			0,
		),
	);
	buildExtraDetails(body, toolName, input, theme);

	const result = await showDialog<Choice>(ctx, {
		title: "Confirmation",
		sections: [
			{ content: body },
			{
				options: [
					{ id: "allow", label: "Allow" },
					{ id: "reject", label: "Reject" },
					{
						id: "reject_with_reason",
						label: "Reject with reason",
						captureInput: { placeholder: "Type reason here" },
					},
				],
			},
		],
	});

	if (!result) return { action: "reject" };
	if (result.id === "allow") return { action: "allow" };
	if (result.id === "reject_with_reason") {
		return { action: "reject", reason: result.input };
	}
	return { action: "reject" };
}

function capitalize(name: string): string {
	if (!name) return name;
	return name[0].toUpperCase() + name.slice(1);
}

function getToolArg(
	toolName: string,
	input: Record<string, unknown>,
): string | undefined {
	switch (toolName) {
		case "bash":
			return typeof input.command === "string" ? input.command : undefined;
		case "edit":
		case "write":
			return typeof input.path === "string" ? input.path : "unknown file";
		default:
			return undefined;
	}
}

function buildExtraDetails(
	container: Container,
	toolName: string,
	input: Record<string, unknown>,
	theme: Theme,
): void {
	switch (toolName) {
		case "edit": {
			const edits = Array.isArray(input.edits)
				? (input.edits as Array<{ oldText: string; newText: string }>)
				: [];
			for (let i = 0; i < edits.length; i++) {
				const edit = edits[i];
				container.addChild(new Text("", 0, 0));
				container.addChild(
					new Text(
						theme.fg("muted", `Edit ${i + 1} of ${edits.length}:`),
						0,
						0,
					),
				);
				for (const line of edit.oldText.split("\n")) {
					container.addChild(
						new Text(theme.fg("toolDiffRemoved", `- ${line}`), 0, 0),
					);
				}
				for (const line of edit.newText.split("\n")) {
					container.addChild(
						new Text(theme.fg("toolDiffAdded", `+ ${line}`), 0, 0),
					);
				}
			}
			break;
		}
		case "write": {
			const content = typeof input.content === "string" ? input.content : "";
			container.addChild(new Text("", 0, 0));
			const lines = content.split("\n");
			const shown = lines.slice(0, MAX_CONTENT_LINES);
			for (const line of shown) {
				container.addChild(new Text(theme.fg("muted", line), 0, 0));
			}
			if (lines.length > MAX_CONTENT_LINES) {
				const remaining = lines.length - MAX_CONTENT_LINES;
				container.addChild(
					new Text(theme.fg("dim", `... ${remaining} more lines`), 0, 0),
				);
			}
			break;
		}
	}
}
