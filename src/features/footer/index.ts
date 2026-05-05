import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	getFooterLeftItems,
	onFooterLeftChange,
} from "../../shared/footer-left.js";
import { getUsageSnapshot } from "../usage/index.js";
import {
	aggregateUsage,
	type FooterSegment,
	formatBranch,
	formatContext,
	formatCost,
	formatModelWithThinking,
	formatResetTimeDim,
	formatTokenCount,
	formatUtilizationPercent,
	joinSegments,
	LEFT_SEP,
	shortenCwd,
} from "./format.js";
import { isGitDirty } from "./git.js";
import { buildFooterLine } from "./layout.js";

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

			const unsubscribeLeft = onFooterLeftChange(() => {
				tui.requestRender();
			});

			return {
				invalidate() {},
				dispose() {
					unsubscribeBranch();
					unsubscribeLeft();
					renderRequest = undefined;
				},
				render(width: number): string[] {
					const usage = aggregateUsage(ctx);
					const leftSegments = [
						...getFooterLeftItems().values(),
						theme.fg("muted", shortenCwd(ctx.cwd)),
						formatBranch(theme, footerData.getGitBranch(), gitDirty),
					].filter((segment): segment is string => Boolean(segment));

					const anthropicData = getUsageSnapshot();
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
	});

	pi.on("turn_end", async (_event, ctx) => {
		await refreshGitDirty(ctx.cwd);
	});

	pi.on("model_select", async () => {
		renderRequest?.();
	});
}
