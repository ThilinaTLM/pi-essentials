import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { renderListTable, listToJson, formatDuration } = await jiti.import(
	"../src/features/proc/cli/format-list.ts",
);

function fakeRun(overrides = {}) {
	const base = {
		meta: {
			runId: "20260524T120000-aabbcc",
			name: "demo",
			cwd: "/home/alice/work/proj",
			command: "node server.js",
			argv: ["node", "server.js"],
			shell: false,
			startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
			logDir: "/tmp/log",
			foreground: false,
			forceColor: false,
		},
		state: {
			status: "running",
			supervisorPid: 100,
			childPid: 200,
			lastEventAt: null,
			exitCode: null,
			signal: null,
			endedAt: null,
			detectedUrls: ["http://localhost:5173/"],
			ptyMode: "pty",
			readyAt: null,
		},
	};
	return {
		...base,
		...overrides,
		meta: { ...base.meta, ...(overrides.meta ?? {}) },
		state: { ...base.state, ...(overrides.state ?? {}) },
	};
}

describe("formatDuration", () => {
	test("seconds < 60", () => {
		assert.equal(formatDuration(0), "0s");
		assert.equal(formatDuration(15_000), "15s");
		assert.equal(formatDuration(59_999), "59s");
	});
	test("minutes < 60", () => {
		assert.equal(formatDuration(60_000), "1m");
		assert.equal(formatDuration(45 * 60_000), "45m");
	});
	test("hours with optional minute remainder", () => {
		assert.equal(formatDuration(60 * 60_000), "1h");
		assert.equal(formatDuration(2 * 60 * 60_000 + 15 * 60_000), "2h15m");
	});
	test("days with optional hour remainder", () => {
		assert.equal(formatDuration(24 * 60 * 60_000), "1d");
		assert.equal(
			formatDuration(2 * 24 * 60 * 60_000 + 5 * 60 * 60_000),
			"2d5h",
		);
	});
});

describe("renderListTable", () => {
	test("empty result returns sentinel string", () => {
		assert.equal(renderListTable([]), "No runs found.");
	});

	test("groups active above terminated when group=true (default)", () => {
		const active = fakeRun();
		const terminated = fakeRun({
			meta: { runId: "20260523T120000-zzzzzz", name: "old" },
			state: {
				status: "exited",
				exitCode: 0,
				endedAt: new Date(Date.now() - 60_000).toISOString(),
			},
		});
		const out = renderListTable([active, terminated]);
		const activeIdx = out.indexOf("# Active");
		const termIdx = out.indexOf("# Terminated");
		assert.notEqual(activeIdx, -1);
		assert.notEqual(termIdx, -1);
		assert.ok(activeIdx < termIdx);
	});

	test("ungrouped form omits section headers", () => {
		const out = renderListTable([fakeRun()], { group: false });
		assert.equal(out.includes("# Active"), false);
		assert.equal(out.includes("# Terminated"), false);
	});

	test("includes the new AGE / EXIT / URL columns", () => {
		const out = renderListTable([fakeRun()]);
		assert.match(out, /AGE/);
		assert.match(out, /EXIT/);
		assert.match(out, /URL/);
	});
});

describe("listToJson", () => {
	test("emits structured rows with the expected shape", () => {
		const json = listToJson([fakeRun()]);
		assert.equal(json.runs.length, 1);
		const row = json.runs[0];
		assert.equal(row.runId, "20260524T120000-aabbcc");
		assert.equal(row.name, "demo");
		assert.equal(row.status, "running");
		assert.equal(row.command, "node server.js");
		assert.equal(row.exitCode, null);
		assert.equal(row.pid, 200);
		assert.deepEqual(row.urls, ["http://localhost:5173/"]);
		assert.ok(row.ageMs >= 0);
	});

	test("name is null when missing (not undefined)", () => {
		const json = listToJson([
			fakeRun({ meta: { name: undefined } }),
		]);
		assert.equal(json.runs[0].name, null);
	});
});
