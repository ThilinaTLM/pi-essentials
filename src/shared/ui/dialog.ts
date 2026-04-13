import type {
	ExtensionContext,
	ThemeColor,
} from "@mariozechner/pi-coding-agent";
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
import { pauseLoader } from "./modal-chrome.js";
import { Panel, type PanelSection } from "./panel.js";

export interface DialogOption<T> {
	id: T;
	label: string;
	captureInput?: { placeholder?: string };
}

export interface DialogSection<T> {
	label?: string;
	content?: Component;
	options?: DialogOption<T>[];
}

export interface DialogOptions<T> {
	title: string;
	tone?: Extract<ThemeColor, "border" | "borderAccent" | "borderMuted">;
	sections: DialogSection<T>[];
}

export interface DialogResult<T> {
	id: T;
	input?: string;
}

export interface PromptDialogQuickReply {
	label: string;
	value: string;
}

export interface PromptDialogOptions {
	title: string;
	tone?: Extract<ThemeColor, "border" | "borderAccent" | "borderMuted">;
	content: Component;
	inputLabel?: string;
	placeholder?: string;
	quickReplies?: PromptDialogQuickReply[];
}

// Unified modal dialog. Builds a Panel from the given sections — for any
// section with `options`, renders a numbered list and wires keyboard
// selection + digit shortcuts. Pauses any running loader while the dialog
// is on screen.
export async function showDialog<T>(
	ctx: ExtensionContext,
	opts: DialogOptions<T>,
): Promise<DialogResult<T> | null> {
	return ctx.ui.custom<DialogResult<T> | null>((tui, theme, _kb, done) => {
		const resumeLoader = pauseLoader(tui);

		// Collect every option across every options-section into a single list,
		// with pointers back into the per-section Text lines we render.
		type Slot = {
			option: DialogOption<T>;
			line: Text;
			buffer: string;
		};
		const slots: Slot[] = [];

		const panelSections: PanelSection[] = opts.sections.map((section) => {
			if (section.options && section.options.length > 0) {
				const container = new Container();
				for (const option of section.options) {
					const line = new Text("", 0, 0);
					container.addChild(line);
					slots.push({ option, line, buffer: "" });
				}
				return { label: section.label, content: container };
			}
			const content = section.content ?? new Text("", 0, 0);
			return { label: section.label, content };
		});

		let selected = 0;
		const digitShortcutsEnabled = slots.length <= 9;

		const panel = new Panel(theme, {
			title: opts.title,
			tone: opts.tone,
			sections: panelSections,
		});

		const renderSlot = (slot: Slot, index: number): string => {
			const number = `${index + 1}.`;
			const active = index === selected;
			const capturing = active && slot.option.captureInput !== undefined;
			const numColor: ThemeColor = active ? "warning" : "muted";
			const labelColor: ThemeColor = active ? "warning" : "text";
			const num = theme.fg(numColor, number);

			if (capturing) {
				if (slot.buffer) {
					return `${num} ${theme.fg("text", slot.buffer)}`;
				}
				const hint = slot.option.captureInput?.placeholder ?? slot.option.label;
				return `${num} ${theme.fg("dim", hint)}`;
			}
			return `${num} ${theme.fg(labelColor, slot.option.label)}`;
		};

		const refresh = () => {
			for (let i = 0; i < slots.length; i++) {
				slots[i].line.setText(renderSlot(slots[i], i));
			}
			panel.invalidate();
		};

		refresh();

		const resolveSelected = () => {
			const slot = slots[selected];
			if (!slot) return;
			const result: DialogResult<T> = { id: slot.option.id };
			if (slot.option.captureInput && slot.buffer) {
				result.input = slot.buffer;
			}
			done(result);
		};

		return {
			render: (width: number) => panel.render(width),
			invalidate: () => panel.invalidate(),
			handleInput: (data: string) => {
				const activeSlot = slots[selected];
				const capturing = activeSlot?.option.captureInput !== undefined;

				if (capturing) {
					if (matchesKey(data, "backspace")) {
						activeSlot.buffer = activeSlot.buffer.slice(0, -1);
						refresh();
						return;
					}
					if (
						data.length === 1 &&
						data >= " " &&
						!matchesKey(data, "enter") &&
						!matchesKey(data, "escape")
					) {
						activeSlot.buffer += data;
						refresh();
						return;
					}
				}

				if (matchesKey(data, "up")) {
					if (slots.length === 0) return;
					selected = (selected - 1 + slots.length) % slots.length;
					refresh();
					return;
				}
				if (matchesKey(data, "down")) {
					if (slots.length === 0) return;
					selected = (selected + 1) % slots.length;
					refresh();
					return;
				}
				if (matchesKey(data, "enter")) {
					resolveSelected();
					return;
				}
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
					done(null);
					return;
				}
				if (digitShortcutsEnabled && /^[1-9]$/.test(data)) {
					const index = Number.parseInt(data, 10) - 1;
					if (index < slots.length) {
						selected = index;
						refresh();
						if (!slots[index].option.captureInput) {
							resolveSelected();
						}
					}
				}
			},
			dispose: () => resumeLoader(),
		};
	});
}

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
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const resumeLoader = pauseLoader(tui);
		const dialog = new PromptDialog(tui, theme, opts, done);
		return {
			render: (width: number) => dialog.render(width),
			invalidate: () => dialog.invalidate(),
			handleInput: (data: string) => dialog.handleInput(data),
			get focused() {
				return dialog.focused;
			},
			set focused(value: boolean) {
				dialog.focused = value;
			},
			dispose: () => resumeLoader(),
		};
	});
}
