import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { matchesGlob } = await jiti.import("../src/features/proc/glob.ts");

describe("globToRegex / matchesGlob", () => {
	test("literal match", () => {
		assert.equal(matchesGlob("build", "build"), true);
		assert.equal(matchesGlob("build", "build-1"), false);
	});

	test("* matches any run including empty", () => {
		assert.equal(matchesGlob("build*", "build"), true);
		assert.equal(matchesGlob("build*", "build-1"), true);
		assert.equal(matchesGlob("build*", "buildxyz"), true);
		assert.equal(matchesGlob("*-test", "api-test"), true);
		assert.equal(matchesGlob("*-test", "test"), false);
	});

	test("? matches exactly one character", () => {
		assert.equal(matchesGlob("build-?", "build-1"), true);
		assert.equal(matchesGlob("build-?", "build-12"), false);
		assert.equal(matchesGlob("build-?", "build-"), false);
	});

	test("anchors to the full string", () => {
		assert.equal(matchesGlob("build", "build-1"), false);
		assert.equal(matchesGlob("build", "prefix-build"), false);
	});

	test("regex specials in the pattern are escaped", () => {
		// "." should be a literal dot, not "any char".
		assert.equal(matchesGlob("foo.bar", "fooXbar"), false);
		assert.equal(matchesGlob("foo.bar", "foo.bar"), true);
		// "+" and "(" should not crash.
		assert.equal(matchesGlob("a+b", "a+b"), true);
		assert.equal(matchesGlob("(x)", "(x)"), true);
	});
});
