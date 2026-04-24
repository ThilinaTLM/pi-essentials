import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isAllowedPlanBashCommand } from "../src/features/plan/guards.ts";

function expectAllowed(commands) {
	for (const command of commands) {
		test(command, () => {
			assert.equal(isAllowedPlanBashCommand(command), true);
		});
	}
}

function expectBlocked(commands) {
	for (const command of commands) {
		test(command, () => {
			assert.equal(isAllowedPlanBashCommand(command), false);
		});
	}
}

describe("plan-mode bash guard", () => {
	describe("allows inspection commands, including unknown roots", () => {
		expectAllowed([
			'rg "foo" src',
			"git status --short",
			"git diff -- src/features/plan/guards.ts",
			"git remote -v",
			"git config --get remote.origin.url",
			"ps aux | grep pi",
			"docker ps",
			"python --version",
			"node --version",
			"biome check . && tsc --noEmit",
			"rg TODO src || true",
			"rg foo src | head -20 && git status --short || git diff --stat",
			"env FOO=bar rg foo src",
			"command git status --short",
			"time rg foo src",
			"timeout 5 rg foo src",
			"nice -n 5 rg foo src",
			"nohup rg foo src >/dev/null 2>&1",
		]);
	});

	describe("blocks destructive root commands", () => {
		expectBlocked([
			"rm -rf dist",
			"/bin/rm -rf dist",
			"sudo ls",
			"chmod +x script.sh",
			"cp a b",
			"mv a b",
			"touch new-file",
			"mkdir tmp",
			"tee output.txt",
			"pnpm check",
			"npm test",
			"yarn lint",
			"make test",
		]);
	});

	describe("blocks destructive commands hidden behind wrappers", () => {
		expectBlocked([
			"env rm -rf dist",
			"env FOO=bar rm -rf dist",
			"command rm -rf dist",
			"time rm -rf dist",
			"timeout 5 rm -rf dist",
			"nice -10 rm file",
			"nohup rm file >/dev/null 2>&1",
			"rg foo src | xargs rm",
			"rg foo src | xargs -I{} git checkout {}",
		]);
	});

	describe("blocks high-risk shell syntax", () => {
		expectBlocked([
			'echo "$(touch x)"',
			"echo `touch x`",
			"diff <(git show HEAD:a) <(git show HEAD:b)",
			"echo hello > file.txt",
			"echo hello >> file.txt",
			"rg foo &",
			"(rg foo src)",
			"function f { rg foo; }",
		]);
	});

	describe("blocks mutating command options", () => {
		expectBlocked([
			"find . -delete",
			"find . -exec rm {} \\;",
			"find . -execdir rm {} \\;",
			"fd foo -x rm",
			"fd foo --exec rm",
			"fd foo --exec-batch rm",
			"sed -i 's/a/b/' file",
			"sed -i.bak 's/a/b/' file",
			"perl -i -pe 's/a/b/' file",
			"curl -o file https://example.com",
			"curl -O https://example.com/file",
			"curl --output=file https://example.com",
			"curl -X POST https://example.com",
			"curl --request=DELETE https://example.com",
			"curl --data '{}' https://example.com",
			"wget -O file https://example.com",
			"wget --post-data '{}' https://example.com",
			"node -e 'console.log(1)'",
			"python -c 'print(1)'",
		]);
	});

	describe("blocks mutating git commands and allows read-only git combinations", () => {
		expectBlocked([
			"git checkout main",
			"git switch main",
			"git reset --hard",
			"git clean -fd",
			"git branch -D old",
			"git branch --delete old",
			"git diff --output patch.txt",
			"git remote add origin git@example.com:repo.git",
			"git config user.name Someone",
		]);

		expectAllowed([
			"git branch --show-current",
			"git log --oneline -5",
			"git show HEAD -- src/features/plan/guards.ts",
			"git grep plan -- src",
			"git remote show origin",
			"git remote get-url origin",
			"git -C . status --short && git diff --stat || git log --oneline -1",
		]);
	});
});
