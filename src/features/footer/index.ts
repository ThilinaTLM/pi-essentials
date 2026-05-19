import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	getFooterLeftItems,
	onFooterLeftChange,
} from "../../shared/footer-left.js";
import {
	getAnthropicUsageSnapshot,
	getCodexUsageSnapshot,
} from "../usage/index.js";
import {
	aggregateUsage,
	type FooterSegment,
	formatBranch,
	formatContext,
	formatCost,
	formatModelWithThinking,
	formatResetAfterSecondsDim,
	formatResetTimeDim,
	formatTokenCount,
	formatUtilizationPercent,
	joinSegments,
	LEFT_SEP,
	shortenCwd,
} from "./format.js";
import { createGitDirtyWatcher, isGitDirty } from "./git.js";
import { buildFooterLine } from "./layout.js";

const GIT_REFRESH_DEBOUNCE_MS = 250;
const GIT_MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

let currentToken: symbol | undefined;
let currentRequestRender: (() => void) | undefined;

function setRenderTrigger(token: symbol, trigger: () => void): void {
	currentToken = token;
	currentRequestRender = trigger;
}

function clearRenderTrigger(token: symbol): void {
	if (currentToken === token) {
		currentToken = undefined;
		currentRequestRender = undefined;
	}
}

export function requestFooterRender(): void {
	currentRequestRender?.();
}

export function registerFooter(pi: ExtensionAPI): void {
	let gitDirty = false;
	let lastDirty: boolean | undefined;
	let refreshCounter = 0;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let gitWatcherDispose: (() => void) | undefined;

	async function refreshGitDirty(cwd: string): Promise<void> {
		const refreshId = ++refreshCounter;
		const dirty = await isGitDirty(cwd);
		if (refreshId !== refreshCounter) {
			return;
		}
		gitDirty = dirty;
		if (lastDirty !== dirty) {
			lastDirty = dirty;
			currentRequestRender?.();
		}
	}

	function scheduleGitRefresh(cwd: string): void {
		if (refreshTimer) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			void refreshGitDirty(cwd);
		}, GIT_REFRESH_DEBOUNCE_MS);
	}

	function teardownGitWatcher(): void {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = undefined;
		}
		gitWatcherDispose?.();
		gitWatcherDispose = undefined;
	}

	function installFooter(ctx: ExtensionContext): void {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const token = Symbol("footer");
			setRenderTrigger(token, () => tui.requestRender());

			const unsubscribeBranch = footerData.onBranchChange(() => {
				scheduleGitRefresh(ctx.cwd);
				tui.requestRender();
			});

			const unsubscribeLeft = onFooterLeftChange(() => {
				tui.requestRender();
			});

			return {
				invalidate() {},
				dispose() {
					unsubscribeBranch();
					unsubscribeLeft();
					clearRenderTrigger(token);
				},
				render(width: number): string[] {
					const usage = aggregateUsage(ctx);
					const leftSegments = [
						...getFooterLeftItems().values(),
						theme.fg("muted", shortenCwd(ctx.cwd)),
						formatBranch(theme, footerData.getGitBranch(), gitDirty),
					].filter((segment): segment is string => Boolean(segment));

					const anthropicData = getAnthropicUsageSnapshot();
					const codexData = getCodexUsageSnapshot();
					const rightSegments: FooterSegment[] = [];

					// Group 1: Anthropic Usage
					if (anthropicData) {
						const usageItems: string[] = [];

						if (anthropicData.sessionUtilization != null) {
							const sessionPct = formatUtilizationPercent(
								theme,
								anthropicData.sessionUtilization,
							);
							const resetText = formatResetTimeDim(
								theme,
								anthropicData.sessionResetAt,
							);
							usageItems.push(
								resetText
									? `${sessionPct} ${theme.fg("dim", "(")}${resetText}${theme.fg("dim", ")")}`
									: sessionPct,
							);
						}
						if (anthropicData.weeklyUtilization != null) {
							usageItems.push(
								formatUtilizationPercent(
									theme,
									anthropicData.weeklyUtilization,
								),
							);
						}

						for (const item of usageItems) {
							rightSegments.push({
								key: "usage",
								text: item,
								group: "usage",
							});
						}
					}

					// Group 1b: Codex Usage
					if (codexData) {
						const usageItems: string[] = [];

						if (codexData.primaryUsedPercent != null) {
							const sessionPct = formatUtilizationPercent(
								theme,
								codexData.primaryUsedPercent,
							);
							const resetText = formatResetAfterSecondsDim(
								theme,
								codexData.primaryResetAfterSeconds,
							);
							usageItems.push(
								resetText
									? `${sessionPct} ${theme.fg("dim", "(")}${resetText}${theme.fg("dim", ")")}`
									: sessionPct,
							);
						}
						if (codexData.secondaryUsedPercent != null) {
							usageItems.push(
								formatUtilizationPercent(theme, codexData.secondaryUsedPercent),
							);
						}

						for (const item of usageItems) {
							rightSegments.push({
								key: "codex-usage",
								text: item,
								group: "codex-usage",
							});
						}
					}

					// Group 2: Context + Tokens + Cost
					rightSegments.push({
						key: "context",
						text: formatContext(theme, ctx),
						required: true,
						group: "session",
					});

					const tokenSegment = formatTokenCount(theme, usage);
					if (tokenSegment) {
						rightSegments.push({
							key: "tokens",
							text: tokenSegment,
							group: "session",
						});
					}

					rightSegments.push({
						key: "cost",
						text: formatCost(theme, usage),
						group: "session",
					});

					// Group 3: Model + Thinking (ungrouped)
					rightSegments.push({
						key: "model",
						text: formatModelWithThinking(theme, ctx, pi),
						required: true,
					});

					const left = joinSegments(theme, leftSegments, LEFT_SEP);
					const line = buildFooterLine(
						theme,
						width,
						left,
						rightSegments.filter((segment): boolean => Boolean(segment.text)),
					);
					return [line];
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		installFooter(ctx);
		teardownGitWatcher();
		lastDirty = undefined;
		await refreshGitDirty(ctx.cwd);
		gitWatcherDispose = createGitDirtyWatcher(ctx.cwd, () => {
			scheduleGitRefresh(ctx.cwd);
		}).dispose;
	});

	pi.on("turn_end", (_event, ctx) => {
		scheduleGitRefresh(ctx.cwd);
	});

	pi.on("tool_result", (event, ctx) => {
		if (GIT_MUTATING_TOOLS.has(event.toolName)) {
			scheduleGitRefresh(ctx.cwd);
		}
	});

	pi.on("user_bash", (_event, ctx) => {
		scheduleGitRefresh(ctx.cwd);
	});

	pi.on("model_select", () => {
		currentRequestRender?.();
	});

	pi.on("session_shutdown", () => {
		teardownGitWatcher();
	});
}
