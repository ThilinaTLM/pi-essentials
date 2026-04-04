import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { sep } from "node:path";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const execFileAsync = promisify(execFile);
const BRANCH_GLYPH = "";
const SEP = " · ";
const GIT_STATUS_TIMEOUT_MS = 1000;

type ThemeLike = ExtensionContext["ui"]["theme"];
type FooterSegment = {
	key: string;
	text: string;
	required?: boolean;
};

type AggregatedUsage = {
	totalTokens: number;
	totalCost: number;
};

function shortenCwd(cwd: string): string {
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

function formatCompactNumber(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
	}
	return `${Math.round(value)}`;
}

function formatCostValue(cost: number): string {
	if (cost === 0) {
		return "$0.00";
	}
	if (cost >= 1) {
		return `$${cost.toFixed(2)}`;
	}
	if (cost >= 0.01) {
		return `$${cost.toFixed(2)}`;
	}
	return `$${cost.toFixed(3)}`;
}

function joinSegments(theme: ThemeLike, segments: string[]): string {
	const items = segments.filter((segment) => segment.length > 0);
	return items.join(theme.fg("dim", SEP));
}

function aggregateUsage(ctx: ExtensionContext): AggregatedUsage {
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

function formatContext(theme: ThemeLike, ctx: ExtensionContext): string {
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

function formatTokenCount(
	theme: ThemeLike,
	usage: AggregatedUsage,
): string | null {
	if (usage.totalTokens <= 0) {
		return null;
	}
	return theme.fg("dim", `${formatCompactNumber(usage.totalTokens)} tok`);
}

function formatCost(theme: ThemeLike, usage: AggregatedUsage): string {
	return theme.fg("dim", formatCostValue(usage.totalCost));
}

function formatModel(theme: ThemeLike, ctx: ExtensionContext): string {
	const model = ctx.model;
	const label = model ? model.name || model.id : "no-model";
	return theme.fg("accent", label);
}

function formatThinking(theme: ThemeLike, pi: ExtensionAPI): string {
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

function formatBranch(
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

function truncateLeft(left: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	return truncateToWidth(left, width);
}

function buildFooterLine(
	theme: ThemeLike,
	width: number,
	left: string,
	rightSegments: FooterSegment[],
): string {
	const dropOrder = ["status", "cost", "tokens", "thinking", "model"];
	const activeSegments = [...rightSegments];

	const getRight = () =>
		joinSegments(
			theme,
			activeSegments.map((segment) => segment.text),
		);
	const totalWidth = (leftText: string, rightText: string) =>
		visibleWidth(leftText) +
		(leftText && rightText ? 1 : 0) +
		visibleWidth(rightText);

	let right = getRight();

	while (totalWidth(left, right) > width) {
		const droppableKey = dropOrder.find((key) =>
			activeSegments.some(
				(segment) => segment.key === key && !segment.required,
			),
		);
		if (!droppableKey) {
			break;
		}
		const index = activeSegments.findIndex(
			(segment) => segment.key === droppableKey && !segment.required,
		);
		if (index === -1) {
			break;
		}
		activeSegments.splice(index, 1);
		right = getRight();
	}

	if (!right) {
		return truncateToWidth(left, width);
	}

	const maxLeftWidth = Math.max(0, width - visibleWidth(right) - 1);
	const fittedLeft = truncateLeft(left, maxLeftWidth);

	if (totalWidth(fittedLeft, right) <= width) {
		const pad = " ".repeat(
			Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(right)),
		);
		return fittedLeft + pad + right;
	}

	if (width <= visibleWidth(right)) {
		return truncateToWidth(right, width);
	}

	const fallbackLeftWidth = Math.max(
		0,
		Math.min(visibleWidth(fittedLeft), Math.floor(width * 0.35)),
	);
	const fallbackLeft = truncateLeft(fittedLeft, fallbackLeftWidth);
	const fallbackRightWidth = Math.max(
		0,
		width - visibleWidth(fallbackLeft) - (fallbackLeft ? 1 : 0),
	);
	const fallbackRight = truncateToWidth(right, fallbackRightWidth);

	if (!fallbackLeft) {
		return fallbackRight;
	}

	const pad = " ".repeat(
		Math.max(
			1,
			width - visibleWidth(fallbackLeft) - visibleWidth(fallbackRight),
		),
	);
	return fallbackLeft + pad + fallbackRight;
}

async function isGitDirty(cwd: string): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["status", "--porcelain", "--untracked-files=normal"],
			{
				cwd,
				encoding: "utf8",
				timeout: GIT_STATUS_TIMEOUT_MS,
				maxBuffer: 1024 * 1024,
			},
		);
		return stdout.trim().length > 0;
	} catch {
		return false;
	}
}

export function registerFooter(pi: ExtensionAPI): void {
	let gitDirty = false;
	let renderRequest: (() => void) | undefined;
	let refreshCounter = 0;

	async function refreshGitDirty(cwd: string): Promise<void> {
		const refreshId = ++refreshCounter;
		const dirty = await isGitDirty(cwd);
		if (refreshId !== refreshCounter) {
			return;
		}
		gitDirty = dirty;
		renderRequest?.();
	}

	function installFooter(ctx: ExtensionContext): void {
		ctx.ui.setFooter((tui, theme, footerData) => {
			renderRequest = () => tui.requestRender();

			const unsubscribeBranch = footerData.onBranchChange(() => {
				void refreshGitDirty(ctx.cwd);
				tui.requestRender();
			});

			return {
				invalidate() {},
				dispose() {
					unsubscribeBranch();
					renderRequest = undefined;
				},
				render(width: number): string[] {
					const usage = aggregateUsage(ctx);
					const leftSegments = [
						theme.fg("muted", shortenCwd(ctx.cwd)),
						formatBranch(theme, footerData.getGitBranch(), gitDirty),
					].filter((segment): segment is string => Boolean(segment));

					const statusSegments: FooterSegment[] = [
						...footerData.getExtensionStatuses().values(),
					].map((text) => ({
						key: "status",
						text,
					}));

					const tokenSegment = formatTokenCount(theme, usage);
					const rightSegments: FooterSegment[] = [
						{ key: "context", text: formatContext(theme, ctx), required: true },
						...(tokenSegment ? [{ key: "tokens", text: tokenSegment }] : []),
						{ key: "cost", text: formatCost(theme, usage) },
						{ key: "model", text: formatModel(theme, ctx), required: true },
						{ key: "thinking", text: formatThinking(theme, pi) },
						...statusSegments,
					].filter((segment): segment is FooterSegment =>
						Boolean(segment.text),
					);

					const left = joinSegments(theme, leftSegments);
					const line = buildFooterLine(theme, width, left, rightSegments);
					return [line];
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		installFooter(ctx);
		await refreshGitDirty(ctx.cwd);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await refreshGitDirty(ctx.cwd);
	});

	pi.on("model_select", async (_event) => {
		renderRequest?.();
	});
}
