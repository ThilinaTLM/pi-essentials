import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { coalesceIncidents, iterateIncidents, MAX_INCIDENT_LINES } =
	await jiti.import("../src/features/proc/incidents.ts");
const { classifyLine } = await jiti.import(
	"../src/features/proc/classify.ts",
);

let seqCounter = 0;
function evt(line) {
	seqCounter++;
	const classified = classifyLine(line);
	return {
		ts: new Date(seqCounter * 1000).toISOString(),
		runId: "x",
		seq: seqCounter,
		stream: "stdout",
		level: classified.level,
		line,
		ansiStripped: classified.ansiStripped,
		tags: classified.tags,
	};
}

function resetSeq() {
	seqCounter = 0;
}

describe("coalesceIncidents", () => {
	test("a single error line becomes a 1-member incident", () => {
		resetSeq();
		const events = [
			evt("doing some work"),
			evt("Error: bad thing happened"),
			evt("doing more work"),
		];
		const incidents = coalesceIncidents(events);
		assert.equal(incidents.length, 1);
		assert.equal(incidents[0].members.length, 1);
		assert.equal(incidents[0].header.seq, 2);
	});

	test("error + JS stack frames collected together", () => {
		resetSeq();
		const events = [
			evt("starting"),
			evt("Error: cannot find module"),
			evt("    at Object.<anonymous> (/app/index.js:12:3)"),
			evt("    at Module._compile (node:internal/modules/cjs/loader:1126:14)"),
			evt("    at Module.load (node:internal/modules/cjs/loader:988:32)"),
			evt("continuing normally"),
		];
		const incidents = coalesceIncidents(events);
		assert.equal(incidents.length, 1);
		assert.equal(incidents[0].members.length, 4);
		assert.equal(incidents[0].header.seq, 2);
		assert.equal(incidents[0].endSeq, 5);
	});

	test("Python traceback header + indented frames + exception line", () => {
		resetSeq();
		const events = [
			evt("Traceback (most recent call last):"),
			evt('  File "/app/main.py", line 12, in <module>'),
			evt("    do_thing()"),
			evt('  File "/app/thing.py", line 4, in do_thing'),
			evt("    raise ValueError('boom')"),
			evt("done"),
		];
		const incidents = coalesceIncidents(events);
		assert.equal(incidents.length, 1);
		assert.ok(incidents[0].members.length >= 2);
	});

	test("two unrelated errors produce two incidents", () => {
		resetSeq();
		const events = [
			evt("Error: first"),
			evt("normal line"),
			evt("Error: second"),
			evt("normal line"),
		];
		const incidents = coalesceIncidents(events);
		assert.equal(incidents.length, 2);
		assert.equal(incidents[0].header.ansiStripped, "Error: first");
		assert.equal(incidents[1].header.ansiStripped, "Error: second");
	});

	test("non-error events outside incidents are dropped", () => {
		resetSeq();
		const events = [
			evt("plain"),
			evt("more plain"),
			evt("info: nothing wrong"),
		];
		const incidents = coalesceIncidents(events);
		assert.equal(incidents.length, 0);
	});

	test("MAX_INCIDENT_LINES caps runaway frames", () => {
		resetSeq();
		const events = [evt("Error: too much")];
		for (let i = 0; i < MAX_INCIDENT_LINES + 50; i++) {
			events.push(evt(`    at frame${i} (file.js:${i}:1)`));
		}
		const incidents = coalesceIncidents(events);
		assert.equal(incidents.length, 1);
		assert.equal(incidents[0].members.length, MAX_INCIDENT_LINES);
	});

	test("fingerprint is stable across calls for the same shape", () => {
		resetSeq();
		const a = coalesceIncidents([evt("Error: foo 42")]);
		resetSeq();
		const b = coalesceIncidents([evt("Error: foo 999")]);
		assert.equal(a[0].fingerprint, b[0].fingerprint);
	});
});

describe("iterateIncidents", () => {
	test("yields incidents lazily over an async source", async () => {
		resetSeq();
		const events = [
			evt("starting"),
			evt("Error: a"),
			evt("    at f (x.js:1:1)"),
			evt("ok"),
			evt("Error: b"),
		];
		async function* source() {
			for (const e of events) yield e;
		}
		const seen = [];
		for await (const inc of iterateIncidents(source())) seen.push(inc);
		assert.equal(seen.length, 2);
		assert.equal(seen[0].members.length, 2);
		assert.equal(seen[1].members.length, 1);
	});
});
