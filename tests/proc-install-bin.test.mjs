import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { posixShim, windowsShim, quoteForCmd, isOnPath, pathAddHint } =
	await jiti.import("../src/features/proc/install-bin.ts");

describe("posixShim", () => {
	test("starts with env-node shebang", () => {
		const shim = posixShim("/home/alice/.pi/pkg/bin/pi-proc.mjs");
		assert.ok(shim.startsWith("#!/usr/bin/env node\n"));
	});

	test("embeds the cli path as a JSON-escaped file:// URL", () => {
		const cliPath = "/home/alice/weird path/pi-proc.mjs";
		const shim = posixShim(cliPath);
		assert.ok(
			shim.includes(JSON.stringify(`file://${cliPath}`)),
			`shim did not contain expected import target: ${shim}`,
		);
	});
});

describe("windowsShim / quoteForCmd", () => {
	test("emits exact batch line for a vanilla path", () => {
		const shim = windowsShim("C:\\Users\\alice\\.pi\\pi-proc.mjs");
		assert.equal(
			shim,
			'@echo off\r\nnode "C:\\Users\\alice\\.pi\\pi-proc.mjs" %*\r\n',
		);
	});

	test("uses CRLF line endings", () => {
		const shim = windowsShim("C:\\foo\\pi-proc.mjs");
		assert.ok(shim.includes("\r\n"));
		// No bare LF that isn't part of a CRLF.
		assert.equal(shim.replace(/\r\n/g, "").includes("\n"), false);
	});

	test("escapes % to %% so cmd does not expand variables", () => {
		const shim = windowsShim("C:\\Users\\50%off\\bin\\pi-proc.mjs");
		assert.ok(
			shim.includes('"C:\\Users\\50%%off\\bin\\pi-proc.mjs"'),
			`shim did not escape %: ${shim}`,
		);
	});

	test("quoteForCmd throws on illegal characters", () => {
		for (const bad of ['"', "\r", "\n", "\0"]) {
			assert.throws(
				() => quoteForCmd(`C:\\foo${bad}bar`),
				/illegal character/,
				`expected throw for char: ${JSON.stringify(bad)}`,
			);
		}
	});

	test("quoteForCmd accepts ordinary Windows-legal characters", () => {
		// & ^ ( ) ' space — all legal in NTFS names and safe inside "…" in cmd
		// (none of them are special when not concatenating commands).
		const out = quoteForCmd("C:\\Program Files (x86)\\foo's app\\pi-proc.mjs");
		assert.equal(
			out,
			'"C:\\Program Files (x86)\\foo\'s app\\pi-proc.mjs"',
		);
	});
});

describe("isOnPath", () => {
	test("exact match returns true (posix branch)", () => {
		// The win32 branch is only taken when process.platform === "win32";
		// on this host we exercise the POSIX path. The case-insensitive Windows
		// branch is a single toLowerCase() and is left to manual verification
		// on a Windows host.
		assert.equal(
			isOnPath("/home/alice/.pi/bin", [
				"/usr/bin",
				"/home/alice/.pi/bin",
				"/usr/local/bin",
			]),
			true,
		);
	});

	test("no match returns false", () => {
		assert.equal(
			isOnPath("/home/alice/.pi/bin", ["/usr/bin", "/usr/local/bin"]),
			false,
		);
	});
});

describe("pathAddHint", () => {
	test("posix form mentions export PATH", () => {
		// Only the posix branch is reachable on this host; the Windows branch
		// is verified by reading the source and is exercised manually on a
		// Windows install.
		if (process.platform === "win32") return;
		const hint = pathAddHint("/home/alice/.pi/bin");
		assert.match(hint, /export PATH=/);
		assert.ok(hint.includes("/home/alice/.pi/bin"));
	});
});
