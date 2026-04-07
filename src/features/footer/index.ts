import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	aggregateUsage,
	type FooterSegment,
	formatBranch,
	formatContext,
	formatCost,
	formatModel,
	formatThinking,
	formatTokenCount,
	joinSegments,
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

	pi.on("model_select", async () => {
		renderRequest?.();
	});
}
