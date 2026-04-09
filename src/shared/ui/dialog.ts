import type {
	ExtensionContext,
	ThemeColor,
} from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Container,
	matchesKey,
	Text,
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
			const numColor = active ? "accent" : "muted";
			const labelColor: ThemeColor = active ? "accent" : "text";

			let label = slot.option.label;
			if (capturing) {
				if (slot.buffer) {
					label = `${slot.option.label}: ${slot.buffer}`;
				} else if (slot.option.captureInput?.placeholder) {
					label = `${slot.option.label}: ${slot.option.captureInput.placeholder}`;
				} else {
					label = `${slot.option.label}:`;
				}
			}
			return `${theme.fg(numColor, number)} ${theme.fg(labelColor, label)}`;
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
				if (matchesKey(data, "escape")) {
					done(null);
					return;
				}
				if (digitShortcutsEnabled && /^[1-9]$/.test(data)) {
					const index = Number.parseInt(data, 10) - 1;
					if (index < slots.length) {
						selected = index;
						refresh();
						resolveSelected();
					}
				}
			},
			dispose: () => resumeLoader(),
		};
	});
}
