import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createRun, listRuns, isCwdMatch, _resetSchemaCache } =
	await jiti.import("../src/features/proc/store.ts");

async function withProcRoot(fn) {
	const dir = mkdtempSync(join(tmpdir(), "pi-proc-store-"));
	const old = process.env.PI_PROC_DIR;
	process.env.PI_PROC_DIR = dir;
	_resetSchemaCache();
	try {
		await fn(dir);
	} finally {
		if (old === undefined) delete process.env.PI_PROC_DIR;
		else process.env.PI_PROC_DIR = old;
		_resetSchemaCache();
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("proc store cwd filtering", () => {
	test("isCwdMatch handles identity, descendants, siblings", () => {
		assert.equal(isCwdMatch("/foo/bar", "/foo/bar"), true);
		assert.equal(isCwdMatch("/foo/bar/baz", "/foo/bar"), true);
		assert.equal(isCwdMatch("/foo/bar/web/api", "/foo/bar"), true);
		assert.equal(isCwdMatch("/foo/barbaz", "/foo/bar"), false);
		assert.equal(isCwdMatch("/foo", "/foo/bar"), false);
		assert.equal(isCwdMatch("/other/path", "/foo/bar"), false);
	});

	test("exact mode requires literal equality", () => {
		assert.equal(isCwdMatch("/foo/bar", "/foo/bar", "exact"), true);
		assert.equal(isCwdMatch("/foo/bar/baz", "/foo/bar", "exact"), false);
	});

	test("listRuns descendant mode surfaces subproject runs", async () => {
		await withProcRoot(async (dir) => {
			const projects = join(dir, "Projects");
			const webApp = join(projects, "monorepo", "web-app");
			const api = join(projects, "monorepo", "api");
			const other = join(projects, "unrelated");

			await createRun({
				name: "web",
				cwd: webApp,
				command: "node",
				argv: ["node"],
				foreground: false,
			});
			await createRun({
				name: "api",
				cwd: api,
				command: "node",
				argv: ["node"],
				foreground: false,
			});
			await createRun({
				name: "other",
				cwd: other,
				command: "node",
				argv: ["node"],
				foreground: false,
			});

			const fromMonorepo = await listRuns({
				cwd: join(projects, "monorepo"),
			});
			assert.deepEqual(fromMonorepo.map((r) => r.meta.name).sort(), [
				"api",
				"web",
			]);

			const fromProjects = await listRuns({ cwd: projects });
			assert.equal(fromProjects.length, 3);

			const fromUnrelated = await listRuns({ cwd: other });
			assert.deepEqual(
				fromUnrelated.map((r) => r.meta.name),
				["other"],
			);
		});
	});

	test("listRuns exact mode only matches literal cwd", async () => {
		await withProcRoot(async (dir) => {
			const root = join(dir, "proj");
			const sub = join(root, "sub");

			await createRun({
				name: "root-run",
				cwd: root,
				command: "node",
				argv: ["node"],
				foreground: false,
			});
			await createRun({
				name: "sub-run",
				cwd: sub,
				command: "node",
				argv: ["node"],
				foreground: false,
			});

			const exact = await listRuns({ cwd: root, cwdMode: "exact" });
			assert.deepEqual(
				exact.map((r) => r.meta.name),
				["root-run"],
			);

			const descendant = await listRuns({ cwd: root });
			assert.equal(descendant.length, 2);
		});
	});
});
