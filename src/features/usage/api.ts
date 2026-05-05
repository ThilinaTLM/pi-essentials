import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@mariozechner/pi-coding-agent";

const CACHE_DIR = join(homedir(), ".pi", "agent", "cache", "usage");
const CACHE_FILE = join(CACHE_DIR, "usage.json");
const LOCK_FILE = join(CACHE_DIR, "usage.lock");
const CACHE_MAX_AGE = 10;
const LOCK_MAX_AGE = 10;
const API_HOST = "api.anthropic.com";
const API_PATH = "/api/oauth/usage";
const API_TIMEOUT_MS = 5000;
const DEFAULT_RATE_LIMIT_BACKOFF = 30;

export type UsageData = {
	sessionUtilization: number | null;
	sessionResetAt: string | null;
	weeklyUtilization: number | null;
	weeklyResetAt: string | null;
	extraEnabled: boolean | null;
	extraLimit: number | null;
	extraUsed: number | null;
	extraUtilization: number | null;
};

type UsageError =
	| "no-credentials"
	| "rate-limited"
	| "api-error"
	| "parse-error"
	| "timeout";

type CacheEntry = {
	data: UsageData | null;
	time: number;
	error: UsageError | null;
	errorMaxAge: number;
};

let cache: CacheEntry | null = null;

function ensureCacheDir(): void {
	if (!existsSync(CACHE_DIR)) {
		mkdirSync(CACHE_DIR, { recursive: true });
	}
}

function readCacheFile(): { data: UsageData | null; time: number } | null {
	try {
		const raw = readFileSync(CACHE_FILE, "utf8");
		const parsed = JSON.parse(raw);
		return {
			data: parsed as UsageData | null,
			time: statSync(CACHE_FILE).mtimeMs,
		};
	} catch {
		return null;
	}
}

function writeCacheFile(data: UsageData): void {
	try {
		ensureCacheDir();
		writeFileSync(CACHE_FILE, JSON.stringify(data));
	} catch {
		// ignore
	}
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

function parseRetryAfter(
	header: string | string[] | null,
	nowMs: number,
): number | null {
	const raw = Array.isArray(header) ? header[0] : header;
	const trimmed = raw?.trim();
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

async function fetchApi(
	token: string,
): Promise<
	| { kind: "success"; body: string }
	| { kind: "rate-limited"; retryAfter: number }
	| { kind: "error" }
> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (
			val:
				| { kind: "success"; body: string }
				| { kind: "rate-limited"; retryAfter: number }
				| { kind: "error" },
		) => {
			if (settled) return;
			settled = true;
			resolve(val);
		};

		const headers: https.RequestOptions["headers"] = {
			Authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
		};

		const req = https.request(
			{
				hostname: API_HOST,
				path: API_PATH,
				method: "GET",
				headers,
				timeout: API_TIMEOUT_MS,
			},
			(res) => {
				let data = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					data += chunk;
				});
				res.on("end", () => {
					if (res.statusCode === 200 && data) {
						finish({ kind: "success", body: data });
						return;
					}
					if (res.statusCode === 429) {
						const retryAfterHeader = (
							res.headers as Record<string, string | string[] | undefined>
						)["retry-after"];
						finish({
							kind: "rate-limited",
							retryAfter:
								parseRetryAfter(retryAfterHeader ?? null, Date.now()) ??
								DEFAULT_RATE_LIMIT_BACKOFF,
						});
						return;
					}
					finish({ kind: "error" });
				});
			},
		);

		req.on("error", () => finish({ kind: "error" }));
		req.on("timeout", () => {
			req.destroy();
			finish({ kind: "error" });
		});
		req.end();
	});
}

