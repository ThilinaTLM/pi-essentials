import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	getEnabledModels,
	getSettings,
	saveSettings,
} from "../../shared/settings.js";

export function registerExploreModelCommand(pi: ExtensionAPI): void {
	pi.registerCommand("explore-model", {
		description: "Set the model used by explore sub-agents",
		handler: async (_args, ctx) => {
			const available = ctx.modelRegistry.getAvailable();
			const enabledPatterns = await getEnabledModels();

			const models =
				enabledPatterns.length > 0
					? available.filter((model) => {
							const key = `${model.provider}/${model.id}`;
							return enabledPatterns.some(
								(pattern) =>
									pattern === key ||
									pattern === model.id ||
									pattern === model.name,
							);
						})
					: available;

			const defaultOption = "Use parent model (default)";
			const options = [
				defaultOption,
				...models.map((model) => `${model.provider}/${model.id}`),
			];

			const current = getSettings().exploreModel;
			const choice = await ctx.ui.select(
				`Explore model${current ? ` (current: ${current})` : ""}`,
				options,
			);
			if (!choice) return;

			const settings = { ...getSettings() };
			if (choice === defaultOption) {
				delete settings.exploreModel;
				await saveSettings(settings);
				ctx.ui.notify("Explore model reset to parent model.", "info");
				return;
			}

			settings.exploreModel = choice;
			await saveSettings(settings);
			ctx.ui.notify(`Explore model set to ${choice}`, "info");
		},
	});
}
