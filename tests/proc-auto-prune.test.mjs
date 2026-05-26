import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, after, describe, test } from "node:test";
import { createJiti } from "jiti";

process.env.PI_PROC_DIR = "/tmp/pi-proc-test-autoprune-placeholder";

const jiti = createJiti(import.meta.url);
const { autoPruneIfNeeded } = await jiti.import(
	"../src/features/proc/auto-prune.ts",
);
const { createRun, updateRunState, listRuns, _resetSchemaCache } =
	await jiti.import("../src/features/proc/store.ts");

let root;

async function makeTerminated(cwd, n) {
	const created = [];
	for (let i = 0; i < n; i++) {
		const run = await createRun({
			cwd,
			command: "node test.js",
			argv: ["node", "test.js"],
			shell: false,
			foreground: false,
		});
		// Force a deterministic startedAt order: oldest = i=0.
		// (createRun stamps `new Date().toISOString()`, so we override.)
		// updateRunState only changes state.* fields; meta.startedAt is fixed
		// on createRun. For tests we accept the natural order — they're written
		// sequentially so seq matches creation order.
		await updateRunState(run.meta.runId, { status: "exited", exitCode: 0 });
		created.push(run);
	}
	return created;
}

before(async () => {
	root = await mkdtemp(path.join(tmpdir(), "pi-proc-test-autoprune-"));
	process.env.PI_PROC_DIR = root;
	_resetSchemaCache();
});

after(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});

describe("autoPruneIfNeeded", () => {
	test("no-op when count is at or below the high watermark", async () => {
		const cwd = path.join(root, "proj-noop");
		await makeTerminated(cwd, 5);
		const result = await autoPruneIfNeeded({ cwd, high: 10, low: 5 });
		assert.equal(result.deletedCount, 0);
		assert.equal(result.skipped, false);
	});

	test("trims down to low when count exceeds high", async () => {
		const cwd = path.join(root, "proj-trim");
		await makeTerminated(cwd, 12);
		const result = await autoPruneIfNeeded({ cwd, high: 10, low: 5 });
		assert.equal(result.deletedCount, 12 - 5);
		const remaining = await listRuns({ cwd, limit: 100 });
		assert.equal(remaining.length, 5);
	});

	test("skipped when PI_PROC_NO_AUTOPRUNE=1", async () => {
		const cwd = path.join(root, "proj-skip");
		await makeTerminated(cwd, 12);
		const prev = process.env.PI_PROC_NO_AUTOPRUNE;
		process.env.PI_PROC_NO_AUTOPRUNE = "1";
		try {
			const result = await autoPruneIfNeeded({ cwd, high: 10, low: 5 });
			assert.equal(result.skipped, true);
			assert.equal(result.deletedCount, 0);
		} finally {
			if (prev === undefined) delete process.env.PI_PROC_NO_AUTOPRUNE;
			else process.env.PI_PROC_NO_AUTOPRUNE = prev;
		}
	});

	test("bails out when low >= high (misconfigured)", async () => {
		const cwd = path.join(root, "proj-bad-config");
		await makeTerminated(cwd, 5);
		const result = await autoPruneIfNeeded({ cwd, high: 5, low: 5 });
		assert.equal(result.skipped, true);
	});
});
