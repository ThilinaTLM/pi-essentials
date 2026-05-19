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
import { AuthStorage } from "@earendil-works/pi-coding-agent";

const CACHE_DIR = join(homedir(), ".pi", "agent", "cache", "usage");
const CACHE_FILE = join(CACHE_DIR, "usage.json");
const LOCK_FILE = join(CACHE_DIR, "usage.lock");
const CACHE_MAX_AGE = 30;
const LOCK_MAX_AGE = 10;
const API_HOST = "api.anthropic.com";
const API_PATH = "/api/oauth/usage";
const API_TIMEOUT_MS = 5000;
const DEFAULT_RATE_LIMIT_BACKOFF = 30;

export type AnthropicUsageData = {
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
	data: AnthropicUsageData | null;
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

function readCacheFile(): {
	data: AnthropicUsageData | null;
	time: number;
} | null {
	try {
		const raw = readFileSync(CACHE_FILE, "utf8");
		const parsed = JSON.parse(raw);
		return {
			data: parsed as AnthropicUsageData | null,
			time: statSync(CACHE_FILE).mtimeMs,
		};
	} catch {
		return null;
	}
}

function writeCacheFile(data: AnthropicUsageData): void {
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

function parseUsageResponse(raw: string): AnthropicUsageData | null {
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

async function fetchUsageFromApi(
	token: string,
): Promise<AnthropicUsageData | null> {
	const now = Math.floor(Date.now() / 1000);

	// Memory cache (fresh, success)
	if (cache && cache.error == null) {
		const age = now - Math.floor(cache.time / 1000);
		if (age < CACHE_MAX_AGE) {
			return cache.data;
		}
	}

	// File cache (fresh)
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

	const lastKnown: AnthropicUsageData | null =
		cache?.data ?? fileCache?.data ?? null;

	// In-memory error backoff (still serve last-known data while we wait)
	if (cache && cache.error != null) {
		const age = now - Math.floor(cache.time / 1000);
		if (age < cache.errorMaxAge) {
			return lastKnown;
		}
	}

	// Cross-process lock (another instance is fetching, or recently failed)
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

	const resp = await fetchApi(token);
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

	const data = parseUsageResponse(resp.body);
	if (
		!data ||
		(data.sessionUtilization == null && data.weeklyUtilization == null)
	) {
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

export async function getAnthropicUsageData(): Promise<AnthropicUsageData | null> {
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
