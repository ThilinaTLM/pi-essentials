import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { showDialog } from "../../shared/ui/dialog.js";

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
	body.addChild(new Text(theme.bold(toolName), 0, 0));
	buildToolDetails(body, toolName, input, theme);

	const result = await showDialog<Choice>(ctx, {
		title: "Confirmation",
		sections: [
			{ content: body },
			{
				label: "Decision",
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

function buildToolDetails(
	container: Container,
	toolName: string,
	input: Record<string, unknown>,
	theme: ExtensionContext["ui"]["theme"],
): void {
	switch (toolName) {
		case "bash": {
			const cmd = typeof input.command === "string" ? input.command : "";
			container.addChild(new Text("", 0, 0));
			container.addChild(new Text(theme.fg("muted", `$ ${cmd}`), 0, 0));
			break;
		}
		case "edit": {
			const path = (input.path as string) ?? "unknown file";
			container.addChild(new Text(theme.fg("dim", path), 0, 0));
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
			const path = (input.path as string) ?? "unknown file";
			const content = typeof input.content === "string" ? input.content : "";
			container.addChild(new Text(theme.fg("dim", path), 0, 0));
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
