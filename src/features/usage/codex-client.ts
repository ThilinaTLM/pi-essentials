import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";

const CACHE_DIR = join(homedir(), ".pi", "agent", "cache", "usage");
const CACHE_FILE = join(CACHE_DIR, "codex-usage.json");
const LOCK_FILE = join(CACHE_DIR, "codex-usage.lock");
const CACHE_MAX_AGE = 30;
const LOCK_MAX_AGE = 10;
const API_URL = "https://chatgpt.com/backend-api/wham/usage";
const API_TIMEOUT_MS = 5000;
const DEFAULT_RATE_LIMIT_BACKOFF = 30;
const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth.chatgpt_account_id";

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

type UsageError =
	| "no-credentials"
	| "rate-limited"
	| "api-error"
	| "parse-error"
	| "timeout";

type CacheEntry = {
	data: CodexUsageData | null;
	time: number;
	error: UsageError | null;
	errorMaxAge: number;
};

type ApiWindow = {
	used_percent?: unknown;
	usedPercent?: unknown;
	limit_window_seconds?: unknown;
	windowSeconds?: unknown;
	window_minutes?: unknown;
	windowMinutes?: unknown;
	reset_after_seconds?: unknown;
	resetAfterSeconds?: unknown;
	reset_at?: unknown;
	resetAt?: unknown;
};

type ApiUsageResponse = {
	plan_type?: unknown;
	planType?: unknown;
	rate_limit?: {
		primary_window?: ApiWindow | null;
		primaryWindow?: ApiWindow | null;
		secondary_window?: ApiWindow | null;
		secondaryWindow?: ApiWindow | null;
	} | null;
	credits?: {
		balance?: unknown;
		has_credits?: unknown;
		hasCredits?: unknown;
		unlimited?: unknown;
	} | null;
};

type WindowData = {
	usedPercent: number | null;
	resetAfterSeconds: number | null;
	windowMinutes: number | null;
};

type HeaderLike = Record<string, string | number | boolean | null | undefined>;

let cache: CacheEntry | null = null;

function ensureCacheDir(): void {
	if (!existsSync(CACHE_DIR)) {
		mkdirSync(CACHE_DIR, { recursive: true });
	}
}

function readCacheFile(): {
	data: CodexUsageData | null;
	time: number;
} | null {
	try {
		const raw = readFileSync(CACHE_FILE, "utf8");
		const parsed = JSON.parse(raw);
		return {
			data: parsed as CodexUsageData | null,
			time: statSync(CACHE_FILE).mtimeMs,
		};
	} catch {
		return null;
	}
}

function writeCacheFile(data: CodexUsageData): void {
	try {
		ensureCacheDir();
		writeFileSync(CACHE_FILE, JSON.stringify(data));
	} catch {
		// ignore
	}
}

export function writeCodexUsageCache(data: CodexUsageData): void {
	writeCacheFile(data);
	cache = { data, time: Date.now(), error: null, errorMaxAge: LOCK_MAX_AGE };
}

function readLock(
	now: number,
): { blockedUntil: number; error: UsageError } | null {
	try {
		const raw = readFileSync(LOCK_FILE, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed.blockedUntil > now) {
			return {
				blockedUntil: parsed.blockedUntil,
				error: (parsed.error as UsageError) ?? "timeout",
			};
		}
		return null;
	} catch {
		try {
			const mtime = Math.floor(statSync(LOCK_FILE).mtimeMs / 1000);
			const blockedUntil = mtime + LOCK_MAX_AGE;
			if (blockedUntil > now) {
				return { blockedUntil, error: "timeout" };
			}
		} catch {
			// no lock file
		}
	}
	return null;
}

function writeLock(blockedUntil: number, error: UsageError): void {
	try {
		ensureCacheDir();
		writeFileSync(LOCK_FILE, JSON.stringify({ blockedUntil, error }));
	} catch {
		// ignore
	}
}

function parseRetryAfter(header: string | null, nowMs: number): number | null {
	const trimmed = header?.trim();
	if (!trimmed) return null;
	if (/^\d+$/.test(trimmed)) {
		const s = Number.parseInt(trimmed, 10);
		return s > 0 ? s : null;
	}
	const ms = Date.parse(trimmed);
	if (Number.isNaN(ms)) return null;
	const s = Math.ceil((ms - nowMs) / 1000);
	return s > 0 ? s : null;
}

function numberValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.trim() === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function boolValue(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1") return true;
	if (normalized === "false" || normalized === "0") return false;
	return null;
}

function stringValue(value: unknown): string | null {
	if (typeof value === "string" && value !== "") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return null;
}

function normalizeResetAt(value: number | null): number | null {
	if (value == null) return null;
	return value > 10_000_000_000 ? Math.round(value / 1000) : value;
}

function resetAfterFromResetAt(
	resetAt: number | null,
	nowMs: number,
): number | null {
	const normalized = normalizeResetAt(resetAt);
	if (normalized == null) return null;
	return Math.max(0, Math.round(normalized - nowMs / 1000));
}

function parseApiWindow(
	window: ApiWindow | null | undefined,
	nowMs: number,
): WindowData {
	const usedPercent = numberValue(window?.used_percent ?? window?.usedPercent);
	const resetAfterSeconds =
		numberValue(window?.reset_after_seconds ?? window?.resetAfterSeconds) ??
		resetAfterFromResetAt(
			numberValue(window?.reset_at ?? window?.resetAt),
			nowMs,
		);
	const limitWindowSeconds = numberValue(
		window?.limit_window_seconds ?? window?.windowSeconds,
	);
	const windowMinutes =
		numberValue(window?.window_minutes ?? window?.windowMinutes) ??
		(limitWindowSeconds != null ? limitWindowSeconds / 60 : null);

	return {
		usedPercent,
		resetAfterSeconds,
		windowMinutes,
	};
}

export function parseCodexUsageResponse(
	payload: unknown,
	nowMs = Date.now(),
): CodexUsageData | null {
	if (
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload)
	) {
		return null;
	}

	const api = payload as ApiUsageResponse;
	const primary = parseApiWindow(
		api.rate_limit?.primary_window ?? api.rate_limit?.primaryWindow,
		nowMs,
	);
	const secondary = parseApiWindow(
		api.rate_limit?.secondary_window ?? api.rate_limit?.secondaryWindow,
		nowMs,
	);

	if (primary.usedPercent == null && secondary.usedPercent == null) {
		return null;
	}

	return {
		primaryUsedPercent: primary.usedPercent,
		primaryResetAfterSeconds: primary.resetAfterSeconds,
		primaryWindowMinutes: primary.windowMinutes,
		secondaryUsedPercent: secondary.usedPercent,
		secondaryResetAfterSeconds: secondary.resetAfterSeconds,
		secondaryWindowMinutes: secondary.windowMinutes,
		planType: stringValue(api.plan_type ?? api.planType),
		creditsBalance: stringValue(api.credits?.balance),
		creditsHasCredits: boolValue(
			api.credits?.has_credits ?? api.credits?.hasCredits,
		),
		creditsUnlimited: boolValue(api.credits?.unlimited),
		activeLimit: null,
	};
}

function headerValue(headers: HeaderLike, name: string): string | undefined {
	const wanted = `x-codex-${name}`.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted && value !== undefined && value !== null) {
			return String(value);
		}
	}
	return undefined;
}

function headerNumber(headers: HeaderLike, name: string): number | null {
	return numberValue(headerValue(headers, name));
}

function headerBool(headers: HeaderLike, name: string): boolean | null {
	return boolValue(headerValue(headers, name));
}

function headerResetAfter(
	headers: HeaderLike,
	prefix: string,
	nowMs: number,
): number | null {
	return (
		headerNumber(headers, `${prefix}-reset-after-seconds`) ??
		resetAfterFromResetAt(headerNumber(headers, `${prefix}-reset-at`), nowMs)
	);
}

