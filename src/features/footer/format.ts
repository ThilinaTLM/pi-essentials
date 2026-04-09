import { homedir } from "node:os";
import { sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { formatModelLabel } from "../../shared/ui/model.js";
import { SEP } from "../../shared/ui/palette.js";

const BRANCH_GLYPH = "";

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

export function joinSegments(theme: ThemeLike, segments: string[]): string {
	const items = segments.filter((segment) => segment.length > 0);
	return items.join(theme.fg("dim", SEP));
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
	const text = percent == null ? "ctx --" : `ctx ${Math.round(percent)}%`;

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

export function formatModel(theme: ThemeLike, ctx: ExtensionContext): string {
	return theme.fg("accent", formatModelLabel(ctx.model));
}

export function formatThinking(theme: ThemeLike, pi: ExtensionAPI): string {
	const level = pi.getThinkingLevel();
	const token =
		level === "off"
			? "dim"
			: level === "minimal"
				? "thinkingMinimal"
				: level === "low"
					? "thinkingLow"
					: level === "medium"
						? "thinkingMedium"
						: level === "high"
							? "thinkingHigh"
							: "thinkingXhigh";
	return theme.fg(token, level);
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
