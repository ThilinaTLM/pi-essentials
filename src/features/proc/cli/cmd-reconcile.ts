import { reconcileAllRuns } from "../process.js";
import { writeLine } from "./output.js";

export async function cmdReconcile(): Promise<void> {
	const runs = await reconcileAllRuns();
	writeLine(`Reconciled ${runs.length} active run(s).`);
}
