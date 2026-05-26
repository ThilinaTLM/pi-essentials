import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, after, describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

// Use a sandboxed proc root so we don't touch the user's real ~/.pi/proc.
let root;
process.env.PI_PROC_DIR = "/tmp/pi-proc-test-modes-placeholder";

const { queryProcLogs } = await jiti.import("../src/features/proc/query.ts");
const { createRun, _resetSchemaCache } = await jiti.import(
	"../src/features/proc/store.ts",
);
const { appendEvent } = await jiti.import(
	"../src/features/proc/log-segments.ts",
);
const { classifyLine } = await jiti.import(
	"../src/features/proc/classify.ts",
);

async function makeRun(lines) {
	const run = await createRun({
		cwd: process.cwd(),
		command: "node test.js",
		argv: ["node", "test.js"],
		shell: false,
		foreground: false,
	});
	let seq = 0;
	for (const line of lines) {
		const classified = classifyLine(line);
		seq++;
		await appendEvent({
			ts: new Date(seq * 1000).toISOString(),
			runId: run.meta.runId,
			seq,
			stream: "stdout",
			level: classified.level,
			line,
			ansiStripped: classified.ansiStripped,
			tags: classified.tags,
		});
	}
	return run;
}

before(async () => {
	root = await mkdtemp(path.join(tmpdir(), "pi-proc-test-modes-"));
	process.env.PI_PROC_DIR = root;
	_resetSchemaCache();
});

after(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});

describe("queryProcLogs smart modes", () => {
	test("mode: 'first_failure' returns first incident + preceding context", async () => {
		const run = await makeRun([
			"line 1",
			"line 2",
			"line 3 (context)",
			"Error: boom",
			"    at fn (file.js:1:1)",
			"recovering",
			"Error: second incident",
		]);
		const result = await queryProcLogs({
			runId: run.meta.runId,
			mode: "first_failure",
			contextLines: 2,
		});
		assert.equal(result.matchedCount, 1);
		assert.equal(result.incidents.length, 1);
		const seqs = result.events.map((e) => e.seq).sort((a, b) => a - b);
		// 2 lines of context (3, 4 are wrong — context comes BEFORE incident)
		// Header at seq 4, members 4 and 5. contextLines=2 → seqs 2,3 precede.
		assert.deepEqual(seqs, [2, 3, 4, 5]);
	});

	test("mode: 'incidents' returns every incident bounded by limit", async () => {
		const run = await makeRun([
			"info",
			"Error: a",
			"normal",
			"Error: b",
			"normal",
			"Error: c",
		]);
		const result = await queryProcLogs({
			runId: run.meta.runId,
			mode: "incidents",
			limit: 100,
		});
		assert.equal(result.matchedCount, 3);
		assert.equal(result.incidents.length, 3);
	});

	test("mode: 'templates' returns aggregated buckets", async () => {
		const run = await makeRun([
			"Request 1 took 5ms",
			"Request 2 took 9ms",
			"Request 3 took 7ms",
			"Unique alpha",
		]);
		const result = await queryProcLogs({
			runId: run.meta.runId,
			mode: "templates",
			limit: 100,
		});
		assert.equal(result.events.length, 0);
		assert.ok(result.templates);
		// "Request <N> took <N>ms" + "Unique alpha" = 2 buckets.
		assert.equal(result.templates.length, 2);
		assert.equal(result.templates[0].count, 3);
		assert.equal(result.templates[1].count, 1);
	});

	test("mode: 'rare' returns events whose template count ≤ threshold", async () => {
		const run = await makeRun([
			"common N=1",
			"common N=2",
			"common N=3",
			"rare alpha",
			"rare beta",
			"unique gamma",
		]);
		const result = await queryProcLogs({
			runId: run.meta.runId,
			mode: "rare",
			rareThreshold: 2,
		});
		// "common N=X" appears 3x (excluded), "rare X" twice (included),
		// "unique gamma" once (included).
		const seqs = result.events.map((e) => e.seq).sort((a, b) => a - b);
		assert.deepEqual(seqs, [4, 5, 6]);
	});
});
