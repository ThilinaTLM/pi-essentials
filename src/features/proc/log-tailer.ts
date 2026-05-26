import { createReadStream, type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { eventsPath, readRun } from "./store.js";
import { isTerminalStatus, type ProcLogEvent } from "./types.js";

export interface LogTailerOptions {
	/** Emit events from this seq onward. Default: tail from current end. */
	sinceSeq?: number;
	/** Stop tailing after this many ms with no new events. */
	idleTimeoutMs?: number;
	/** Hard ceiling regardless of activity. */
	maxWaitMs?: number;
}

export interface LogTailer {
	onEvent(handler: (event: ProcLogEvent) => void): () => void;
	onTerminal(handler: (status: string) => void): () => void;
	close(): void;
	collected(): ProcLogEvent[];
}

/**
 * Tail a run's events.ndjson, emitting new events as they're written by the
 * (separate) supervisor process. Falls back to polling when fs.watch is
 * unreliable (network FS, some Linux configs). Stops automatically when the
 * run reaches a terminal status or the configured timeout fires.
 */
export async function tailRunEvents(
	runId: string,
	options: LogTailerOptions = {},
): Promise<LogTailer> {
	const eventListeners = new Set<(value: ProcLogEvent) => void>();
	const terminalListeners = new Set<(value: string) => void>();
	const collected: ProcLogEvent[] = [];
	let position = 0;
	let pending = "";
	let closed = false;
	let watcher: FSWatcher | undefined;
	let pollTimer: NodeJS.Timeout | undefined;
	let idleTimer: NodeJS.Timeout | undefined;
	let maxTimer: NodeJS.Timeout | undefined;

	const filePath = eventsPath(runId);

	try {
		const initial = await stat(filePath);
		position = options.sinceSeq === undefined ? initial.size : 0;
	} catch {
		position = 0;
	}

	function emitEvent(event: ProcLogEvent): void {
		if (options.sinceSeq !== undefined && event.seq <= options.sinceSeq) return;
		collected.push(event);
		for (const handler of eventListeners) handler(event);
		resetIdleTimer();
	}

	function resetIdleTimer(): void {
		if (!options.idleTimeoutMs) return;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			for (const handler of terminalListeners) handler("idle");
			close();
		}, options.idleTimeoutMs);
	}

	async function readChunk(): Promise<void> {
		if (closed) return;
		let size = position;
		try {
			const s = await stat(filePath);
			size = s.size;
		} catch {
			return;
		}
		if (size < position) {
			// File was truncated (rotation moved it aside). Reset.
			position = 0;
			pending = "";
		}
		if (size === position) return;
		const stream = createReadStream(filePath, {
			start: position,
			end: size - 1,
			encoding: "utf8",
		});
		const rl = createInterface({ input: stream, crlfDelay: Infinity });
		try {
			for await (const line of rl) {
				const full = pending + line;
				pending = "";
				if (!full) continue;
				try {
					const event = JSON.parse(full) as ProcLogEvent;
					emitEvent(event);
				} catch {
					pending = full;
				}
			}
		} finally {
			rl.close();
			stream.close();
		}
		position = size;
	}

	async function pollStatus(): Promise<void> {
		const run = await readRun(runId);
		if (run && isTerminalStatus(run.state.status)) {
			for (const handler of terminalListeners) handler(run.state.status);
			close();
		}
	}

	async function tick(): Promise<void> {
		await readChunk().catch(() => undefined);
		await pollStatus().catch(() => undefined);
	}

	try {
		watcher = watch(filePath, () => {
			void tick();
		});
	} catch {
		// fs.watch can fail (rotated file moved away); fall back to polling.
	}

	// Always poll on a short interval to cover rotation edges and platforms
	// where fs.watch is flaky.
	pollTimer = setInterval(() => {
		void tick();
	}, 150);

	resetIdleTimer();
	if (options.maxWaitMs) {
		maxTimer = setTimeout(() => {
			for (const handler of terminalListeners) handler("timeout");
			close();
		}, options.maxWaitMs);
	}

	// Initial drain in case events already exist beyond `position`.
	await tick();

	function close(): void {
		if (closed) return;
		closed = true;
		watcher?.close();
		if (pollTimer) clearInterval(pollTimer);
		if (idleTimer) clearTimeout(idleTimer);
		if (maxTimer) clearTimeout(maxTimer);
	}

	return {
		onEvent(handler) {
			eventListeners.add(handler);
			return () => eventListeners.delete(handler);
		},
		onTerminal(handler) {
			terminalListeners.add(handler);
			return () => terminalListeners.delete(handler);
		},
		collected: () => [...collected],
		close,
	};
}