function parseUsageResponse(raw: string): UsageData | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return null;
	}
	const obj = parsed as Record<string, unknown>;
	const fiveHour = obj.five_hour as Record<string, unknown> | undefined;
	const sevenDay = obj.seven_day as Record<string, unknown> | undefined;
	const extraUsage = obj.extra_usage as Record<string, unknown> | undefined;
	return {
		sessionUtilization:
			fiveHour?.utilization != null ? Number(fiveHour.utilization) : null,
		sessionResetAt:
			typeof fiveHour?.resets_at === "string" ? fiveHour.resets_at : null,
		weeklyUtilization:
			sevenDay?.utilization != null ? Number(sevenDay.utilization) : null,
		weeklyResetAt:
			typeof sevenDay?.resets_at === "string" ? sevenDay.resets_at : null,
		extraEnabled:
			typeof extraUsage?.is_enabled === "boolean"
				? extraUsage.is_enabled
				: null,
		extraLimit:
			extraUsage?.monthly_limit != null
				? Number(extraUsage.monthly_limit)
				: null,
		extraUsed:
			extraUsage?.used_credits != null ? Number(extraUsage.used_credits) : null,
		extraUtilization:
			extraUsage?.utilization != null ? Number(extraUsage.utilization) : null,
	};
}

function staleUsageData(): UsageData {
	return {
		sessionUtilization: null,
		sessionResetAt: null,
		weeklyUtilization: null,
		weeklyResetAt: null,
		extraEnabled: null,
		extraLimit: null,
		extraUsed: null,
		extraUtilization: null,
	};
}

async function fetchUsageFromApi(token: string): Promise<UsageData> {
	const now = Math.floor(Date.now() / 1000);

	// Memory cache
	if (cache) {
		const age = now - Math.floor(cache.time / 1000);
		if (
			(cache.error == null && age < CACHE_MAX_AGE) ||
			(cache.error != null && age < cache.errorMaxAge)
		) {
			return cache.data ?? staleUsageData();
		}
	}

	// File cache
	const fileCache = readCacheFile();
	if (fileCache) {
		const age = now - Math.floor(fileCache.time / 1000);
		if (age < CACHE_MAX_AGE && fileCache.data) {
			cache = {
				data: fileCache.data,
				time: fileCache.time,
				error: null,
				errorMaxAge: LOCK_MAX_AGE,
			};
			return fileCache.data;
		}
	}

	// Lock check
	const lock = readLock(now);
	if (lock) {
		const entry: CacheEntry = {
			data: staleUsageData(),
			time: Date.now(),
			error: lock.error,
			errorMaxAge: Math.max(1, lock.blockedUntil - now),
		};
		cache = entry;
		return staleUsageData();
	}

	writeLock(now + LOCK_MAX_AGE, "timeout");

	const resp = await fetchApi(token);
	if (resp.kind === "rate-limited") {
		writeLock(now + resp.retryAfter, "rate-limited");
		const entry: CacheEntry = {
			data: staleUsageData(),
			time: Date.now(),
			error: "rate-limited",
			errorMaxAge: resp.retryAfter,
		};
		cache = entry;
		return staleUsageData();
	}
	if (resp.kind === "error") {
		const entry: CacheEntry = {
			data: staleUsageData(),
			time: Date.now(),
			error: "api-error",
			errorMaxAge: LOCK_MAX_AGE,
		};
		cache = entry;
		return staleUsageData();
	}

	const data = parseUsageResponse(resp.body);
	if (!data) {
		const entry: CacheEntry = {
			data: staleUsageData(),
			time: Date.now(),
			error: "parse-error",
			errorMaxAge: LOCK_MAX_AGE,
		};
		cache = entry;
		return staleUsageData();
	}

	if (data.sessionUtilization == null && data.weeklyUtilization == null) {
		const entry: CacheEntry = {
			data: staleUsageData(),
			time: Date.now(),
			error: "parse-error",
			errorMaxAge: LOCK_MAX_AGE,
		};
		cache = entry;
		return staleUsageData();
	}

	writeCacheFile(data);
	cache = { data, time: Date.now(), error: null, errorMaxAge: LOCK_MAX_AGE };
	return data;
}

export async function getUsageData(): Promise<UsageData | null> {
	const storage = AuthStorage.create();
	const token = await storage.getApiKey("anthropic");
	if (!token) {
		return null;
	}
	try {
		return await fetchUsageFromApi(token);
	} catch {
		return null;
	}
}

export function formatResetTime(resetAt: string | null): string | null {
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

export function formatUsageStatus(data: UsageData): string | null {
	const parts: string[] = [];

	if (data.sessionUtilization != null) {
		parts.push(`${Math.round(data.sessionUtilization)}%`);
	}

	if (data.weeklyUtilization != null) {
		parts.push(`${Math.round(data.weeklyUtilization)}%`);
	}

	return parts.length > 0 ? parts.join(" │ ") : null;
}
