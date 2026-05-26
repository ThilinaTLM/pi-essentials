import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseOnExitPolicy } = await jiti.import(
	"../src/features/proc/cli/cmd-start.ts",
);

describe("parseOnExitPolicy", () => {
	test("undefined input returns undefined", () => {
		assert.equal(parseOnExitPolicy(undefined), undefined);
	});

	test("\"none\" returns { kind: 'none' }", () => {
		assert.deepEqual(parseOnExitPolicy("none"), { kind: "none" });
	});

	test("bare 'restart' returns kind only", () => {
		assert.deepEqual(parseOnExitPolicy("restart"), { kind: "restart" });
	});

	test("restart:max=N parses count", () => {
		assert.deepEqual(parseOnExitPolicy("restart:max=7"), {
			kind: "restart",
			max: 7,
		});
	});

	test("restart with multiple opts", () => {
		const policy = parseOnExitPolicy("restart:max=3,backoff=500ms");
		assert.deepEqual(policy, {
			kind: "restart",
			max: 3,
			backoffMs: 500,
		});
	});

	test("backoff supports ms/s/m/h suffixes", () => {
		assert.equal(parseOnExitPolicy("restart:backoff=2s").backoffMs, 2000);
		assert.equal(parseOnExitPolicy("restart:backoff=1m").backoffMs, 60_000);
		assert.equal(parseOnExitPolicy("restart:backoff=500").backoffMs, 500);
	});

	test("rejects unknown keys", () => {
		assert.throws(() => parseOnExitPolicy("restart:bogus=5"), /Unknown/);
	});

	test("rejects garbage", () => {
		assert.throws(() => parseOnExitPolicy("garbage"), /none.*restart/);
	});
});
