import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import { getSettings, loadSettings } from "../../shared/settings.js";
import { formatModelLabel, type ModelLike } from "../../shared/ui/model.js";
import { statusGlyph } from "../../shared/ui/status.js";
import {
	getPermissionLevel,
	type PermissionLevel,
} from "../permissions/index.js";

type WelcomeInfo = {
	current: string;
	explore: string | undefined;
	permissionLevel: PermissionLevel;
};

type ModelRegistryLike = {
	find(provider: string, id: string): ModelLike | undefined;
};

function getLogoColumns(theme: Theme): string[] {
	const on = "██";
	const off = "  ";
	const block = (cells: [number, number, number, number]) =>
		theme.fg("text", cells.map((cell) => (cell === 1 ? on : off)).join(""));

	return [
		block([1, 1, 1, 0]),
		block([1, 0, 1, 0]),
		block([1, 1, 0, 1]),
		block([1, 0, 0, 1]),
	];
}

function getModelLines(
	theme: Theme,
	info: WelcomeInfo,
	width: number,
): string[] {
	const heavy = `${statusGlyph(theme, "active")} ${theme.fg("accent", info.current)}`;
	const lite = info.explore
		? `${statusGlyph(theme, "idle")} ${theme.fg("muted", info.explore)}`
		: "";
	const perm =
		info.permissionLevel === "supervised"
			? `${statusGlyph(theme, "idle")} ${theme.fg("muted", "Supervised")}`
			: `${statusGlyph(theme, "active")} ${theme.fg("accent", "Auto")}`;

	const lines = [heavy, lite, "", perm];

	const maxWidth = lines.reduce(
		(max, line) => Math.max(max, visibleWidth(line)),
		0,
	);
	const padWidth = Math.min(maxWidth, width);

	return lines.map((line) => {
		const pad = padWidth - visibleWidth(line);
		return pad > 0 ? line + " ".repeat(pad) : line;
	});
}

function getLogoLines(theme: Theme, info: WelcomeInfo): string[] {
	const indent = "  ";
	const gap = "   ";
	const logo = getLogoColumns(theme);
	const models = getModelLines(theme, info, 30);
	const subtitle = theme.fg("muted", theme.bold("Pi coding agent"));

	const combined = logo.map((logoLine, i) => {
		const modelLine = models[i] ?? "";
		return `${indent}${logoLine}${gap}${modelLine}`;
	});

	return ["", ...combined, "", `${indent}${subtitle}`];
}

function resolveExploreModel(
	modelId: string | undefined,
	registry: ModelRegistryLike,
): string | undefined {
	if (!modelId) return undefined;
	const [provider, id] = modelId.split("/", 2);
	if (!provider || !id) return modelId;
	const resolved = registry.find(provider, id);
	return resolved ? formatModelLabel(resolved) : modelId;
}

function buildInfo(
	model: ModelLike | undefined,
	registry: ModelRegistryLike,
): WelcomeInfo {
	return {
		current: formatModelLabel(model),
		explore: resolveExploreModel(getSettings().exploreModel, registry),
		permissionLevel: getPermissionLevel(),
	};
}

export function registerWelcome(pi: ExtensionAPI): void {
	let renderRequest: (() => void) | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		await loadSettings();

		ctx.ui.setHeader((tui, theme) => {
			renderRequest = () => tui.requestRender();
			return {
				invalidate() {},
				dispose() {
					renderRequest = undefined;
				},
				render(_width: number): string[] {
					const info = buildInfo(ctx.model, ctx.modelRegistry);
					return getLogoLines(theme, info);
				},
			};
		});
	});

	pi.on("model_select", async () => {
		renderRequest?.();
	});
}
