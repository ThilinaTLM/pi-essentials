import { reconcileRun, stopResolvedRun } from "../process.js";
import { startDetachedRun } from "../runner.js";
import { isTerminalStatus } from "../types.js";
import { color, writeLine } from "./output.js";
import { resolveTargetOrThrow } from "./resolve.js";

export async function cmdRestart(target: string): Promise<void> {
	const existing = await resolveTargetOrThrow(target, process.cwd(), "restart");
	const reconciled = await reconcileRun(existing);
	if (!isTerminalStatus(reconciled.state.status)) {
		const stop = await stopResolvedRun({
			runId: existing.meta.runId,
			reason: "restart",
		});
		writeLine(stop.message);
	}
	const started = await startDetachedRun({
		name: existing.meta.name,
		cwd: existing.meta.cwd,
		command: existing.meta.command,
		argv: existing.meta.argv,
		shell: existing.meta.shell,
		env: existing.meta.env,
		forceColor: existing.meta.forceColor,
		classify: existing.meta.classify,
		readyPattern: existing.meta.readyPattern,
		readyOnUrl: existing.meta.readyOnUrl,
	});
	const label = started.run.meta.name ?? started.run.meta.runId;
	writeLine(
		`Restarted ${color.green(label)} (run id ${color.cyan(started.run.meta.runId)}).`,
	);
}
