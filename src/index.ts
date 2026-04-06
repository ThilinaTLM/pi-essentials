import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerExplore } from "./explore/index.js";
import { registerFooter } from "./footer.js";
import { registerPlan } from "./plan.js";
import { loadSettings } from "./settings.js";
import { todosGetTool, todosSetTool } from "./todo.js";
import { webFetchTool } from "./web-fetch.js";
import { webSearchTool } from "./web-search.js";
import { registerWelcome } from "./welcome.js";

export default function (pi: ExtensionAPI) {
	pi.registerTool(todosSetTool);
	pi.registerTool(todosGetTool);
	pi.registerTool(webSearchTool);
	pi.registerTool(webFetchTool);
	registerExplore(pi);
	registerPlan(pi);
	registerFooter(pi);
	registerWelcome(pi);

	pi.on("session_start", async () => {
		await loadSettings();
	});
}
