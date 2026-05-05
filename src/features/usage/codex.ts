import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { requestFooterRender } from "../footer/index.js";

export type CodexUsageData = {
	primaryUsedPercent: number | null;
	primaryResetAfterSeconds: number | null;
	primaryWindowMinutes: number | null;
	secondaryUsedPercent: number | null;
	secondaryResetAfterSeconds: number | null;
	secondaryWindowMinutes: number | null;
	planType: string | null;
	creditsBalance: string | null;
	creditsHasCredits: boolean | null;
	creditsUnlimited: boolean | null;
	activeLimit: string | null;
};

const STATUS_KEY = "codex-usage";
const HEADER_PREFIX = "x-codex-";

let snapshot: CodexUsageData | null = null;
let storedCtx: ExtensionContext | undefined;

function getHeader(
	headers: Record<string, string>,
	name: string,
): string | undefined {
	// Node.js normalizes headers to lowercase, but try both for safety.
	const lower = `${HEADER_PREFIX}${name}`.toLowerCase();
	if (headers[lower] !== undefined) return headers[lower];
	const original = `${HEADER_PREFIX}${name}`;
	if (headers[original] !== undefined) return headers[original];
	return undefined;
}

function parseHeaders(headers: Record<string, string>): CodexUsageData | null {
	const pct = getHeader(headers, "primary-used-percent");
	const secPct = getHeader(headers, "secondary-used-percent");

	// If neither primary nor secondary percent is present, these aren't codex headers.
	if (pct === undefined && secPct === undefined) {
		return null;
	}

	const parseNum = (val: string | undefined): number | null =>
		val !== undefined ? Number(val) : null;
	const parseBool = (val: string | undefined): boolean | null =>
		val !== undefined ? val === "true" : null;

	return {
		primaryUsedPercent: pct !== undefined ? Number(pct) : null,
		primaryResetAfterSeconds: parseNum(
			getHeader(headers, "primary-reset-after-seconds"),
		),
		primaryWindowMinutes: parseNum(
			getHeader(headers, "primary-window-minutes"),
		),
		secondaryUsedPercent: secPct !== undefined ? Number(secPct) : null,
		secondaryResetAfterSeconds: parseNum(
			getHeader(headers, "secondary-reset-after-seconds"),
		),
		secondaryWindowMinutes: parseNum(
			getHeader(headers, "secondary-window-minutes"),
		),
		planType: getHeader(headers, "plan-type") ?? null,
		creditsBalance: getHeader(headers, "credits-balance") ?? null,
		creditsHasCredits: parseBool(getHeader(headers, "credits-has-credits")),
		creditsUnlimited: parseBool(getHeader(headers, "credits-unlimited")),
		activeLimit: getHeader(headers, "active-limit") ?? null,
	};
}

function isCodex(model: { provider: string } | undefined): boolean {
	return model?.provider === "openai-codex";
}

function clearSnapshot(): void {
	snapshot = null;
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
	});

	pi.on("model_select", (event) => {
		const model = (event as { model: { provider: string } }).model;
		if (!isCodex(model)) {
			clearSnapshot();
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

			const data = parseHeaders(event.headers);
			if (!data) return;

			snapshot = data;
			storedCtx?.ui.setStatus(STATUS_KEY, formatStatus(data) ?? undefined);
			requestFooterRender();
		},
	);
}
