import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProcCommands } from "./commands.js";
import { reconcileAllRuns } from "./process.js";
import { ensureSchemaVersion } from "./store.js";
import {
	procLogsQueryTool,
	procProcessListTool,
	procProcessRestartTool,
	procProcessStartTool,
	procProcessStopTool,
} from "./tools.js";

export function registerProc(pi: ExtensionAPI) {
	pi.registerTool(procProcessStartTool);
	pi.registerTool(procProcessListTool);
	pi.registerTool(procProcessStopTool);
	pi.registerTool(procProcessRestartTool);
	pi.registerTool(procLogsQueryTool);
	registerProcCommands(pi);

	pi.on("session_start", async () => {
		await ensureSchemaVersion();
		// Quick reconcile on every session start.
		await reconcileAllRuns().catch(() => undefined);
	});
}
