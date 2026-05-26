import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { classifyLine, detectUrls, stripAnsi } = await jiti.import(
	"../src/features/proc/classify.ts",
);

describe("proc log classification", () => {
	test("strips ansi sequences", () => {
		assert.equal(stripAnsi("\u001b[31mError\u001b[0m"), "Error");
	});

	test("classifies Error: header form", () => {
		const result = classifyLine("Error: Cannot find module '@/foo'");
		assert.equal(result.level, "error");
		assert.ok(result.tags.includes("module-not-found"));
	});

	test("classifies typed warnings", () => {
		const result = classifyLine("warning: deprecated API");
		assert.equal(result.level, "warn");
		assert.ok(result.tags.includes("warning"));
		assert.ok(result.tags.includes("deprecated"));
	});

	test("detects urls", () => {
		assert.deepEqual(detectUrls("ready at http://localhost:5173/"), [
			"http://localhost:5173/",
		]);
	});

	test("does not flag 'no errors' as error", () => {
		const result = classifyLine("✔ no errors found");
		assert.notEqual(result.level, "error");
	});

	test("does not flag '0 errors' as error", () => {
		const result = classifyLine("compiled successfully — 0 errors, 0 warnings");
		assert.notEqual(result.level, "error");
	});

	test("does not flag ErrorBoundary identifier as error", () => {
		const result = classifyLine("rendered <ErrorBoundary fallback={...}>");
		assert.notEqual(result.level, "error");
	});

	test("does not flag mentions in file paths as error", () => {
		const result = classifyLine("imported from src/lib/error-utils.ts");
		assert.notEqual(result.level, "error");
	});

	test("classifies Vite bundler error", () => {
		const result = classifyLine("[vite] internal server error: foo");
		assert.equal(result.level, "error");
		assert.ok(result.tags.includes("bundler"));
	});

	test("classifies TS error code", () => {
		const result = classifyLine(
			"src/app.tsx:12:3 - error TS2304: Cannot find name 'foo'.",
		);
		assert.equal(result.level, "error");
	});

	test("classifies Python traceback header", () => {
		const result = classifyLine("Traceback (most recent call last):");
		assert.equal(result.level, "error");
		assert.ok(result.tags.includes("traceback"));
	});

	test("classifies Go panic", () => {
		const result = classifyLine("panic: runtime error: index out of range");
		assert.equal(result.level, "error");
		assert.ok(result.tags.includes("panic"));
	});

	test("classifies EADDRINUSE", () => {
		const result = classifyLine(
			"Error: listen EADDRINUSE: address already in use :::3000",
		);
		assert.equal(result.level, "error");
		assert.ok(result.tags.includes("address-in-use"));
	});

	test("classifies stack frames as error level", () => {
		const result = classifyLine(
			"    at handler (file:///app/src/index.ts:12:5)",
		);
		assert.equal(result.level, "error");
	});

	test("user-supplied error pattern matches", () => {
		const result = classifyLine("FATAL_DB_LOSS occurred at 12:00", {
			errorPatterns: ["FATAL_DB_LOSS"],
		});
		assert.equal(result.level, "error");
		assert.ok(result.tags.includes("user-error"));
	});
});
