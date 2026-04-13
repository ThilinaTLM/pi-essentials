import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Container,
	CURSOR_MARKER,
	Editor,
	type EditorTheme,
	type Focusable,
	matchesKey,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import { Panel } from "../panel.js";
import { showModal } from "./modal.js";
import type { PromptDialogOptions, PromptDialogQuickReply } from "./types.js";

class BorderlessEditor implements Component, Focusable {
	private readonly editor: Editor;
	private readonly placeholder?: string;
	private readonly theme: ExtensionContext["ui"]["theme"];
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		tui: TUI,
		theme: ExtensionContext["ui"]["theme"],
		editorTheme: EditorTheme,
		placeholder?: string,
	) {
		this.theme = theme;
		this.placeholder = placeholder;
		this.editor = new Editor(tui, editorTheme);
	}

	set onSubmit(fn: ((text: string) => void) | undefined) {
		this.editor.onSubmit = fn;
	}

	getText(): string {
		return this.editor.getText();
	}

	handleInput(data: string): void {
		this.editor.handleInput(data);
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	render(width: number): string[] {
		if (this.placeholder && this.editor.getText().length === 0) {
			const marker = this.focused ? CURSOR_MARKER : "";
			const placeholder = truncateToWidth(
				this.placeholder,
				Math.max(0, width - 1),
			);
			return [`${marker}\x1b[7m \x1b[0m${this.theme.fg("dim", placeholder)}`];
		}
		const lines = this.editor.render(width);
		return lines.length >= 2 ? lines.slice(1, -1) : lines;
	}
}

class PromptDialog implements Component, Focusable {
	private readonly panel: Panel;
	private readonly editor: BorderlessEditor;
	private readonly done: (result: string | null) => void;
	private readonly quickReplies: PromptDialogQuickReply[];
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		tui: TUI,
		theme: ExtensionContext["ui"]["theme"],
		opts: PromptDialogOptions,
		done: (result: string | null) => void,
	) {
		this.done = done;
		this.quickReplies = opts.quickReplies ?? [];
		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("borderMuted", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		this.editor = new BorderlessEditor(
			tui,
			theme,
			editorTheme,
			opts.placeholder,
		);
		this.editor.onSubmit = (text) => {
			if (text.trim()) {
				this.done(text.trimEnd());
			}
		};

		const replyContent = new Container();
		replyContent.addChild(this.editor);
		if (this.quickReplies.length > 0) {
			replyContent.addChild(new Spacer(1));
			replyContent.addChild(
				new Text(
					theme.fg(
						"dim",
						`Actions: ${this.quickReplies
							.map((reply, index) => `${index + 1}. ${reply.label}`)
							.join(", ")}`,
					),
					0,
					0,
				),
			);
		}

		const body = new Container();
		body.addChild(opts.content);
		body.addChild(new Spacer(1));
		body.addChild(replyContent);

		this.panel = new Panel(theme, {
			title: opts.title,
			tone: opts.tone,
			sections: [{ content: body }],
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}
		if (/^[1-9]$/.test(data) && this.editor.getText().length === 0) {
			const index = Number.parseInt(data, 10) - 1;
			const reply = this.quickReplies[index];
			if (reply) {
				this.done(reply.value);
				return;
			}
		}
		this.editor.handleInput(data);
		this.panel.invalidate();
	}

	invalidate(): void {
		this.panel.invalidate();
	}

	render(width: number): string[] {
		return this.panel.render(width);
	}
}

export async function showPromptDialog(
	ctx: ExtensionContext,
	opts: PromptDialogOptions,
): Promise<string | null> {
	return showModal(
		ctx,
		(tui, theme, done) => new PromptDialog(tui, theme, opts, done),
	);
}
