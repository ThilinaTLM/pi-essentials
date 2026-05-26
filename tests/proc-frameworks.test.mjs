import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	detectFramework,
	matchesAutoReady,
	UNKNOWN_PROFILE,
	AUTO_READY_PATTERNS,
} = await jiti.import("../src/features/proc/frameworks.ts");

describe("detectFramework", () => {
	test("identifies Vite from the version banner", () => {
		const profile = detectFramework(["  VITE v5.0.0  ready in 312 ms", ""]);
		assert.equal(profile.id, "vite");
	});

	test("identifies Next.js from the banner", () => {
		const profile = detectFramework([
			"   ▲ Next.js 14.2.5",
			"   - Local:        http://localhost:3000",
		]);
		assert.equal(profile.id, "next");
	});

	test("identifies cargo from Compiling ...", () => {
		const profile = detectFramework([
			"   Compiling pi-proc-shim v0.1.0 (/work)",
			"    Finished `dev` profile [unoptimized + debuginfo] target(s)",
		]);
		assert.equal(profile.id, "cargo");
	});

	test("identifies pytest from the session header", () => {
		const profile = detectFramework([
			"========================= test session starts ==========================",
			"platform linux -- Python 3.11.4, pytest-7.4.0",
		]);
		assert.equal(profile.id, "pytest");
	});

	test("identifies Maven", () => {
		const profile = detectFramework([
			"[INFO] Scanning for projects...",
			"[INFO] ---< com.example:app >---",
		]);
		assert.equal(profile.id, "maven");
	});

	test("falls back to unknown for random output", () => {
		const profile = detectFramework([
			"foo",
			"bar",
			"some random line nothing matches",
		]);
		assert.equal(profile.id, UNKNOWN_PROFILE.id);
	});
});

describe("matchesAutoReady", () => {
	test("matches generic ready signals", () => {
		assert.equal(matchesAutoReady("Local:  http://localhost:5173/"), true);
		assert.equal(matchesAutoReady("ready in 184ms"), true);
		assert.equal(matchesAutoReady("Listening on port 3000"), true);
		assert.equal(matchesAutoReady("compiled successfully"), true);
	});

	test("does not match unrelated output", () => {
		assert.equal(matchesAutoReady("doing some work..."), false);
		assert.equal(matchesAutoReady("ERROR: failed to compile"), false);
	});

	test("includes framework-specific patterns when a profile is provided", () => {
		const vite = detectFramework(["  VITE v5.0.0"]);
		// Vite-specific "Local:..." matches the generic auto-ready already,
		// but verify the wiring still answers true.
		assert.equal(
			matchesAutoReady("  Local:   http://localhost:5173/", vite),
			true,
		);
	});
});

describe("AUTO_READY_PATTERNS", () => {
	test("is a non-empty array of regexes", () => {
		assert.ok(Array.isArray(AUTO_READY_PATTERNS));
		assert.ok(AUTO_READY_PATTERNS.length > 0);
		for (const pat of AUTO_READY_PATTERNS) {
			assert.ok(pat instanceof RegExp);
		}
	});
});
