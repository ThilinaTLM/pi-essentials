import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { getGitBranch } from "../src/features/footer/git.ts";

function git(cwd, args) {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo() {
	const dir = mkdtempSync(join(tmpdir(), "pi-toolbelt-footer-git-"));
	git(dir, ["init"]);
	git(dir, ["checkout", "-b", "main"]);
	writeFileSync(join(dir, "README.md"), "test\n");
	git(dir, ["add", "README.md"]);
	git(dir, [
		"-c",
		"user.email=test@example.com",
		"-c",
		"user.name=Test User",
		"commit",
		"-m",
		"initial",
	]);
	return dir;
}

describe("footer git helpers", () => {
	test("reads the current branch and sees branch switches", async () => {
		const repo = makeRepo();
		try {
			assert.equal(await getGitBranch(repo), "main");

			git(repo, ["checkout", "-b", "feature/footer"]);
			assert.equal(await getGitBranch(repo), "feature/footer");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test("reports detached HEAD", async () => {
		const repo = makeRepo();
		try {
			git(repo, ["checkout", "--detach", "HEAD"]);
			assert.equal(await getGitBranch(repo), "detached");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test("returns null outside a Git repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-toolbelt-no-git-"));
		try {
			assert.equal(await getGitBranch(dir), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
