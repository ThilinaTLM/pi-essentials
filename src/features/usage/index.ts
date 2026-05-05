import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { requestFooterRender } from "../footer/index.js";
import { formatUsageStatus, getUsageData, type UsageData } from "./api.js";

let currentUsageData: UsageData | null = null;

const STATUS_KEY = "anthropic-usage";
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
			updateStatus();
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

export function getUsageSnapshot(): UsageData | null {
	return currentUsageData;
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
	});

	pi.on("session_shutdown", () => {
		cancelRefresh();
	});
}
