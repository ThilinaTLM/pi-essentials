import type { ThemeColor } from "@mariozechner/pi-coding-agent";

// Palette rules — single source of truth for which theme token to reach for.
//
// - ACCENT:       primary action, focused item, interactive highlight
// - TEXT:         default body copy
// - MUTED:        labels, secondary metadata, soft separators
// - DIM:          tertiary info — file paths, URLs, tree gutters
// - BORDER_MUTED: horizontal rules, dot separators, dividers
// - TOOL_TITLE:   tool names in headers
// - SUCCESS/WARNING/ERROR: state only, never decoration.

export const ACCENT: ThemeColor = "accent";
export const TEXT: ThemeColor = "text";
export const MUTED: ThemeColor = "muted";
export const DIM: ThemeColor = "dim";
export const BORDER: ThemeColor = "border";
export const BORDER_ACCENT: ThemeColor = "borderAccent";
export const BORDER_MUTED: ThemeColor = "borderMuted";
export const TOOL_TITLE: ThemeColor = "toolTitle";
export const SUCCESS: ThemeColor = "success";
export const WARNING: ThemeColor = "warning";
export const ERROR: ThemeColor = "error";

export const SEP = " · ";
