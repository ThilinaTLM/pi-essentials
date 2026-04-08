import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Container,
	Loader,
	matchesKey,
	Spacer,
	Text,
	type TUI,
} from "@mariozechner/pi-tui";

export type ApprovalResult =
	| { action: "allow" }
	| { action: "reject"; reason?: string };

const MAX_CONTENT_LINES = 20;

export async function showApprovalDialog(
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
): Promise<ApprovalResult> {
	return ctx.ui.custom<ApprovalResult>((tui, theme, _kb, done) => {
		const loader = findLoader(tui);
		if (loader) {
			loader.stop();
			loader.setText("");
		}

		const container = new Container();
		const border = new DynamicBorder((v: string) => theme.fg("accent", v));

		let selected = 0;
		let reasonText = "";
		const optionLines = [
			new Text("", 1, 0),
			new Text("", 1, 0),
			new Text("", 1, 0),
		];

		const updateOptions = () => {
			// Option 1: Allow
			if (selected === 0) {
				optionLines[0].setText(theme.fg("accent", "1. Allow"));
			} else {
				optionLines[0].setText(
					theme.fg("muted", "1. ") + theme.fg("text", "Allow"),
				);
			}

			// Option 2: Reject
			if (selected === 1) {
				optionLines[1].setText(theme.fg("accent", "2. Reject"));
			} else {
				optionLines[1].setText(
					theme.fg("muted", "2. ") + theme.fg("text", "Reject"),
				);
			}

			// Option 3: Reject with reason (inline input)
			if (selected === 2) {
				if (reasonText) {
					optionLines[2].setText(
						theme.fg("accent", "3. ") + theme.fg("text", reasonText),
					);
				} else {
					optionLines[2].setText(theme.fg("accent", "3. Reject with reason"));
				}
			} else {
				if (reasonText) {
					optionLines[2].setText(
						theme.fg("muted", "3. ") + theme.fg("text", reasonText),
					);
				} else {
					optionLines[2].setText(
						theme.fg("muted", "3. ") + theme.fg("text", "Reject with reason"),
					);
				}
			}

			container.invalidate();
		};

		// Build detail lines
		container.addChild(border);
		container.addChild(
			new Text(theme.fg("accent", theme.bold("Approve Tool Call")), 1, 0),
		);
		container.addChild(new Text("", 0, 0));
		container.addChild(new Text(theme.bold(toolName), 1, 0));

		buildToolDetails(container, toolName, input, theme);

		container.addChild(new Text("", 0, 0));
		container.addChild(border);
		for (const line of optionLines) container.addChild(line);
		container.addChild(new Spacer());

		updateOptions();

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				// When option 3 is selected, capture typed text
				if (selected === 2) {
					if (matchesKey(data, "backspace")) {
						reasonText = reasonText.slice(0, -1);
						updateOptions();
						return;
					}
					if (
						data.length === 1 &&
						data >= " " &&
						!matchesKey(data, "enter") &&
						!matchesKey(data, "escape")
					) {
						reasonText += data;
						updateOptions();
						return;
					}
				}

				if (matchesKey(data, "up")) {
					selected = (selected - 1 + 3) % 3;
					updateOptions();
				} else if (matchesKey(data, "down")) {
					selected = (selected + 1) % 3;
					updateOptions();
				} else if (data === "1") {
					done({ action: "allow" });
				} else if (data === "2") {
					done({ action: "reject" });
				} else if (data === "3") {
					selected = 2;
					updateOptions();
				} else if (matchesKey(data, "enter")) {
					if (selected === 0) {
						done({ action: "allow" });
					} else if (selected === 1) {
						done({ action: "reject" });
					} else {
						done({
							action: "reject",
							reason: reasonText || undefined,
						});
					}
				} else if (matchesKey(data, "escape")) {
					done({ action: "reject" });
				}
			},
			dispose: () => {
				if (loader) loader.start();
			},
		};
	});
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
			container.addChild(new Text(theme.fg("muted", `$ ${cmd}`), 1, 0));
			break;
		}
		case "edit": {
			const path = (input.path as string) ?? "unknown file";
			container.addChild(new Text(theme.fg("dim", path), 1, 0));
			const edits = Array.isArray(input.edits)
				? (input.edits as Array<{ oldText: string; newText: string }>)
				: [];
			for (let i = 0; i < edits.length; i++) {
				const edit = edits[i];
				container.addChild(new Text("", 0, 0));
				container.addChild(
					new Text(
						theme.fg("muted", `Edit ${i + 1} of ${edits.length}:`),
						1,
						0,
					),
				);
				for (const line of edit.oldText.split("\n")) {
					container.addChild(
						new Text(theme.fg("toolDiffRemoved", `- ${line}`), 1, 0),
					);
				}
				for (const line of edit.newText.split("\n")) {
					container.addChild(
						new Text(theme.fg("toolDiffAdded", `+ ${line}`), 1, 0),
					);
				}
			}
			break;
		}
		case "write": {
			const path = (input.path as string) ?? "unknown file";
			const content = typeof input.content === "string" ? input.content : "";
			container.addChild(new Text(theme.fg("dim", path), 1, 0));
			container.addChild(new Text("", 0, 0));
			const lines = content.split("\n");
			const shown = lines.slice(0, MAX_CONTENT_LINES);
			for (const line of shown) {
				container.addChild(new Text(theme.fg("muted", line), 1, 0));
			}
			if (lines.length > MAX_CONTENT_LINES) {
				const remaining = lines.length - MAX_CONTENT_LINES;
				container.addChild(
					new Text(theme.fg("dim", `... ${remaining} more lines`), 1, 0),
				);
			}
			break;
		}
		default: {
			container.addChild(new Text("", 0, 0));
			break;
		}
	}
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
