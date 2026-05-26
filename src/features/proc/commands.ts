import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatRunCommand } from "./format.js";
import { installProcBin } from "./install-bin.js";
import { reconcileAllRuns } from "./process.js";
import { listRuns } from "./store.js";

export function registerProcCommands(pi: ExtensionAPI) {
	pi.registerCommand("proc-install-bin", {
		description: "Install or update the pi-proc shell shim",
		handler: async (args, ctx) => {
			const targetDir = args.trim() || undefined;
			const result = await installProcBin(targetDir);
			ctx.ui.notify(result.message, result.onPath ? "info" : "warning");
		},
	});

	pi.registerCommand("proc", {
		description: "Show recent pi-proc managed processes for this project",
		handler: async (_args, ctx) => {
			await reconcileAllRuns();
			const runs = await listRuns({ cwd: ctx.cwd, limit: 10 });
			if (runs.length === 0) {
				ctx.ui.notify("No proc runs found for this project.", "info");
				return;
			}
			const lines = runs.map(
				(run) =>
					`${run.state.status.padEnd(9)} ${run.meta.name ?? "-"} ${run.meta.runId} — ${formatRunCommand(run.meta)}`,
			);
			ctx.ui.notify(`Recent proc runs:\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("proc-reconcile", {
		description: "Re-probe pid liveness for active proc runs",
		handler: async (_args, ctx) => {
			const runs = await reconcileAllRuns();
			ctx.ui.notify(`Reconciled ${runs.length} active run(s).`, "info");
		},
	});
}
