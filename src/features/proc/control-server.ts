import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { controlSocketPath } from "./store.js";
import type { ProcLogEvent } from "./types.js";

const REPLAY_BYTES = (() => {
	const raw = process.env.PI_PROC_REPLAY_BYTES;
	if (!raw) return 32 * 1024;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 32 * 1024;
})();

export interface ControlServerHandlers {
	onInput(data: Buffer): void;
	onResize(cols: number, rows: number): void;
	onSignal(name: string): void;
	onAttach?(client: { cols: number; rows: number }): void;
	onDetach?(): void;
}

export interface ControlServer {
	broadcastData(chunk: Buffer): void;
	broadcastEvent(event: ProcLogEvent): void;
	broadcastExit(info: {
		status: string;
		exitCode: number | null;
		signal: string | null;
	}): void;
	close(): Promise<void>;
	clientCount(): number;
}

interface ClientState {
	socket: Socket;
	buffer: string;
	cols: number;
	rows: number;
	attached: boolean;
}

function send(socket: Socket, message: unknown): void {
	try {
		socket.write(`${JSON.stringify(message)}\n`);
	} catch {
		// destroyed sockets emit later
	}
}

/**
 * Start a control socket server for a run. Returns a handle for the
 * supervisor to broadcast data/events/exit to all attached clients.
 *
 * Wire format: line-delimited JSON. Binary payloads (terminal IO) are
 * base64-encoded under `data`.
 *
 * Server → client messages:
 *   { type: "hello", runId, cols, rows, replay: base64 }
 *   { type: "data", data: base64 }
 *   { type: "event", event: ProcLogEvent }
 *   { type: "exit", status, exitCode, signal }
 *   { type: "error", message }
 *
 * Client → server messages:
 *   { type: "attach", cols, rows }
 *   { type: "input", data: base64 }
 *   { type: "resize", cols, rows }
 *   { type: "signal", name }
 *   { type: "detach" }
 */
export async function startControlServer(
	runId: string,
	handlers: ControlServerHandlers,
): Promise<ControlServer> {
	const socketPath = controlSocketPath(runId);
	if (process.platform !== "win32" && existsSync(socketPath)) {
		await unlink(socketPath).catch(() => undefined);
	}

	const clients = new Set<ClientState>();
	const replay: Buffer[] = [];
	let replayBytes = 0;

	function pushReplay(chunk: Buffer): void {
		replay.push(chunk);
		replayBytes += chunk.length;
		while (replayBytes > REPLAY_BYTES && replay.length > 1) {
			const dropped = replay.shift();
			if (dropped) replayBytes -= dropped.length;
		}
	}

	function handleLine(client: ClientState, line: string): void {
		if (!line) return;
		let message: { type?: string; [k: string]: unknown };
		try {
			message = JSON.parse(line);
		} catch {
			send(client.socket, { type: "error", message: "invalid json" });
			return;
		}
		switch (message.type) {
			case "attach": {
				const cols = Math.max(1, Number(message.cols) || 80);
				const rows = Math.max(1, Number(message.rows) || 24);
				client.cols = cols;
				client.rows = rows;
				client.attached = true;
				const replayBuf = Buffer.concat(replay);
				send(client.socket, {
					type: "hello",
					runId,
					cols,
					rows,
					replay: replayBuf.toString("base64"),
				});
				handlers.onAttach?.({ cols, rows });
				handlers.onResize(cols, rows);
				return;
			}
			case "input": {
				if (typeof message.data !== "string") return;
				const buf = Buffer.from(message.data, "base64");
				handlers.onInput(buf);
				return;
			}
			case "resize": {
				const cols = Math.max(1, Number(message.cols) || client.cols);
				const rows = Math.max(1, Number(message.rows) || client.rows);
				client.cols = cols;
				client.rows = rows;
				handlers.onResize(cols, rows);
				return;
			}
			case "signal": {
				if (typeof message.name === "string") handlers.onSignal(message.name);
				return;
			}
			case "detach": {
				client.attached = false;
				try {
					client.socket.end();
				} catch {
					// already closed
				}
				handlers.onDetach?.();
				return;
			}
			default:
				send(client.socket, { type: "error", message: "unknown message" });
		}
	}

	const server: Server = createServer((socket) => {
		const state: ClientState = {
			socket,
			buffer: "",
			cols: 80,
			rows: 24,
			attached: false,
		};
		clients.add(state);
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			state.buffer += chunk;
			let newlineIndex = state.buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = state.buffer.slice(0, newlineIndex).replace(/\r$/, "");
				state.buffer = state.buffer.slice(newlineIndex + 1);
				handleLine(state, line);
				newlineIndex = state.buffer.indexOf("\n");
			}
		});
		const cleanup = () => {
			clients.delete(state);
			if (state.attached) handlers.onDetach?.();
		};
		socket.on("close", cleanup);
		socket.on("error", cleanup);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});

	return {
		broadcastData(chunk: Buffer) {
			pushReplay(chunk);
			const payload = chunk.toString("base64");
			for (const client of clients) {
				if (client.attached)
					send(client.socket, { type: "data", data: payload });
			}
		},
		broadcastEvent(event: ProcLogEvent) {
			for (const client of clients) {
				if (client.attached) send(client.socket, { type: "event", event });
			}
		},
		broadcastExit(info) {
			for (const client of clients) {
				send(client.socket, { type: "exit", ...info });
				try {
					client.socket.end();
				} catch {
					// already closed
				}
			}
		},
		clientCount() {
			let count = 0;
			for (const c of clients) if (c.attached) count++;
			return count;
		},
		async close() {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				for (const client of clients) {
					try {
						client.socket.destroy();
					} catch {
						// ignore
					}
				}
			});
			if (process.platform !== "win32") {
				await unlink(socketPath).catch(() => undefined);
			}
		},
	};
}
