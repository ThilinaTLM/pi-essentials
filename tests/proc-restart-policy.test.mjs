import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, after, describe, test } from "node:test";
import { createJiti } from "jiti";

// Use a sandboxed proc root so we don't touch the user's real ~/.pi/proc.
process.env.PI_PROC_DIR = "/tmp/pi-proc-test-restart-placeholder";

const jiti = createJiti(import.meta.url);
const { superviseRunWithRestart } = await jiti.import(
	"../src/features/proc/runner.ts",
);
const { createRun, readRun, _resetSchemaCache } = await jiti.import(
	"../src/features/proc/store.ts",
);

// Two roots: one for the supervisor's state (PI_PROC_DIR), one for the
// child's working directory. They must be disjoint because the schema
// migration in ensureSchemaVersion *renames* PI_PROC_DIR when the on-disk
// version doesn't match, which would wipe any cwd we put inside it.
let procRoot;
let workRoot;

before(async () => {
	procRoot = await mkdtemp(path.join(tmpdir(), "pi-proc-test-restart-proc-"));
	workRoot = await mkdtemp(path.join(tmpdir(), "pi-proc-test-restart-work-"));
	process.env.PI_PROC_DIR = procRoot;
	_resetSchemaCache();
});

after(async () => {
	if (procRoot) await rm(procRoot, { recursive: true, force: true });
	if (workRoot) await rm(workRoot, { recursive: true, force: true });
});

// We need a tiny throwaway script per test so we can count invocations from
// the filesystem (the child appends a line to a counter file).
//
// The 500ms delay before exiting works around a pre-existing race in the
// supervisor: ptyHandle.onExit is registered AFTER the PTY child spawn
// completes plus several state-write awaits, and node-pty doesn't replay
// exits that fire before the listener is attached. Real users never hit
// this (dev servers don't exit in microseconds), but tests do.
async function makeCountingScript(scriptDir, counterPath, exitCode = 1) {
	const scriptPath = path.join(scriptDir, "child.mjs");
	const code = `
import { appendFile } from "node:fs/promises";
await appendFile(${JSON.stringify(counterPath)}, "x");
await new Promise((resolve) => setTimeout(resolve, 500));
process.exit(${exitCode});
`;
	await writeFile(scriptPath, code, "utf8");
	return scriptPath;
}

describe("superviseRunWithRestart", () => {
	test("respects --on-exit none (default): exits after first failure", async () => {
		const dir = await mkdtemp(path.join(workRoot, "noop-"));
		const counter = path.join(dir, "counter");
		const script = await makeCountingScript(dir, counter);
		const run = await createRun({
			cwd: dir,
			command: `node ${script}`,
			argv: ["node", script],
			shell: false,
			foreground: false,
		});
		const code = await superviseRunWithRestart(run.meta.runId, {
			tee: false,
			allowControlSocket: false,
		});
		assert.equal(code, 1);
		const fresh = await readRun(run.meta.runId);
		assert.equal(fresh.state.status, "failed");
		assert.equal(fresh.state.restartCount ?? 0, 0);
		const counterText = await readFile(counter, "utf8");
		assert.equal(counterText.length, 1); // one attempt
	});

	test("re-spawns up to `max` attempts under restart policy", async () => {
		const dir = await mkdtemp(path.join(workRoot, "restart-"));
		const counter = path.join(dir, "counter");
		const script = await makeCountingScript(dir, counter);
		const run = await createRun({
			cwd: dir,
			command: `node ${script}`,
			argv: ["node", script],
			shell: false,
			foreground: false,
			onExit: { kind: "restart", max: 3, backoffMs: 10 },
		});
		const code = await superviseRunWithRestart(run.meta.runId, {
			tee: false,
			allowControlSocket: false,
		});
		assert.equal(code, 1);
		const fresh = await readRun(run.meta.runId);
		assert.equal(fresh.state.restartCount, 3);
		const counterText = await readFile(counter, "utf8");
		// 1 initial attempt + 3 restarts = 4 invocations.
		assert.equal(counterText.length, 4);
	});

	test("clean exit short-circuits the loop", async () => {
		const dir = await mkdtemp(path.join(workRoot, "cleanexit-"));
		const counter = path.join(dir, "counter");
		const script = await makeCountingScript(dir, counter, 0);
		const run = await createRun({
			cwd: dir,
			command: `node ${script}`,
			argv: ["node", script],
			shell: false,
			foreground: false,
			onExit: { kind: "restart", max: 5, backoffMs: 10 },
		});
		const code = await superviseRunWithRestart(run.meta.runId, {
			tee: false,
			allowControlSocket: false,
		});
		assert.equal(code, 0);
		const counterText = await readFile(counter, "utf8");
		// Single attempt — clean exit doesn't retry.
		assert.equal(counterText.length, 1);
	});
});
