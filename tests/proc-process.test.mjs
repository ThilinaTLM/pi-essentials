import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isPidAlive, signalExitCode, reconcileRun, stopResolvedRun } =
	await jiti.import("../src/features/proc/process.ts");
const { createRun, readRun, updateRunState, _resetSchemaCache } =
	await jiti.import("../src/features/proc/store.ts");
const { formatRunCommand } = await jiti.import(
	"../src/features/proc/format.ts",
);
const { renderListTable } = await jiti.import(
	"../src/features/proc/cli.ts",
);

async function withProcRoot(fn) {
	const dir = mkdtempSync(join(tmpdir(), "pi-proc-test-"));
	const old = process.env.PI_PROC_DIR;
	process.env.PI_PROC_DIR = dir;
	_resetSchemaCache();
	try {
		await fn(dir);
	} finally {
		if (old === undefined) delete process.env.PI_PROC_DIR;
		else process.env.PI_PROC_DIR = old;
		_resetSchemaCache();
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("proc process helpers", () => {
	test("computes signal exit code", () => {
		assert.equal(signalExitCode("SIGTERM"), 143);
	});

	test("detects live and exited pids", async () => {
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1000)"]);
		try {
			assert.equal(isPidAlive(child.pid), true);
		} finally {
			child.kill("SIGTERM");
		}
		await new Promise((resolve) => child.once("exit", resolve));
		assert.equal(isPidAlive(child.pid), false);
	});

	test("reconcileRun marks dead detached run as crashed", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "ghost",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: false,
			});
			// Pretend the supervisor wrote running but both processes have died.
			await updateRunState(run.meta.runId, {
				status: "running",
				supervisorPid: 999999,
				childPid: 999998,
			});
			const current = await readRun(run.meta.runId);
			const reconciled = await reconcileRun(current);
			assert.equal(reconciled.state.status, "crashed");
			const persisted = await readRun(run.meta.runId);
			assert.equal(persisted.state.status, "crashed");
		});
	});

	test("stopResolvedRun reports already-terminated runs as success, not failure", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "oneshot",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: false,
			});
			await updateRunState(run.meta.runId, {
				status: "exited",
				exitCode: 0,
				endedAt: new Date().toISOString(),
			});
			const result = await stopResolvedRun({
				name: "oneshot",
				cwd: process.cwd(),
			});
			assert.equal(result.stopped, true);
			assert.match(result.message, /Already exited/);
			assert.match(result.message, /exit 0/);
			assert.equal(result.run?.state.status, "exited");
		});
	});

	test("stopResolvedRun distinguishes wrong-name from already-done", async () => {
		await withProcRoot(async () => {
			const result = await stopResolvedRun({
				name: "never-existed",
				cwd: process.cwd(),
			});
			assert.equal(result.stopped, false);
			assert.match(result.message, /No process matched never-existed/);
			assert.equal(result.run, null);
		});
	});

	test("formatRunCommand joins argv into a full command line", () => {
		assert.equal(
			formatRunCommand({
				command: "./gradlew",
				argv: ["./gradlew", ":app:bootRun", "--no-daemon"],
			}),
			"./gradlew :app:bootRun --no-daemon",
		);
		// Falls back to `command` when argv is empty (defensive).
		assert.equal(
			formatRunCommand({ command: "./gradlew", argv: [] }),
			"./gradlew",
		);
	});

	test("renderListTable shows full command line including args", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "api",
				cwd: process.cwd(),
				command: "./gradlew",
				argv: ["./gradlew", ":app:bootRun", "--no-daemon"],
				foreground: false,
			});
			const current = await readRun(run.meta.runId);
			// Force a wide terminal so the CMD column isn't truncated.
			const prevCols = process.stdout.columns;
			Object.defineProperty(process.stdout, "columns", {
				value: 200,
				configurable: true,
			});
			try {
				const table = renderListTable([current]);
				assert.match(table, /\.\/gradlew :app:bootRun --no-daemon/);
			} finally {
				if (prevCols === undefined) {
					Object.defineProperty(process.stdout, "columns", {
						value: undefined,
						configurable: true,
					});
				} else {
					Object.defineProperty(process.stdout, "columns", {
						value: prevCols,
						configurable: true,
					});
				}
			}
		});
	});

	test("reconcileRun flags orphaned when supervisor dies but child lives", async () => {
		await withProcRoot(async () => {
			const child = spawn(process.execPath, [
				"-e",
				"setTimeout(() => {}, 5000)",
			]);
			try {
				const run = await createRun({
					name: "orphan",
					cwd: process.cwd(),
					command: "node",
					argv: ["node"],
					foreground: false,
				});
				await updateRunState(run.meta.runId, {
					status: "running",
					supervisorPid: 999997,
					childPid: child.pid,
				});
				const current = await readRun(run.meta.runId);
				const reconciled = await reconcileRun(current);
				assert.equal(reconciled.state.status, "orphaned");
			} finally {
				child.kill("SIGTERM");
				await new Promise((resolve) => child.once("exit", resolve));
			}
		});
	});
});
