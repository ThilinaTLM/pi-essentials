import { homedir } from "node:os";
import { sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ThemeColor,
} from "@mariozechner/pi-coding-agent";
import { prettyModelLabel } from "../../shared/ui/model.js";

const BRANCH_GLYPH = "";

const CONTEXT_GLYPH = "󰍛";

export const LEFT_SEP = " │ ";
export const RIGHT_SEP = "  ";

export type ThemeLike = ExtensionContext["ui"]["theme"];

export type FooterSegment = {
	key: string;
	text: string;
	required?: boolean;
};

export type AggregatedUsage = {
	totalTokens: number;
	totalCost: number;
};

export function shortenCwd(cwd: string): string {
	const home = homedir();
	const inHome = cwd === home || cwd.startsWith(home + sep);
	const display = inHome ? `~${cwd.slice(home.length)}` || "~" : cwd;

	if (display === "~" || display === "/") {
		return display;
	}

	const isAbsolute = display.startsWith(sep);
	const parts = display.split(sep).filter(Boolean);
	if (parts.length === 0) {
		return display;
	}

	const head = display.startsWith("~") ? "~" : isAbsolute ? sep : "";
	const shortened = parts.map((part, index) => {
		const isLast = index === parts.length - 1;
		if (index === 0 && part === "~") {
			return part;
		}
		return isLast ? part : (part[0] ?? part);
	});

	if (head === "~") {
		return `~/${shortened.slice(1).join(sep)}`;
	}
	if (head === sep) {
		return `${sep}${shortened.join(sep)}`;
	}
	return shortened.join(sep);
}

export function formatCompactNumber(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
	}
	return `${Math.round(value)}`;
}

export function formatCostValue(cost: number): string {
	if (cost === 0) {
		return "$0.00";
	}
	if (cost >= 0.01) {
		return `$${cost.toFixed(2)}`;
	}
	return `$${cost.toFixed(3)}`;
}

export function joinSegments(
	theme: ThemeLike,
	segments: string[],
	separator: string = LEFT_SEP,
): string {
	const items = segments.filter((segment) => segment.length > 0);
	if (items.length <= 1) return items.join("");
	return items.join(theme.fg("dim", separator));
}

export function aggregateUsage(ctx: ExtensionContext): AggregatedUsage {
	let totalTokens = 0;
	let totalCost = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}

		totalTokens += entry.message.usage.totalTokens;
		totalCost += entry.message.usage.cost.total;
	}

	return { totalTokens, totalCost };
}

export function formatContext(theme: ThemeLike, ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const percent = usage?.percent;
	const text =
		percent == null
			? `${CONTEXT_GLYPH} --`
			: `${CONTEXT_GLYPH} ${Math.round(percent)}%`;

	if (percent == null) {
		return theme.fg("dim", text);
	}
	if (percent >= 80) {
		return theme.fg("error", text);
	}
	if (percent >= 60) {
		return theme.fg("warning", text);
	}
	return theme.fg("muted", text);
}

export function formatTokenCount(
	theme: ThemeLike,
	usage: AggregatedUsage,
): string | null {
	if (usage.totalTokens <= 0) {
		return null;
	}
	return theme.fg("dim", `${formatCompactNumber(usage.totalTokens)} tok`);
}

export function formatCost(theme: ThemeLike, usage: AggregatedUsage): string {
	return theme.fg("dim", formatCostValue(usage.totalCost));
}

export function formatModelWithThinking(
	theme: ThemeLike,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): string {
	const model = theme.fg("accent", prettyModelLabel(ctx.model));
	const level = pi.getThinkingLevel();
	if (level === "off") {
		return model;
	}

	const token: ThemeColor =
		level === "minimal"
			? "thinkingMinimal"
			: level === "low"
				? "thinkingLow"
				: level === "medium"
					? "thinkingMedium"
					: level === "high"
						? "thinkingHigh"
						: "thinkingXhigh";

	const thinking = theme.fg(token, `(${titleCaseThinking(level)})`);
	return `${model} ${thinking}`;
}

function titleCaseThinking(level: string): string {
	if (level === "xhigh") return "XHigh";
	return level.charAt(0).toUpperCase() + level.slice(1);
}

export function formatBranch(
	theme: ThemeLike,
	branch: string | null,
	dirty: boolean,
): string | null {
	if (!branch) {
		return null;
	}

	const branchText = theme.fg("accent", `${BRANCH_GLYPH} ${branch}`);
	const dirtyText = dirty ? theme.fg("warning", "*") : "";
	return branchText + dirtyText;
}
