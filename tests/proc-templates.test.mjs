import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { templateFor, tallyTemplates, sortedByCount, selectRare } =
	await jiti.import("../src/features/proc/templates.ts");

function evt(seq, line, level = "info") {
	return {
		ts: new Date(0).toISOString(),
		runId: "x",
		seq,
		stream: "stdout",
		level,
		line,
		ansiStripped: line,
		tags: [],
	};
}

describe("templateFor", () => {
	test("masks generic decimal numbers (with optional unit) as <N>", () => {
		assert.equal(
			templateFor("Request 42 took 100ms"),
			"Request <N> took <N>",
		);
	});

	test("identical templates for the same shape with different values", () => {
		// Different numbers AND different unit suffixes still bucket together.
		assert.equal(
			templateFor("Request 42 took 100ms"),
			templateFor("Request 999 took 5s"),
		);
	});

	test("masks UUIDs", () => {
		assert.equal(
			templateFor("session 4d8f5d7b-7fa3-4d1e-9f3a-1abcde123456 opened"),
			"session <UUID> opened",
		);
	});

	test("masks ISO timestamps", () => {
		const t = templateFor("[2024-01-15T08:30:00Z] hello world");
		assert.equal(t.includes("2024"), false);
		assert.equal(t.includes("<TS>"), true);
	});

	test("masks URLs", () => {
		assert.equal(
			templateFor("connecting to https://api.example.com/v1/foo"),
			"connecting to <URL>",
		);
	});

	test("masks single-quoted and double-quoted strings", () => {
		assert.equal(templateFor('path "/tmp/foo" missing'), "path <STR> missing");
		assert.equal(templateFor("path 'a' missing"), "path <STR> missing");
	});

	test("truncates to first 8 tokens after masking", () => {
		const long = "a b c d e f g h i j k l";
		assert.equal(templateFor(long), "a b c d e f g h");
	});
});

describe("tallyTemplates", () => {
	test("counts identical templates together", () => {
		const events = [
			evt(1, "Request 1 took 10ms"),
			evt(2, "Request 2 took 30ms"),
			evt(3, "Request 3 took 50ms"),
			evt(4, "Unique error happened here"),
		];
		const buckets = tallyTemplates(events);
		const req = buckets.get(templateFor("Request 1 took 10ms"));
		assert.equal(req.count, 3);
		assert.equal(req.firstSeq, 1);
		assert.equal(req.lastSeq, 3);
		assert.equal(buckets.size, 2);
	});

	test("level rolls up to the highest seen", () => {
		const buckets = tallyTemplates([
			evt(1, "Request 1 ok", "info"),
			evt(2, "Request 2 ok", "warn"),
			evt(3, "Request 3 ok", "error"),
		]);
		const only = Array.from(buckets.values())[0];
		assert.equal(only.level, "error");
	});
});

describe("sortedByCount + selectRare", () => {
	const events = [
		evt(1, "common message N=1"),
		evt(2, "common message N=2"),
		evt(3, "common message N=3"),
		evt(4, "common message N=4"),
		evt(5, "rare message foo"),
		evt(6, "rare message bar"),
		evt(7, "unique alpha beta"),
	];
	const buckets = tallyTemplates(events);

	test("sortedByCount returns highest-count templates first", () => {
		const sorted = sortedByCount(buckets.values());
		assert.equal(sorted[0].count, 4);
		assert.equal(sorted[sorted.length - 1].count, 1);
	});

	test("selectRare returns events with templates appearing ≤ N times", () => {
		const rare = selectRare(events, buckets, 2);
		// "rare message X" appears twice, "unique alpha beta" appears once.
		// "common message N=X" appears 4 times — excluded.
		const seqs = rare.map((e) => e.seq);
		assert.deepEqual(seqs.sort(), [5, 6, 7]);
	});
});
