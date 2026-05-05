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
import { isGitDirty } from "./git.js";
import { buildFooterLine } from "./layout.js";

const GIT_REFRESH_INTERVAL = 3_000;

let onRenderRequest: (() => void) | undefined;

export function requestFooterRender(): void {
	onRenderRequest?.();
}

export function registerFooter(pi: ExtensionAPI): void {
	let gitDirty = false;
	let renderRequest: (() => void) | undefined;
	let refreshCounter = 0;
	let gitRefreshTimer: ReturnType<typeof setInterval> | undefined;

	async function refreshGitDirty(cwd: string): Promise<void> {
		const refreshId = ++refreshCounter;
		const dirty = await isGitDirty(cwd);
		if (refreshId !== refreshCounter) {
			return;
		}
		gitDirty = dirty;
		renderRequest?.();
	}

	function startGitRefresh(cwd: string): void {
		stopGitRefresh();
		gitRefreshTimer = setInterval(() => {
			void refreshGitDirty(cwd);
		}, GIT_REFRESH_INTERVAL);
	}

	function stopGitRefresh(): void {
		if (gitRefreshTimer) {
			clearInterval(gitRefreshTimer);
			gitRefreshTimer = undefined;
		}
	}

	function installFooter(ctx: ExtensionContext): void {
		ctx.ui.setFooter((tui, theme, footerData) => {
			renderRequest = () => tui.requestRender();
			onRenderRequest = renderRequest;

			const unsubscribeBranch = footerData.onBranchChange(() => {
				void refreshGitDirty(ctx.cwd);
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
					renderRequest = undefined;
					onRenderRequest = undefined;
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
		await refreshGitDirty(ctx.cwd);
		startGitRefresh(ctx.cwd);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await refreshGitDirty(ctx.cwd);
	});

	pi.on("model_select", async () => {
		renderRequest?.();
	});

	pi.on("session_shutdown", () => {
		stopGitRefresh();
	});
}
