import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { requestFooterRender } from "../footer/index.js";
import {
	type AnthropicUsageData,
	getAnthropicUsageData,
} from "./anthropic-client.js";

export type { AnthropicUsageData };

const STATUS_KEY = "anthropic-usage";
const REFRESH_INTERVAL = 30_000;

let snapshot: AnthropicUsageData | null = null;
let pendingFetch: Promise<AnthropicUsageData | null> | undefined;
let storedCtx: ExtensionContext | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function isAnthropic(model: { provider: string } | undefined): boolean {
	return model?.provider === "anthropic";
}

function startPolling(): void {
	if (refreshTimer) return;
	if (!isAnthropic(storedCtx?.model)) return;

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
	snapshot = null;
	pendingFetch = undefined;
	storedCtx?.ui.setStatus(STATUS_KEY, undefined);
	requestFooterRender();
}

function refresh(model: { provider: string } | undefined): void {
	if (!storedCtx) return;

	if (!isAnthropic(model)) {
		stopPolling();
		clearSnapshot();
		return;
	}

	if (pendingFetch) return;

	pendingFetch = getAnthropicUsageData().then((data) => {
		pendingFetch = undefined;
		if (!data) {
			// Transient failure (rate-limit, network, parse). Keep the previous
			// snapshot on screen instead of wiping the segment.
			requestFooterRender();
			return null;
		}
		snapshot = data;
		storedCtx?.ui.setStatus(STATUS_KEY, formatStatus(data) ?? undefined);
		requestFooterRender();
		return data;
	});
}

export function getAnthropicUsageSnapshot(): AnthropicUsageData | null {
	return snapshot;
}

export function formatAnthropicResetTime(
	resetAt: string | null,
): string | null {
	if (!resetAt) return null;

	const target = new Date(resetAt).getTime();
	if (Number.isNaN(target)) return null;

	const diffMs = target - Date.now();
	if (diffMs <= 0) return null;

	const totalMinutes = Math.floor(diffMs / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;

	if (hours > 0) {
		return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
	}
	return `${minutes}m`;
}

function formatStatus(data: AnthropicUsageData): string | null {
	const parts: string[] = [];

	if (data.sessionUtilization != null) {
		parts.push(`${Math.round(data.sessionUtilization)}%`);
	}

	if (data.weeklyUtilization != null) {
		parts.push(`${Math.round(data.weeklyUtilization)}%`);
	}

	return parts.length > 0 ? parts.join(" │ ") : null;
}

export function registerAnthropicUsage(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		storedCtx = ctx;
		refresh(ctx.model);
		startPolling();
	});

	pi.on("model_select", (event) => {
		const model = (event as { model: { provider: string } }).model;
		stopPolling();
		refresh(model);
		if (isAnthropic(model)) {
			startPolling();
		}
	});

	pi.on("session_shutdown", () => {
		stopPolling();
	});
}
