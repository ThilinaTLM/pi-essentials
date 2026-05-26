/**
 * Back-compat shim. The CLI was restructured under `cli/`. This module
 * re-exports the symbols external callers (tests, `bin/pi-proc.mjs`) used.
 *
 * - `main` is invoked by `bin/pi-proc.mjs`.
 * - `renderListTable` is consumed by tests under `tests/`.
 * - Other helpers are re-exported for any third-party callers that may
 *   have grown a dependency on them.
 */
export {
	CliError,
	didYouMean,
	formatCliError,
	listToJson,
	main,
	padEndVisible,
	renderListTable,
	suggest,
	visibleWidth,
} from "./cli/index.js";

import { rawLogPath as _rawLogPath } from "./store.js";

/** Legacy export: many old callers used `rawLogPathOf` from cli.ts. */
export function rawLogPathOf(
	runId: string,
	stream: "stdout" | "stderr",
): string {
	return _rawLogPath(runId, stream);
}
