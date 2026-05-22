import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { requestFooterRender } from "../footer/index.js";
import {
	type CodexUsageData,
	getCodexUsageData,
	parseCodexUsageHeaders,
	writeCodexUsageCache,
} from "./codex-client.js";

export type { CodexUsageData };
export { parseCodexUsageHeaders };

const STATUS_KEY = "codex-usage";
const REFRESH_INTERVAL = 30_000;

let snapshot: CodexUsageData | null = null;
let pendingFetch: Promise<CodexUsageData | null> | undefined;
let storedCtx: ExtensionContext | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let refreshGeneration = 0;

function isCodex(model: { provider: string } | undefined): boolean {
	return model?.provider === "openai-codex";
}

function startPolling(): void {
	if (refreshTimer) return;
	if (!isCodex(storedCtx?.model)) return;

	refreshTimer = setInterval(() => {
		if (!pendingFetch) {
			refresh(storedCtx?.model);
		}
	}, REFRESH_INTERVAL);
}

function stopPolling(): void {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = undefined;
	}
}

function clearSnapshot(): void {
	refreshGeneration++;
	snapshot = null;
	pendingFetch = undefined;
	storedCtx?.ui.setStatus(STATUS_KEY, undefined);
	requestFooterRender();
}

function formatStatus(data: CodexUsageData): string | null {
	const parts: string[] = [];

	if (data.primaryUsedPercent != null) {
		parts.push(`${Math.round(data.primaryUsedPercent)}%`);
	}

	if (data.secondaryUsedPercent != null) {
		parts.push(`${Math.round(data.secondaryUsedPercent)}%`);
	}

	return parts.length > 0 ? parts.join(" │ ") : null;
}

function mergeUsageData(
	base: CodexUsageData | null,
	update: CodexUsageData,
): CodexUsageData {
	if (!base) return update;
	return {
		primaryUsedPercent: update.primaryUsedPercent ?? base.primaryUsedPercent,
		primaryResetAfterSeconds:
			update.primaryResetAfterSeconds ?? base.primaryResetAfterSeconds,
		primaryWindowMinutes:
			update.primaryWindowMinutes ?? base.primaryWindowMinutes,
		secondaryUsedPercent:
			update.secondaryUsedPercent ?? base.secondaryUsedPercent,
		secondaryResetAfterSeconds:
			update.secondaryResetAfterSeconds ?? base.secondaryResetAfterSeconds,
		secondaryWindowMinutes:
			update.secondaryWindowMinutes ?? base.secondaryWindowMinutes,
		planType: update.planType ?? base.planType,
		creditsBalance: update.creditsBalance ?? base.creditsBalance,
		creditsHasCredits: update.creditsHasCredits ?? base.creditsHasCredits,
		creditsUnlimited: update.creditsUnlimited ?? base.creditsUnlimited,
		activeLimit: update.activeLimit ?? base.activeLimit,
	};
}

function applySnapshot(data: CodexUsageData, persist: boolean): void {
	snapshot = data;
	storedCtx?.ui.setStatus(STATUS_KEY, formatStatus(data) ?? undefined);
	if (persist) {
		writeCodexUsageCache(data);
	}
	requestFooterRender();
}

function refresh(model: { provider: string } | undefined): void {
	if (!storedCtx) return;

	if (!isCodex(model)) {
		stopPolling();
		clearSnapshot();
		return;
	}

	if (pendingFetch) return;

	const generation = ++refreshGeneration;
	pendingFetch = getCodexUsageData()
		.then((data) => {
			if (generation !== refreshGeneration || !isCodex(storedCtx?.model)) {
				return null;
			}
			if (!data) {
				// Transient failure (rate-limit, network, parse). Keep the previous
				// snapshot on screen instead of wiping the segment.
				requestFooterRender();
				return null;
			}
			applySnapshot(data, false);
			return data;
		})
		.catch(() => {
			if (generation === refreshGeneration) {
				requestFooterRender();
			}
			return null;
		})
		.finally(() => {
			if (generation === refreshGeneration) {
				pendingFetch = undefined;
			}
		});
}

export function getCodexUsageSnapshot(): CodexUsageData | null {
	return snapshot;
}

export function formatCodexResetAfterSeconds(
	seconds: number | null,
): string | null {
	if (seconds == null || seconds <= 0) return null;

	const totalMinutes = Math.floor(seconds / 60);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;

	if (hours > 0) {
		return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
	}
	return `${minutes}m`;
}

export function registerCodexUsage(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		storedCtx = ctx;
		refresh(ctx.model);
		startPolling();
	});

	pi.on("model_select", (event) => {
		const model = (event as { model: { provider: string } }).model;
		stopPolling();
		refresh(model);
		if (isCodex(model)) {
			startPolling();
		}
	});

	pi.on(
		"after_provider_response",
		(event: {
			type: string;
			status: number;
			headers: Record<string, string>;
		}) => {
			if (!isCodex(storedCtx?.model)) return;

			const data = parseCodexUsageHeaders(event.headers);
			if (!data) return;

			applySnapshot(mergeUsageData(snapshot, data), true);
		},
	);

	pi.on("session_shutdown", () => {
		stopPolling();
	});
}
