import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normaliseEventLine } = await jiti.import(
	"../src/features/proc/runner.ts",
);

describe("normaliseEventLine — storage-layer noise filters", () => {
	test("Gradle-style \\r progress redraws collapse to the final frame", () => {
		const line =
			"<====-----> 40% EXECUTING\r<=======--> 70% EXECUTING\r<==========> 100% DONE";
		const result = normaliseEventLine(line);
		assert.equal(result.persist, true);
		assert.equal(result.line, "<==========> 100% DONE");
	});

	test("collapseProgress: false keeps every intermediate frame on the line", () => {
		const line = "step1\rstep2\rstep3";
		const result = normaliseEventLine(line, { collapseProgress: false });
		assert.equal(result.persist, true);
		assert.equal(result.line, line);
	});

	test("pure ANSI cursor / clear-screen noise is dropped", () => {
		// ESC[2J = erase display; ESC[H = cursor home
		const line = "\u001b[2J\u001b[H\u001b[3J";
		const result = normaliseEventLine(line);
		assert.equal(result.persist, false);
	});

	test("ANSI-wrapped real content is kept", () => {
		const line = "\u001b[31mError: boom\u001b[0m";
		const result = normaliseEventLine(line);
		assert.equal(result.persist, true);
		assert.equal(result.line, line);
	});

	test("literal blank line (no ANSI) is preserved", () => {
		const result = normaliseEventLine("");
		assert.equal(result.persist, true);
		assert.equal(result.line, "");
	});

	test("literal whitespace-only line (no ANSI) is preserved", () => {
		const result = normaliseEventLine("   ");
		assert.equal(result.persist, true);
		assert.equal(result.line, "   ");
	});

	test("keepBlankLines: true keeps pure-ANSI redraw events too", () => {
		const line = "\u001b[2J";
		const result = normaliseEventLine(line, { keepBlankLines: true });
		assert.equal(result.persist, true);
	});

	test("progress collapse + ANSI cursor escape together drop cleanly", () => {
		// A spinner-style redraw: clear-line + carriage return + new frame
		const line = "loading...\r\u001b[2K\u001b[1G";
		// After \r collapse → "\u001b[2K\u001b[1G", which strips to ""
		const result = normaliseEventLine(line);
		assert.equal(result.persist, false);
	});

	test("Vite-style cursor-move noise (ANSI only after collapse) is dropped", () => {
		const line = "\u001b[H\u001b[2J\u001b[3J";
		const result = normaliseEventLine(line);
		assert.equal(result.persist, false);
	});
});
