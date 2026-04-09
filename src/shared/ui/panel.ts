import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { type Component, visibleWidth } from "@mariozechner/pi-tui";
import { BOX } from "./chars.js";

export interface PanelSection {
	label?: string;
	content: Component;
}

export interface PanelOptions {
	title: string;
	tone?: Extract<ThemeColor, "border" | "borderAccent" | "borderMuted">;
	sections: PanelSection[];
}

export class Panel implements Component {
	private readonly title: string;
	private readonly tone: ThemeColor;
	private readonly sections: PanelSection[];
	private readonly theme: Theme;

	constructor(theme: Theme, opts: PanelOptions) {
		if (opts.sections.length === 0) {
			throw new Error("Panel requires at least one section.");
		}
		this.theme = theme;
		this.title = opts.title;
		this.tone = opts.tone ?? "border";
		this.sections = opts.sections;
	}

	invalidate(): void {
		for (const section of this.sections) {
			section.content.invalidate?.();
		}
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 4);
		const lines: string[] = [];

		lines.push(this.drawTitledBorder(width, this.title, "top"));

		for (let i = 0; i < this.sections.length; i++) {
			const section = this.sections[i];
			if (i > 0) {
				lines.push(this.drawTitledBorder(width, section.label, "mid"));
			}
			lines.push(this.drawBlankLine(width));
			const childLines = section.content.render(contentWidth);
			for (const childLine of childLines) {
				lines.push(this.drawContentLine(childLine, contentWidth));
			}
			lines.push(this.drawBlankLine(width));
		}

		lines.push(this.drawBottomBorder(width));
		return lines;
	}

	private color(s: string): string {
		return this.theme.fg(this.tone, s);
	}

	private label(text: string): string {
		return this.theme.fg("accent", this.theme.bold(text));
	}

	// Draws a border line with an optional inlined label:
	//   top: ╭─ Title ─────╮
	//   mid: ├─ Label ─────┤  (or ├─────────────┤ when label is missing)
	private drawTitledBorder(
		width: number,
		label: string | undefined,
		kind: "top" | "mid",
	): string {
		const left = kind === "top" ? BOX.tl : BOX.tLeft;
		const right = kind === "top" ? BOX.tr : BOX.tRight;
		const inner = Math.max(0, width - 2);

		if (!label) {
			return this.color(left + BOX.h.repeat(inner) + right);
		}

		// Layout:  ╭─ <label> <fill>╮
		// consumed inside `inner`: 2 (lead "─ ") + labelWidth + 1 (" ") + fill
		const leadWidth = 2;
		const trailWidth = 1;
		const maxLabelWidth = Math.max(0, inner - leadWidth - trailWidth);
		const truncated = truncateLabel(label, maxLabelWidth);
		const labelWidth = visibleWidth(truncated);
		const fill = Math.max(0, inner - leadWidth - labelWidth - trailWidth);
		return (
			this.color(`${left}${BOX.h} `) +
			this.label(truncated) +
			this.color(` ${BOX.h.repeat(fill)}${right}`)
		);
	}

	private drawBottomBorder(width: number): string {
		const inner = Math.max(0, width - 2);
		return this.color(BOX.bl + BOX.h.repeat(inner) + BOX.br);
	}

	private drawBlankLine(width: number): string {
		const inner = Math.max(0, width - 2);
		return this.color(BOX.v) + " ".repeat(inner) + this.color(BOX.v);
	}

	private drawContentLine(line: string, contentWidth: number): string {
		const vis = visibleWidth(line);
		const pad = Math.max(0, contentWidth - vis);
		const v = this.color(BOX.v);
		return `${v} ${line}${" ".repeat(pad)} ${v}`;
	}
}

function truncateLabel(label: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(label) <= maxWidth) return label;
	if (maxWidth <= 1) return label.slice(0, maxWidth);
	// Simple char-based truncation is fine here — labels are short ASCII words.
	return `${label.slice(0, maxWidth - 1)}…`;
}
