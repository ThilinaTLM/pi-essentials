import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { waitForReady, formatReadyLine } = await jiti.import(
	"../src/features/proc/tools.ts",
);
const { createRun, updateRunState, readRun, _resetSchemaCache } =
	await jiti.import("../src/features/proc/store.ts");
const { appendEvent } = await jiti.import(
	"../src/features/proc/log-segments.ts",
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

function ev(runId, seq, line) {
	return {
		ts: new Date().toISOString(),
		runId,
		seq,
		stream: "stdout",
		level: "info",
		line,
		ansiStripped: line,
		tags: [],
	};
}

describe("waitForReady outcomes", () => {
	test("outcome 'ready' carries an accurate elapsed time, not the window", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "web",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: false,
			});
			// Set readyAt first, THEN emit the event — the tailer's onEvent handler
			// re-reads run state and finishes on `readyAt`, so the trailing event is
			// what unblocks us. (If we appended first, waitForReady would only
			// notice when its maxWait timer fired.)
			setTimeout(async () => {
				await updateRunState(run.meta.runId, {
					status: "running",
					readyAt: new Date().toISOString(),
				});
				await appendEvent(ev(run.meta.runId, 0, "listening"));
			}, 50);

			const outcome = await waitForReady(run.meta.runId, 5_000, 5);
			assert.equal(outcome.outcome, "ready");
			assert.equal(outcome.reachedReady, true);

			const fresh = await readRun(run.meta.runId);
			const line = formatReadyLine(outcome, fresh, 5_000);
			assert.match(line, /^Ready: yes \(took \d+ms\)$/);
			// Must report a time well under the 5000ms window, not the window itself.
			const took = Number(line.match(/took (\d+)ms/)[1]);
			assert.ok(took < 2000, `expected elapsed < 2000ms, got ${took}`);
		});
	});

	test("outcome 'exited' when child reaches a terminal status before signalling", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "crashy",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: false,
			});
			setTimeout(async () => {
				await appendEvent(ev(run.meta.runId, 0, "starting"));
				await updateRunState(run.meta.runId, {
					status: "failed",
					exitCode: 1,
					endedAt: new Date().toISOString(),
				});
			}, 50);

			const outcome = await waitForReady(run.meta.runId, 3_000, 5);
			assert.equal(outcome.outcome, "exited");
			assert.equal(outcome.reachedReady, false);
			assert.equal(outcome.terminalStatus, "failed");

			const fresh = await readRun(run.meta.runId);
			const line = formatReadyLine(outcome, fresh, 3_000);
			assert.match(line, /process reached terminal status 'failed'/);
			// Exit code must be in the ready line so short-lived commands surface
			// it without the caller having to dig into state.
			assert.match(line, /exit 1/);
		});
	});

	test("formatReadyLine surfaces signal when no exit code is recorded", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "signalled",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: false,
			});
			await updateRunState(run.meta.runId, {
				status: "stopped",
				signal: "SIGTERM",
				endedAt: new Date().toISOString(),
			});
			const fresh = await readRun(run.meta.runId);
			const line = formatReadyLine(
				{
					reachedReady: false,
					outcome: "exited",
					terminalStatus: "stopped",
					startupLines: [],
					urls: [],
				},
				fresh,
				3_000,
			);
			assert.match(line, /signal SIGTERM/);
		});
	});

	test("outcome 'timeout' when process keeps running but never signals ready", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "slow",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: false,
			});
			await updateRunState(run.meta.runId, { status: "running" });
			// Emit a chatty event but never set readyAt or terminal status.
			setTimeout(async () => {
				await appendEvent(ev(run.meta.runId, 0, "still booting..."));
			}, 50);

			const outcome = await waitForReady(run.meta.runId, 250, 5);
			assert.equal(outcome.outcome, "timeout");
			assert.equal(outcome.reachedReady, false);
			assert.equal(outcome.terminalStatus, undefined);

			const fresh = await readRun(run.meta.runId);
			const line = formatReadyLine(outcome, fresh, 250);
			assert.match(
				line,
				/not signalled within 250ms \(process still running\)\./,
			);
		});
	});

	test("startupTailLines: 0 returns no startup lines", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "quiet",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: false,
			});
			setTimeout(async () => {
				for (let i = 0; i < 4; i++)
					await appendEvent(ev(run.meta.runId, i, `line ${i}`));
				await updateRunState(run.meta.runId, {
					status: "running",
					readyAt: new Date().toISOString(),
				});
				await appendEvent(ev(run.meta.runId, 4, "ready"));
			}, 50);

			const outcome = await waitForReady(run.meta.runId, 3_000, 0);
			assert.equal(outcome.outcome, "ready");
			assert.deepEqual(outcome.startupLines, []);
		});
	});
});
