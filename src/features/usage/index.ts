import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { requestFooterRender } from "../footer/index.js";
import { formatUsageStatus, getUsageData, type UsageData } from "./api.js";
import {
	type CodexUsageData,
	formatCodexUsageStatus,
	parseCodexHeaders,
} from "./codex.js";

let currentUsageData: UsageData | null = null;
let currentCodexUsageData: CodexUsageData | null = null;

const STATUS_KEY = "anthropic-usage";
const CODEX_STATUS_KEY = "codex-usage";
const REFRESH_INTERVAL = 10_000; // 10 seconds

let pendingFetch: Promise<UsageData | null> | undefined;
let storedCtx: ExtensionContext | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function scheduleRefresh(): void {
	if (refreshTimer) return;
	const isAnthropic =
		storedCtx?.model != null && storedCtx.model.provider === "anthropic";
	if (!isAnthropic) return;

	refreshTimer = setInterval(() => {
		if (!pendingFetch) {
			updateStatus(storedCtx?.model);
		}
	}, REFRESH_INTERVAL);
}

function cancelRefresh(): void {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = undefined;
	}
}

function updateStatus(model?: { provider: string }): void {
	if (!storedCtx) return;

	const isAnthropic = model?.provider === "anthropic";

	if (!isAnthropic) {
		cancelRefresh();
		storedCtx.ui.setStatus(STATUS_KEY, undefined);
		pendingFetch = undefined;
		currentUsageData = null;
		requestFooterRender();
		return;
	}

	if (pendingFetch) return;

	pendingFetch = getUsageData().then((data) => {
		pendingFetch = undefined;
		if (!data) {
			storedCtx?.ui.setStatus(STATUS_KEY, undefined);
			currentUsageData = null;
			requestFooterRender();
			return null;
		}
		currentUsageData = data;
		const text = formatUsageStatus(data);
		storedCtx?.ui.setStatus(STATUS_KEY, text ?? undefined);
		requestFooterRender();
		return data;
	});
}

export function getAnthropicUsageSnapshot(): UsageData | null {
	return currentUsageData;
}

export function getCodexUsageSnapshot(): CodexUsageData | null {
	return currentCodexUsageData;
}

export function registerUsage(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		storedCtx = ctx;
		updateStatus(ctx.model);
		scheduleRefresh();
	});

	pi.on("model_select", (event) => {
		const model = (event as { model: { provider: string } }).model;
		cancelRefresh();
		updateStatus(model);

		if (model.provider === "anthropic") {
			scheduleRefresh();
		}

		// Clear codex usage when switching away from codex
		if (model.provider !== "openai-codex") {
			currentCodexUsageData = null;
			storedCtx?.ui.setStatus(CODEX_STATUS_KEY, undefined);
			requestFooterRender();
		}
	});

	pi.on(
		"after_provider_response",
		(event: {
			type: string;
			status: number;
			headers: Record<string, string>;
		}) => {
			const provider = storedCtx?.model?.provider;
			if (provider !== "openai-codex") return;

			const data = parseCodexHeaders(event.headers);
			if (!data) return;

			currentCodexUsageData = data;
			const text = formatCodexUsageStatus(data);
			storedCtx?.ui.setStatus(CODEX_STATUS_KEY, text ?? undefined);
			requestFooterRender();
		},
	);

	pi.on("session_shutdown", () => {
		cancelRefresh();
	});
}
