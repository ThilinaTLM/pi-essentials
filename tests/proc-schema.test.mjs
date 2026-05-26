import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { ensureSchemaVersion, _resetSchemaCache, SCHEMA_VERSION } =
	await jiti.import("../src/features/proc/store.ts");

function withRoot(fn) {
	const dir = mkdtempSync(join(tmpdir(), "pi-proc-schema-"));
	const old = process.env.PI_PROC_DIR;
	process.env.PI_PROC_DIR = dir;
	_resetSchemaCache();
	try {
		return Promise.resolve(fn(dir)).finally(() => {
			if (old === undefined) delete process.env.PI_PROC_DIR;
			else process.env.PI_PROC_DIR = old;
			_resetSchemaCache();
			rmSync(dir, { recursive: true, force: true });
			// Also drop any sibling .bak.* dirs the schema check created.
			for (const sibling of readdirSync(dirname(dir)).filter((n) =>
				n.startsWith(`${dir.split("/").pop()}.bak.`),
			))
				rmSync(join(dirname(dir), sibling), { recursive: true, force: true });
		});
	} catch (error) {
		if (old === undefined) delete process.env.PI_PROC_DIR;
		else process.env.PI_PROC_DIR = old;
		_resetSchemaCache();
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

describe("proc schema version", () => {
	test("creates a fresh root when missing", async () => {
		await withRoot(async (dir) => {
			rmSync(dir, { recursive: true, force: true });
			const result = await ensureSchemaVersion();
			assert.equal(result.reset, false);
			assert.ok(existsSync(dir));
		});
	});

	test("relocates mismatched root to .bak", async () => {
		await withRoot(async (dir) => {
			mkdirSync(join(dir, "runs"), { recursive: true });
			writeFileSync(join(dir, "SCHEMA_VERSION"), "1\n");
			const result = await ensureSchemaVersion();
			assert.equal(result.reset, true);
			assert.ok(result.backupPath?.includes(".bak."));
			assert.ok(existsSync(result.backupPath));
			assert.ok(existsSync(join(dir, "SCHEMA_VERSION")));
		});
	});

	test("keeps a current root untouched", async () => {
		await withRoot(async (dir) => {
			mkdirSync(join(dir, "runs"), { recursive: true });
			writeFileSync(join(dir, "SCHEMA_VERSION"), `${SCHEMA_VERSION}\n`);
			const result = await ensureSchemaVersion();
			assert.equal(result.reset, false);
		});
	});
});
