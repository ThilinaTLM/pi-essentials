import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createRun, _resetSchemaCache, eventsPath } = await jiti.import(
	"../src/features/proc/store.ts",
);
const {
	appendEvent,
	iterateEvents,
	loadSegmentsIndex,
	maybeRotate,
	activeSegmentSize,
} = await jiti.import("../src/features/proc/log-segments.ts");

async function withProcRoot(fn) {
	const dir = mkdtempSync(join(tmpdir(), "pi-proc-test-"));
	const old = process.env.PI_PROC_DIR;
	const oldRotate = process.env.PI_PROC_ROTATE_BYTES;
	process.env.PI_PROC_DIR = dir;
	process.env.PI_PROC_ROTATE_BYTES = "512";
	_resetSchemaCache();
	try {
		await fn(dir);
	} finally {
		if (old === undefined) delete process.env.PI_PROC_DIR;
		else process.env.PI_PROC_DIR = old;
		if (oldRotate === undefined) delete process.env.PI_PROC_ROTATE_BYTES;
		else process.env.PI_PROC_ROTATE_BYTES = oldRotate;
		_resetSchemaCache();
		rmSync(dir, { recursive: true, force: true });
	}
}

function event(runId, seq, level, line) {
	return {
		ts: new Date(Date.now() + seq * 100).toISOString(),
		runId,
		seq,
		stream: "stdout",
		level,
		line,
		ansiStripped: line,
		tags: [],
	};
}

describe("proc log segments", () => {
	test("rotates events when exceeding threshold", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "rot",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: true,
			});
			// Fill the active segment past the 512-byte threshold.
			for (let i = 0; i < 20; i++)
				await appendEvent(
					event(run.meta.runId, i, "info", `line ${i} ${"x".repeat(40)}`),
				);
			const sizeBefore = await activeSegmentSize(run.meta.runId, "events");
			assert.ok(sizeBefore >= 512);
			const rotated = await maybeRotate(run.meta.runId, "events", {
				firstSeq: 0,
				lastSeq: 19,
				firstTs: null,
				lastTs: null,
				bytes: sizeBefore,
			});
			assert.equal(rotated, true);
			const index = await loadSegmentsIndex(run.meta.runId);
			assert.equal(index.segments.length, 1);
			assert.equal(index.segments[0].kind, "events");
			// Iterate should yield events from the rotated segment.
			const collected = [];
			for await (const ev of iterateEvents(run.meta.runId)) collected.push(ev);
			assert.equal(collected.length, 20);
		});
	});

	test("iterateEvents respects sinceSeq across segments", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "rot2",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: true,
			});
			for (let i = 0; i < 30; i++)
				await appendEvent(
					event(run.meta.runId, i, "info", `event-${i} ${"y".repeat(30)}`),
				);
			await maybeRotate(run.meta.runId, "events", {
				firstSeq: 0,
				lastSeq: 29,
				firstTs: null,
				lastTs: null,
				bytes: await activeSegmentSize(run.meta.runId, "events"),
			});
			// Add fresh events to the new active segment.
			for (let i = 30; i < 40; i++)
				await appendEvent(event(run.meta.runId, i, "info", `event-${i}`));
			const collected = [];
			for await (const ev of iterateEvents(run.meta.runId, { sinceSeq: 25 }))
				collected.push(ev.seq);
			assert.deepEqual(
				collected,
				[26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39],
			);
		});
	});

	test("handles corrupt lines without crashing", async () => {
		await withProcRoot(async () => {
			const run = await createRun({
				name: "bad",
				cwd: process.cwd(),
				command: "node",
				argv: ["node"],
				foreground: true,
			});
			const filePath = eventsPath(run.meta.runId);
			writeFileSync(
				filePath,
				`${JSON.stringify(event(run.meta.runId, 0, "info", "good"))}\nnot-json\n${JSON.stringify(event(run.meta.runId, 1, "info", "also good"))}\n`,
			);
			const collected = [];
			for await (const ev of iterateEvents(run.meta.runId))
				collected.push(ev.ansiStripped);
			assert.deepEqual(collected, ["good", "also good"]);
		});
	});
});
