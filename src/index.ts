import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { todosSetTool, todosGetTool } from "./todo.js";
import { webSearchTool } from "./web-search.js";
import { webFetchTool } from "./web-fetch.js";
import { registerPlan } from "./plan.js";
import { registerFooter } from "./footer.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool(todosSetTool);
  pi.registerTool(todosGetTool);
  pi.registerTool(webSearchTool);
  pi.registerTool(webFetchTool);
  registerPlan(pi);
  registerFooter(pi);
}
