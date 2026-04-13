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
import { Panel, type PanelSection } from "../panel.js";
import { showModal } from "./modal.js";
import type {
	DialogOption,
	DialogOptions,
	DialogResult,
	DialogSection,
} from "./types.js";

type Slot<T> = {
	option: DialogOption<T>;
	line: Text;
	buffer: string;
};

class OptionsDialog<T> implements Component {
	private readonly panel: Panel;
	private readonly theme: ExtensionContext["ui"]["theme"];
	private readonly done: (result: DialogResult<T> | null) => void;
	private readonly slots: Slot<T>[] = [];
	private readonly digitShortcutsEnabled: boolean;
	private selected = 0;

	constructor(
		theme: ExtensionContext["ui"]["theme"],
		opts: DialogOptions<T>,
		done: (result: DialogResult<T> | null) => void,
	) {
		this.theme = theme;
		this.done = done;

		this.panel = new Panel(theme, {
			title: opts.title,
			tone: opts.tone,
			sections: opts.sections.map((section) => this.createSection(section)),
		});
		this.digitShortcutsEnabled = this.slots.length <= 9;
		this.refresh();
	}

	handleInput(data: string): void {
		const activeSlot = this.slots[this.selected];
		const capturing = activeSlot?.option.captureInput !== undefined;

		if (capturing) {
			if (matchesKey(data, "backspace")) {
				activeSlot.buffer = activeSlot.buffer.slice(0, -1);
				this.refresh();
				return;
			}
			if (
				data.length === 1 &&
				data >= " " &&
				!matchesKey(data, "enter") &&
				!matchesKey(data, "escape")
			) {
				activeSlot.buffer += data;
				this.refresh();
				return;
			}
		}

		if (matchesKey(data, "up")) {
			if (this.slots.length === 0) return;
			this.selected =
				(this.selected - 1 + this.slots.length) % this.slots.length;
			this.refresh();
			return;
		}
		if (matchesKey(data, "down")) {
			if (this.slots.length === 0) return;
			this.selected = (this.selected + 1) % this.slots.length;
			this.refresh();
			return;
		}
		if (matchesKey(data, "enter")) {
			this.resolveSelected();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}
		if (this.digitShortcutsEnabled && /^[1-9]$/.test(data)) {
			const index = Number.parseInt(data, 10) - 1;
			if (index < this.slots.length) {
				this.selected = index;
				this.refresh();
				if (!this.slots[index].option.captureInput) {
					this.resolveSelected();
				}
			}
		}
	}

	invalidate(): void {
		this.panel.invalidate();
	}

	render(width: number): string[] {
		return this.panel.render(width);
	}

	private createSection(section: DialogSection<T>): PanelSection {
		if (section.options && section.options.length > 0) {
			const container = new Container();
			for (const option of section.options) {
				const line = new Text("", 0, 0);
				container.addChild(line);
				this.slots.push({ option, line, buffer: "" });
			}
			return { label: section.label, content: container };
		}

		return {
			label: section.label,
			content: section.content ?? new Text("", 0, 0),
		};
	}

	private refresh(): void {
		for (let i = 0; i < this.slots.length; i++) {
			this.slots[i].line.setText(this.renderSlot(this.slots[i], i));
		}
		this.panel.invalidate();
	}

	private resolveSelected(): void {
		const slot = this.slots[this.selected];
		if (!slot) return;
		const result: DialogResult<T> = { id: slot.option.id };
		if (slot.option.captureInput && slot.buffer) {
			result.input = slot.buffer;
		}
		this.done(result);
	}

	private renderSlot(slot: Slot<T>, index: number): string {
		const number = `${index + 1}.`;
		const active = index === this.selected;
		const capturing = active && slot.option.captureInput !== undefined;
		const numColor: ThemeColor = active ? "warning" : "muted";
		const labelColor: ThemeColor = active ? "warning" : "text";
		const num = this.theme.fg(numColor, number);

		if (capturing) {
			if (slot.buffer) {
				return `${num} ${this.theme.fg("text", slot.buffer)}`;
			}
			const hint = slot.option.captureInput?.placeholder ?? slot.option.label;
			return `${num} ${this.theme.fg("dim", hint)}`;
		}

		return `${num} ${this.theme.fg(labelColor, slot.option.label)}`;
	}
}

export async function showDialog<T>(
	ctx: ExtensionContext,
	opts: DialogOptions<T>,
): Promise<DialogResult<T> | null> {
	return showModal(
		ctx,
		(_tui, theme, done) => new OptionsDialog(theme, opts, done),
	);
}
