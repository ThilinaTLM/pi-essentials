import { createConnection, type Socket } from "node:net";
import { controlSocketPath } from "./store.js";
import type { ProcLogEvent } from "./types.js";

export interface AttachOptions {
	cols: number;
	rows: number;
	interactive: boolean;
	/**
	 * Single-character (or escape sequence) to detach without killing the
	 * remote process. Default is Ctrl-\ (0x1c). Set to empty string to disable.
	 */
	detachKey?: string;
	onData?(chunk: Buffer): void;
	onEvent?(event: ProcLogEvent): void;
	onExit?(info: {
		status: string;
		exitCode: number | null;
		signal: string | null;
	}): void;
}

export interface AttachSession {
	socket: Socket;
	close(): void;
}

function send(socket: Socket, message: unknown): void {
	try {
		socket.write(`${JSON.stringify(message)}\n`);
	} catch {
		// already closed
	}
}

export function defaultDetachKey(): string {
	return process.env.PI_PROC_DETACH_KEY ?? "\x1c"; // Ctrl-\
}

/**
 * Attach to a run's control socket. For interactive use the caller should
 * have stdin in raw mode and forward bytes via `session.socket` (via the
 * `input` message). For tail mode, pass `interactive: false` and the client
 * only reads data/events.
 */
export async function attachToRun(
	runId: string,
	options: AttachOptions,
): Promise<AttachSession> {
	const socketPath = controlSocketPath(runId);
	const socket = createConnection({ path: socketPath });
	socket.setEncoding("utf8");

	await new Promise<void>((resolve, reject) => {
		socket.once("connect", () => {
			socket.off("error", reject);
			resolve();
		});
		socket.once("error", reject);
	});

	send(socket, {
		type: "attach",
		cols: options.cols,
		rows: options.rows,
	});

	let buffer = "";
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let nl = buffer.indexOf("\n");
		while (nl !== -1) {
			const line = buffer.slice(0, nl).replace(/\r$/, "");
			buffer = buffer.slice(nl + 1);
			nl = buffer.indexOf("\n");
			if (!line) continue;
			let message: { type?: string; [k: string]: unknown };
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			switch (message.type) {
				case "hello":
					if (typeof message.replay === "string" && options.onData) {
						const replay = Buffer.from(message.replay as string, "base64");
						if (replay.length > 0) options.onData(replay);
					}
					break;
				case "data":
					if (typeof message.data === "string" && options.onData) {
						options.onData(Buffer.from(message.data as string, "base64"));
					}
					break;
				case "event":
					if (message.event && options.onEvent)
						options.onEvent(message.event as ProcLogEvent);
					break;
				case "exit":
					options.onExit?.({
						status: String(message.status ?? ""),
						exitCode:
							typeof message.exitCode === "number"
								? (message.exitCode as number)
								: null,
						signal:
							typeof message.signal === "string"
								? (message.signal as string)
								: null,
					});
					try {
						socket.end();
					} catch {
						// ignore
					}
					break;
				case "error":
					// silent — caller can subscribe to socket errors if needed
					break;
			}
		}
	});

	return {
		socket,
		close() {
			try {
				send(socket, { type: "detach" });
				socket.end();
			} catch {
				// ignore
			}
		},
	};
}

export function sendInput(socket: Socket, data: Buffer): void {
	send(socket, { type: "input", data: data.toString("base64") });
}

export function sendResize(socket: Socket, cols: number, rows: number): void {
	send(socket, { type: "resize", cols, rows });
}

export function sendSignal(socket: Socket, name: string): void {
	send(socket, { type: "signal", name });
}
