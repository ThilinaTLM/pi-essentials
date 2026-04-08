import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerExplore } from "./features/explore/index.js";
import { registerFooter } from "./features/footer/index.js";
import { registerPermissions } from "./features/permissions/index.js";
import { registerPlan } from "./features/plan/index.js";
import { registerWelcome } from "./features/welcome/index.js";
import { loadSettings } from "./shared/settings.js";
import { todosGetTool, todosSetTool } from "./tools/todo/index.js";
import { webFetchTool } from "./tools/web-fetch/index.js";
import { webSearchTool } from "./tools/web-search/index.js";

export default function (pi: ExtensionAPI) {
	pi.registerTool(todosSetTool);
	pi.registerTool(todosGetTool);
	pi.registerTool(webSearchTool);
	pi.registerTool(webFetchTool);
	registerExplore(pi);
	registerPermissions(pi);
	registerPlan(pi);
	registerFooter(pi);
	registerWelcome(pi);

	pi.on("session_start", async () => {
		await loadSettings();
	});
}