export function parseCodexUsageHeaders(
	headers: HeaderLike,
	nowMs = Date.now(),
): CodexUsageData | null {
	const primaryUsedPercent = headerNumber(headers, "primary-used-percent");
	const secondaryUsedPercent = headerNumber(headers, "secondary-used-percent");

	if (primaryUsedPercent == null && secondaryUsedPercent == null) {
		return null;
	}

	return {
		primaryUsedPercent,
		primaryResetAfterSeconds: headerResetAfter(headers, "primary", nowMs),
		primaryWindowMinutes: headerNumber(headers, "primary-window-minutes"),
		secondaryUsedPercent,
		secondaryResetAfterSeconds: headerResetAfter(headers, "secondary", nowMs),
		secondaryWindowMinutes: headerNumber(headers, "secondary-window-minutes"),
		planType: headerValue(headers, "plan-type") ?? null,
		creditsBalance: headerValue(headers, "credits-balance") ?? null,
		creditsHasCredits: headerBool(headers, "credits-has-credits"),
		creditsUnlimited: headerBool(headers, "credits-unlimited"),
		activeLimit: headerValue(headers, "active-limit") ?? null,
	};
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
	try {
		const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(
			normalized.length + ((4 - (normalized.length % 4)) % 4),
			"=",
		);
		const raw = Buffer.from(padded, "base64").toString("utf8");
		const parsed = JSON.parse(raw);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return null;
		}
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function extractAccountId(token: string): string | null {
	const [, payload] = token.split(".");
	if (!payload) return null;
	const claims = decodeBase64UrlJson(payload);
	return stringValue(
		claims?.[ACCOUNT_ID_CLAIM] ??
			claims?.chatgpt_account_id ??
			claims?.account_id,
	);
}

async function fetchApi(
	token: string,
	accountId: string | null,
): Promise<
	| { kind: "success"; body: unknown }
	| { kind: "rate-limited"; retryAfter: number }
	| { kind: "error" }
> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			accept: "application/json",
			"user-agent": "pi-toolbelt/1.0.0",
		};
		if (accountId) {
			headers["chatgpt-account-id"] = accountId;
		}

		const res = await fetch(API_URL, {
			method: "GET",
			headers,
			signal: controller.signal,
		});

		if (res.ok) {
			return { kind: "success", body: await res.json() };
		}
		if (res.status === 429) {
			return {
				kind: "rate-limited",
				retryAfter:
					parseRetryAfter(res.headers.get("retry-after"), Date.now()) ??
					DEFAULT_RATE_LIMIT_BACKOFF,
			};
		}
		return { kind: "error" };
	} catch {
		return { kind: "error" };
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchUsageFromApi(
	token: string,
): Promise<CodexUsageData | null> {
	const now = Math.floor(Date.now() / 1000);

	if (cache && cache.error == null) {
		const age = now - Math.floor(cache.time / 1000);
		if (age < CACHE_MAX_AGE) {
			return cache.data;
		}
	}

	const fileCache = readCacheFile();
	if (fileCache?.data) {
		const age = now - Math.floor(fileCache.time / 1000);
		if (age < CACHE_MAX_AGE) {
			cache = {
				data: fileCache.data,
				time: fileCache.time,
				error: null,
				errorMaxAge: LOCK_MAX_AGE,
			};
			return fileCache.data;
		}
	}

	const lastKnown: CodexUsageData | null =
		cache?.data ?? fileCache?.data ?? null;

	if (cache && cache.error != null) {
		const age = now - Math.floor(cache.time / 1000);
		if (age < cache.errorMaxAge) {
			return lastKnown;
		}
	}

	const lock = readLock(now);
	if (lock) {
		cache = {
			data: lastKnown,
			time: Date.now(),
			error: lock.error,
			errorMaxAge: Math.max(1, lock.blockedUntil - now),
		};
		return lastKnown;
	}

	writeLock(now + LOCK_MAX_AGE, "timeout");

	const resp = await fetchApi(token, extractAccountId(token));
	if (resp.kind === "rate-limited") {
		writeLock(now + resp.retryAfter, "rate-limited");
		cache = {
			data: lastKnown,
			time: Date.now(),
			error: "rate-limited",
			errorMaxAge: resp.retryAfter,
		};
		return lastKnown;
	}
	if (resp.kind === "error") {
		cache = {
			data: lastKnown,
			time: Date.now(),
			error: "api-error",
			errorMaxAge: LOCK_MAX_AGE,
		};
		return lastKnown;
	}

	const data = parseCodexUsageResponse(resp.body);
	if (!data) {
		cache = {
			data: lastKnown,
			time: Date.now(),
			error: "parse-error",
			errorMaxAge: LOCK_MAX_AGE,
		};
		return lastKnown;
	}

	writeCacheFile(data);
	cache = { data, time: Date.now(), error: null, errorMaxAge: LOCK_MAX_AGE };
	return data;
}

export async function getCodexUsageData(): Promise<CodexUsageData | null> {
	const storage = AuthStorage.create();
	const token = await storage.getApiKey("openai-codex");
	if (!token) {
		return readCacheFile()?.data ?? null;
	}
	try {
		return await fetchUsageFromApi(token);
	} catch {
		return readCacheFile()?.data ?? null;
	}
}
