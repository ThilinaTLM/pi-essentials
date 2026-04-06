import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerFooter } from "./footer.js";
import { registerPlan } from "./plan.js";
import { todosGetTool, todosSetTool } from "./todo.js";
import { webFetchTool } from "./web-fetch.js";
import { webSearchTool } from "./web-search.js";
import { registerWelcome } from "./welcome.js";

export default function (pi: ExtensionAPI) {
	pi.registerTool(todosSetTool);
	pi.registerTool(todosGetTool);
	pi.registerTool(webSearchTool);
	pi.registerTool(webFetchTool);
	registerPlan(pi);
	registerFooter(pi);
	registerWelcome(pi);
}
