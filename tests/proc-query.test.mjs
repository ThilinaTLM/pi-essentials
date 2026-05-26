import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { queryProcLogs, formatLogEvents } = await jiti.import(
	"../src/features/proc/query.ts",
);
const { createRun, _resetSchemaCache } = await jiti.import(
	"../src/features/proc/store.ts",
);
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

function event(runId, seq, level, line) {
	return {
		ts: new Date(Date.now() + seq * 1000).toISOString(),
		runId,
		seq,
		stream: level === "error" ? "stderr" : "stdout",
		level,
		line,
		ansiStripped: line,
		tags: [],
	};
}

describe("proc log query", () => {
	test("returns error logs with context", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "web",
				cwd: process.cwd(),
				command: "pnpm run dev",
				argv: ["pnpm", "run", "dev"],
				foreground: true,
			});
			await appendEvent(event(run.meta.runId, 0, "info", "starting"));
			await appendEvent(event(run.meta.runId, 1, "error", "Error: boom"));
			await appendEvent(event(run.meta.runId, 2, "info", "after"));

			const result = await queryProcLogs({
				name: "web",
				cwd: process.cwd(),
				mode: "errors",
				contextLines: 1,
			});
			assert.equal(result.matchedCount, 1);
			assert.deepEqual(
				result.events.map((e) => e.ansiStripped),
				["starting", "Error: boom", "after"],
			);
		});
	});

	test("since_last_query advances cursor", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				cwd: process.cwd(),
				command: "node server.js",
				argv: ["node", "server.js"],
				foreground: true,
			});
			await appendEvent(event(run.meta.runId, 0, "info", "one"));
			let result = await queryProcLogs({
				runId: run.meta.runId,
				mode: "since_last_query",
				cursorKey: "session",
			});
			assert.equal(result.returnedCount, 1);

			await appendEvent(event(run.meta.runId, 1, "info", "two"));
			result = await queryProcLogs({
				runId: run.meta.runId,
				mode: "since_last_query",
				cursorKey: "session",
			});
			assert.deepEqual(
				result.events.map((e) => e.ansiStripped),
				["two"],
			);
		});
	});

	test("limit is capped and recent mode honours order", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "app",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: true,
			});
			for (let i = 0; i < 50; i++)
				await appendEvent(event(run.meta.runId, i, "info", `line ${i}`));
			const result = await queryProcLogs({
				name: "app",
				cwd: process.cwd(),
				mode: "recent",
				limit: 5,
			});
			assert.equal(result.returnedCount, 5);
			assert.equal(
				result.events[result.events.length - 1].ansiStripped,
				"line 49",
			);
		});
	});

	test("empty-result message names the active level filter and suggests recent", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "web",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: true,
			});
			await appendEvent(event(run.meta.runId, 0, "info", "server listening"));
			await appendEvent(event(run.meta.runId, 1, "info", "another info line"));
			const result = await queryProcLogs({
				name: "web",
				cwd: process.cwd(),
				mode: "errors",
				contains: "listening",
			});
			assert.equal(result.returnedCount, 0);
			assert.match(result.summary, /error-level/);
			assert.match(result.summary, /contains 'listening'/);
			assert.match(result.summary, /mode:'recent'/);
		});
	});

	test("empty-result message for unfiltered errors mode does not push 'recent'", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "healthy",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: true,
			});
			await appendEvent(event(run.meta.runId, 0, "info", "ok"));
			const result = await queryProcLogs({
				name: "healthy",
				cwd: process.cwd(),
				mode: "errors",
			});
			assert.equal(result.returnedCount, 0);
			assert.match(result.summary, /error-level events/);
			assert.doesNotMatch(result.summary, /mode:'recent'/);
		});
	});

	test("empty-result message for text filter without level is plain", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "app",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: true,
			});
			await appendEvent(event(run.meta.runId, 0, "info", "hello"));
			const result = await queryProcLogs({
				name: "app",
				cwd: process.cwd(),
				mode: "recent",
				contains: "missing",
			});
			assert.equal(result.returnedCount, 0);
			assert.match(result.summary, /No events matched contains 'missing'/);
		});
	});

	test("compact format emits only timestamp + body", () => {
		const events = [
			{
				ts: "2025-01-01T12:34:56.789Z",
				runId: "r",
				seq: 42,
				stream: "stdout",
				level: "error",
				line: "boom",
				ansiStripped: "boom",
				tags: [],
			},
		];
		const compact = formatLogEvents(events, {
			format: "compact",
			label: "web",
		});
		assert.equal(compact, "12:34:56.789 boom");
		const full = formatLogEvents(events, { format: "full", label: "web" });
		assert.equal(full, "[web] 12:34:56.789 #42 stdout error: boom");
		// Default stays "full" so existing programmatic callers don't regress.
		const dflt = formatLogEvents(events, { label: "web" });
		assert.equal(dflt, full);
	});

	test("seq returns a single untruncated event and ignores other filters", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "trace",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: true,
			});
			const long = "y".repeat(3000);
			await appendEvent(event(run.meta.runId, 0, "info", "prelude"));
			await appendEvent(event(run.meta.runId, 1, "info", long));
			await appendEvent(event(run.meta.runId, 2, "info", "epilogue"));

			const result = await queryProcLogs({
				name: "trace",
				cwd: process.cwd(),
				seq: 1,
				// These filters would otherwise reject the event; seq overrides them.
				mode: "errors",
				contains: "never-matches",
				maxLineBytes: 100,
			});
			assert.equal(result.returnedCount, 1);
			assert.equal(result.events[0].seq, 1);
			assert.equal(result.events[0].ansiStripped, long);
			assert.ok(
				!result.events[0].ansiStripped.includes("[truncated]"),
				"seq lookups must not truncate",
			);
			assert.match(result.summary, /seq #1 untruncated/);
		});
	});

	test("seq returns a clear miss when the seq does not exist", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "empty",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: true,
			});
			await appendEvent(event(run.meta.runId, 0, "info", "only event"));
			const result = await queryProcLogs({
				name: "empty",
				cwd: process.cwd(),
				seq: 99,
			});
			assert.equal(result.returnedCount, 0);
			assert.match(result.summary, /No event with seq #99/);
		});
	});

	test("maxLineBytes: 0 disables truncation for the whole query", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "raw",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: true,
			});
			const long = "z".repeat(2000);
			await appendEvent(event(run.meta.runId, 0, "info", long));
			const result = await queryProcLogs({
				name: "raw",
				cwd: process.cwd(),
				mode: "recent",
				maxLineBytes: 0,
			});
			assert.equal(result.returnedCount, 1);
			assert.equal(result.events[0].ansiStripped, long);
		});
	});

	test("waitMs blocks until a matching event arrives", async () => {
		await withProcRoot(async () => {
			const { updateRunState } = await jiti.import(
				"../src/features/proc/store.ts",
			);
			const run = await createRun({
				name: "delayed",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: true,
			});
			await updateRunState(run.meta.runId, { status: "running" });
			setTimeout(async () => {
				await appendEvent(event(run.meta.runId, 0, "info", "warming up"));
				await appendEvent(
					event(run.meta.runId, 1, "info", "server ready on port 4242"),
				);
			}, 80);

			const started = Date.now();
			const result = await queryProcLogs({
				name: "delayed",
				cwd: process.cwd(),
				mode: "recent",
				contains: "ready on port",
				waitMs: 2000,
			});
			const elapsed = Date.now() - started;
			assert.equal(result.matchedCount, 1, result.summary);
			assert.equal(result.events[0].seq, 1);
			assert.ok(
				elapsed < 1500,
				`expected tailer to return well under 2s, got ${elapsed}ms`,
			);
			assert.match(result.summary, /after waiting \d+ms/);
		});
	});

	test("waitMs gives up cleanly when no match arrives", async () => {
		await withProcRoot(async () => {
			const { updateRunState } = await jiti.import(
				"../src/features/proc/store.ts",
			);
			const run = await createRun({
				name: "silent",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: true,
			});
			await updateRunState(run.meta.runId, { status: "running" });
			const started = Date.now();
			const result = await queryProcLogs({
				name: "silent",
				cwd: process.cwd(),
				mode: "recent",
				contains: "never-appears",
				waitMs: 200,
			});
			const elapsed = Date.now() - started;
			assert.equal(result.returnedCount, 0);
			assert.ok(
				elapsed >= 150,
				`expected to wait close to 200ms, got ${elapsed}ms`,
			);
			assert.match(result.summary, /waited \d+ms/);
		});
	});

	test("truncates over-long lines with marker", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "noisy",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: true,
			});
			const long = "x".repeat(2000);
			await appendEvent(event(run.meta.runId, 0, "info", long));
			const result = await queryProcLogs({
				name: "noisy",
				cwd: process.cwd(),
				mode: "recent",
				maxLineBytes: 128,
			});
			assert.equal(result.returnedCount, 1);
			assert.ok(result.events[0].ansiStripped.endsWith("…[truncated]"));
			assert.ok(result.events[0].ansiStripped.length <= 130);
		});
	});
});
