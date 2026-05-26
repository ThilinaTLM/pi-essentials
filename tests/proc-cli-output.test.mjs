import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { visibleWidth, padEndVisible, padStartVisible } = await jiti.import(
	"../src/features/proc/cli/output.ts",
);
const { CliError, formatCliError } = await jiti.import(
	"../src/features/proc/cli/errors.ts",
);
const { suggest, didYouMean } = await jiti.import(
	"../src/features/proc/cli/suggest.ts",
);

describe("visibleWidth / padEndVisible", () => {
	test("strips ANSI before measuring", () => {
		assert.equal(visibleWidth("\u001b[31mhello\u001b[0m"), 5);
		assert.equal(visibleWidth("plain"), 5);
		assert.equal(visibleWidth(""), 0);
	});

	test("padEndVisible pads to visible width even with color", () => {
		const colored = "\u001b[31mhi\u001b[0m";
		assert.equal(padEndVisible(colored, 5), `${colored}   `);
		assert.equal(padEndVisible("hi", 5), "hi   ");
		// Already at or over width: no padding.
		assert.equal(padEndVisible("longer", 3), "longer");
	});

	test("padStartVisible pads to visible width even with color", () => {
		const colored = "\u001b[32mok\u001b[0m";
		assert.equal(padStartVisible(colored, 5), `   ${colored}`);
		assert.equal(padStartVisible("ok", 5), "   ok");
	});
});

describe("CliError + formatCliError", () => {
	test("CliError with hint renders both lines", () => {
		const err = new CliError("no run matches foo", "did you mean: bar?");
		const { message, exitCode } = formatCliError(err);
		assert.equal(exitCode, 1);
		assert.match(message, /Error:\s*no run matches foo/);
		assert.match(message, /Hint:\s*did you mean: bar\?/);
	});

	test("CliError without hint renders only the error line", () => {
		const err = new CliError("missing target");
		const { message } = formatCliError(err);
		assert.match(message, /Error:\s*missing target/);
		assert.doesNotMatch(message, /Hint:/);
	});

	test("CliError carries through custom exit code", () => {
		const err = new CliError("bad cmd", undefined, 2);
		assert.equal(formatCliError(err).exitCode, 2);
	});

	test("Generic Error preserves stack trace", () => {
		const err = new Error("boom");
		const { message, exitCode } = formatCliError(err);
		assert.equal(exitCode, 1);
		// Stack always starts with the type+message.
		assert.match(message, /^Error: boom/);
		// And contains at least one stack frame indicator.
		assert.match(message, /\s+at\s+/);
	});

	test("Non-Error inputs stringify safely", () => {
		const { message, exitCode } = formatCliError("plain string");
		assert.equal(exitCode, 1);
		assert.equal(message, "plain string");
	});
});

describe("suggest + didYouMean", () => {
	const subcommands = [
		"run",
		"start",
		"attach",
		"tail",
		"logs",
		"list",
		"stop",
		"restart",
		"prune",
		"reconcile",
	];

	test("returns close matches sorted by distance", () => {
		// With the default maxDistance of 3, short subcommands have several
		// candidates within range — we just care that the closest is first.
		assert.equal(suggest("lst", subcommands)[0], "list");
		assert.equal(suggest("strt", subcommands)[0], "start");
		// Tighter threshold narrows it to a single candidate.
		assert.deepEqual(suggest("lst", subcommands, { maxDistance: 1 }), [
			"list",
		]);
	});

	test("returns empty when nothing is close enough", () => {
		assert.deepEqual(suggest("zzzzzzz", subcommands), []);
	});

	test("respects cap", () => {
		// Both "tail" and "list" are distance 2 from "tist".
		const result = suggest("tist", subcommands, { cap: 1 });
		assert.equal(result.length, 1);
	});

	test("didYouMean shapes the hint correctly", () => {
		assert.equal(didYouMean([]), undefined);
		assert.equal(didYouMean(["list"]), 'Did you mean "list"?');
		assert.equal(
			didYouMean(["list", "tail"]),
			'Did you mean one of: "list", "tail"?',
		);
	});
});
