/**
 * Thin wrapper around `node-pty`. Imported dynamically so the optional native
 * dependency never breaks install on platforms without prebuilt binaries.
 * Callers catch `PtyUnavailableError` and fall back to pipe-mode.
 */

export class PtyUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PtyUnavailableError";
	}
}

export interface SpawnPtyOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	cols?: number;
	rows?: number;
}

export interface PtyHandle {
	pid: number;
	cols: number;
	rows: number;
	write(data: string | Buffer): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
	onData(handler: (data: string) => void): () => void;
	onExit(
		handler: (info: { exitCode: number; signal: number | null }) => void,
	): () => void;
}

interface NodePtyModule {
	spawn(
		file: string,
		args: string[],
		options: {
			name?: string;
			cols?: number;
			rows?: number;
			cwd?: string;
			env?: NodeJS.ProcessEnv;
			encoding?: string | null;
			handleFlowControl?: boolean;
		},
	): {
		pid: number;
		cols: number;
		rows: number;
		write(data: string): void;
		resize(cols: number, rows: number): void;
		kill(signal?: string): void;
		onData(cb: (data: string) => void): { dispose(): void };
		onExit(cb: (info: { exitCode: number; signal?: number }) => void): {
			dispose(): void;
		};
	};
}

let cachedPty: NodePtyModule | null | undefined;

async function loadPty(): Promise<NodePtyModule> {
	if (cachedPty === null) {
		throw new PtyUnavailableError(
			"node-pty failed to load earlier in this process",
		);
	}
	if (cachedPty) return cachedPty;
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const mod = (await import("node-pty" as string)) as unknown as
			| NodePtyModule
			| { default: NodePtyModule };
		cachedPty = "spawn" in mod ? mod : mod.default;
		return cachedPty;
	} catch (error) {
		cachedPty = null;
		throw new PtyUnavailableError(
			error instanceof Error ? error.message : String(error),
		);
	}
}

export async function spawnPty(
	file: string,
	args: string[],
	options: SpawnPtyOptions,
): Promise<PtyHandle> {
	const pty = await loadPty();
	const cols = options.cols ?? 120;
	const rows = options.rows ?? 30;
	const proc = pty.spawn(file, args, {
		name: process.env.TERM ?? "xterm-256color",
		cols,
		rows,
		cwd: options.cwd,
		env: options.env,
		handleFlowControl: false,
	});
	return {
		pid: proc.pid,
		cols,
		rows,
		write(data) {
			proc.write(typeof data === "string" ? data : data.toString("utf8"));
		},
		resize(c, r) {
			try {
				proc.resize(c, r);
			} catch {
				// ignore resize on dead pty
			}
		},
		kill(signal) {
			try {
				proc.kill(signal);
			} catch {
				// ignore kill on dead pty
			}
		},
		onData(handler) {
			const sub = proc.onData(handler);
			return () => sub.dispose();
		},
		onExit(handler) {
			const sub = proc.onExit((info) =>
				handler({ exitCode: info.exitCode, signal: info.signal ?? null }),
			);
			return () => sub.dispose();
		},
	};
}
