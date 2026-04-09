import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";

export type StatusKind = "ok" | "fail" | "pending" | "active" | "idle" | "info";

interface StatusSpec {
	glyph: string;
	color: ThemeColor;
}

const STATUS: Record<StatusKind, StatusSpec> = {
	ok: { glyph: "✓", color: "success" },
	fail: { glyph: "✗", color: "error" },
	pending: { glyph: "●", color: "warning" },
	active: { glyph: "●", color: "accent" },
	idle: { glyph: "○", color: "muted" },
	info: { glyph: "ℹ", color: "muted" },
};

export function statusGlyph(theme: Theme, kind: StatusKind): string {
	const spec = STATUS[kind];
	return theme.fg(spec.color, spec.glyph);
}

export function statusPill(
	theme: Theme,
	kind: StatusKind,
	label: string,
): string {
	const spec = STATUS[kind];
	return theme.fg(spec.color, `${spec.glyph} ${label}`);
}
