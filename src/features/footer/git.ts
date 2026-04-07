import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_STATUS_TIMEOUT_MS = 1000;

export async function isGitDirty(cwd: string): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["status", "--porcelain", "--untracked-files=normal"],
			{
				cwd,
				encoding: "utf8",
				timeout: GIT_STATUS_TIMEOUT_MS,
				maxBuffer: 1024 * 1024,
			},
		);
		return stdout.trim().length > 0;
	} catch {
		return false;
	}
}
