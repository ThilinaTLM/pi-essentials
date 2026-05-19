import { execFile } from "node:child_process";
import {
	existsSync,
	type FSWatcher,
	readFileSync,
	statSync,
	watch,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_STATUS_TIMEOUT_MS = 1000;
const WATCHER_RETRY_DELAY_MS = 5000;

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

type GitPaths = { repoDir: string; gitDir: string };

function findGitPaths(cwd: string): GitPaths | null {
	let dir = cwd;
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isFile()) {
					const content = readFileSync(gitPath, "utf8").trim();
					if (content.startsWith("gitdir: ")) {
						const gitDir = resolve(dir, content.slice(8).trim());
						if (existsSync(join(gitDir, "HEAD"))) {
							return { repoDir: dir, gitDir };
						}
					}
				} else if (stat.isDirectory()) {
					if (existsSync(join(gitPath, "HEAD"))) {
						return { repoDir: dir, gitDir: gitPath };
					}
				}
				return null;
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export interface GitDirtyWatcher {
	dispose(): void;
}

/**
 * Notifies `onChange` when `.git/index` is rewritten (commits, adds, resets,
 * stashes, checkouts). Caller is responsible for debouncing.
 */
export function createGitDirtyWatcher(
	cwd: string,
	onChange: () => void,
): GitDirtyWatcher {
	const paths = findGitPaths(cwd);
	if (!paths) {
		return { dispose() {} };
	}

	let disposed = false;
	let indexWatcher: FSWatcher | null = null;
	let dirWatcher: FSWatcher | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;

	const close = (watcher: FSWatcher | null) => {
		if (!watcher) return;
		try {
			watcher.close();
		} catch {
			// ignore
		}
	};

	const clearWatchers = () => {
		close(indexWatcher);
		indexWatcher = null;
		close(dirWatcher);
		dirWatcher = null;
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
	};

	const scheduleRetry = () => {
		if (disposed || retryTimer) return;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			setup();
		}, WATCHER_RETRY_DELAY_MS);
	};

	const handleError = () => {
		clearWatchers();
		scheduleRetry();
	};

	const tryWatch = (
		path: string,
		listener: (filename: string | null) => void,
	): FSWatcher | null => {
		try {
			const watcher = watch(path, (_eventType, filename) => {
				listener(typeof filename === "string" ? filename : null);
			});
			watcher.on("error", handleError);
			return watcher;
		} catch {
			return null;
		}
	};

	const setup = () => {
		if (disposed) return;

		// File watch on .git/index for index rewrites.
		const indexPath = join(paths.gitDir, "index");
		if (existsSync(indexPath)) {
			indexWatcher = tryWatch(indexPath, () => {
				if (!disposed) onChange();
			});
		}

		// Directory watch on .git/ to catch index recreate (atomic rename) and
		// other ref/state mutations.
		dirWatcher = tryWatch(paths.gitDir, (filename) => {
			if (disposed) return;
			if (!filename || filename === "index" || filename.endsWith(".lock")) {
				// rebind the file watcher if the inode was swapped
				if (filename === "index" && !indexWatcher) {
					indexWatcher = tryWatch(join(paths.gitDir, "index"), () => {
						if (!disposed) onChange();
					});
				}
				onChange();
			}
		});

		if (!dirWatcher) {
			scheduleRetry();
		}
	};

	setup();

	return {
		dispose() {
			disposed = true;
			clearWatchers();
		},
	};
}
