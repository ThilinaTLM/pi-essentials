import type { Rule } from "./classify.js";

/**
 * Per-framework auto-detection + extra error/ready rules. The base error
 * rules in `classify.ts` are framework-agnostic; profiles add tighter
 * patterns that would risk false positives if always-on (e.g. `^FAILED\b`
 * is meaningful in pytest but noise in many other contexts).
 *
 * Adding a new framework is intentionally a single object literal in
 * `PROFILES` below — no plugin system.
 */
export type FrameworkId =
	| "vite"
	| "next"
	| "remix"
	| "astro"
	| "cargo"
	| "maven"
	| "gradle"
	| "pytest"
	| "jest"
	| "vitest"
	| "node"
	| "deno"
	| "bun"
	| "unknown";

export interface FrameworkProfile {
	id: FrameworkId;
	/** Regex(es) that confirm this framework is producing the output. */
	detectPatterns: RegExp[];
	/** Patterns that count as "the server is ready" for this framework. */
	readyPatterns: RegExp[];
	/** Extra error/warning rules to layer on top of the base set. */
	errorRules: Rule[];
}

const PROFILES: FrameworkProfile[] = [
	{
		id: "vite",
		detectPatterns: [/^\s*VITE\s+v\d/, /^\s*\[vite\]/i],
		readyPatterns: [/Local:\s+https?:\/\//i, /ready in\s+\d+/i],
		errorRules: [
			{
				tag: "vite",
				regex: /\[vite\][^\n]*\b(error|failed)\b/i,
			},
		],
	},
	{
		id: "next",
		detectPatterns: [/▲\s*Next\.js/, /\bNext\.js\s+v?\d/i],
		readyPatterns: [
			/compiled successfully/i,
			/Ready in\s+\d/i,
			/started server on\s+http/i,
		],
		errorRules: [
			{
				tag: "next",
				regex: /^\s*✘\s|^\s*Failed to compile|^\s*⨯\s/,
			},
		],
	},
	{
		id: "remix",
		detectPatterns: [/Remix App Server/i, /\[remix\]/i],
		readyPatterns: [/💿\s.*Remix App Server started/i, /listening on/i],
		errorRules: [],
	},
	{
		id: "astro",
		detectPatterns: [/^\s*astro\s+v\d/, /\bAstro\s+v\d/i],
		readyPatterns: [/Local\s+https?:\/\//i, /watching for file changes/i],
		errorRules: [],
	},
	{
		id: "cargo",
		detectPatterns: [/^\s*Compiling\s+\S+\s+v\d/, /^\s*Finished\s+`?dev`?\s/],
		readyPatterns: [/^\s*Running\b/],
		errorRules: [
			{
				tag: "rustc",
				regex: /^error\[E\d+\]/i,
			},
			{
				tag: "cargo",
				regex: /^error:\s/i,
			},
		],
	},
	{
		id: "maven",
		detectPatterns: [/^\[INFO\] Scanning for projects/, /^\[INFO\] Apache Maven/],
		readyPatterns: [/^\[INFO\] BUILD SUCCESS/, /Started\s+\S+\s+in\s+[\d.]+\s+seconds/],
		errorRules: [
			{
				tag: "maven",
				regex: /^\[ERROR\]/,
			},
		],
	},
	{
		id: "gradle",
		detectPatterns: [/^>\s*Task\s+:/, /Welcome to Gradle/i],
		readyPatterns: [/BUILD SUCCESSFUL/i, /Started\s+\S+\s+in\s+[\d.]+\s+seconds/],
		errorRules: [
			{
				tag: "gradle",
				regex: /^FAILURE:\s/,
			},
		],
	},
	{
		id: "pytest",
		detectPatterns: [/^=+\s+test session starts\s+=+/, /^pytest\s+\d/],
		readyPatterns: [], // one-shot
		errorRules: [
			{
				tag: "pytest-failed",
				regex: /^FAILED\s+\S+::/,
			},
			{
				tag: "pytest-error",
				regex: /^E\s{2,}/,
			},
		],
	},
	{
		id: "vitest",
		detectPatterns: [/RUN\s+v\d.*vitest/i, /^\s*Vitest\s+v\d/i],
		readyPatterns: [],
		errorRules: [
			{
				tag: "vitest",
				regex: /^\s*FAIL\s+\S+/,
			},
		],
	},
	{
		id: "jest",
		detectPatterns: [/Test Suites?:\s+\d/, /^\s*PASS\s+\S+|^\s*FAIL\s+\S+/],
		readyPatterns: [],
		errorRules: [
			{
				tag: "jest",
				regex: /^\s*●\s/, // Jest's failure bullet
			},
		],
	},
	{
		id: "bun",
		detectPatterns: [/^Bun\s+v\d/, /^bun\s+run\s/i],
		readyPatterns: [/Listening on/i, /started on/i],
		errorRules: [],
	},
	{
		id: "deno",
		detectPatterns: [/^Deno\s+v?\d/i, /Listening on http/],
		readyPatterns: [/Listening on http/i, /Watcher\s+Process\s+started/i],
		errorRules: [],
	},
	{
		id: "node",
		// Catch-all: only fires if literally nothing else matched, since this
		// profile would otherwise eat too much. We never actively `detect()`
		// node — it's the fallback returned by `detectFramework`.
		detectPatterns: [],
		readyPatterns: [
			/Listening on/i,
			/Server started/i,
			/Server (?:listening|running) on/i,
		],
		errorRules: [],
	},
];

export const UNKNOWN_PROFILE: FrameworkProfile = {
	id: "unknown",
	detectPatterns: [],
	readyPatterns: [],
	errorRules: [],
};

/**
 * Inspect the first ~50 lines of output to identify the framework. Returns
 * the matched profile, or `UNKNOWN_PROFILE` if nothing matches.
 *
 * Detection is intentionally first-match-wins: profiles are listed roughly
 * in popularity order. Adding ambiguous detect patterns to later profiles
 * is safe.
 */
export function detectFramework(headLines: readonly string[]): FrameworkProfile {
	for (const profile of PROFILES) {
		if (profile.detectPatterns.length === 0) continue;
		for (const line of headLines) {
			for (const pattern of profile.detectPatterns) {
				if (pattern.test(line)) return profile;
			}
		}
	}
	return UNKNOWN_PROFILE;
}

/**
 * Library of framework-agnostic ready-signal patterns. These fire for any
 * run unless `--no-auto-ready` is set.
 */
export const AUTO_READY_PATTERNS: RegExp[] = [
	/\blocal:\s+https?:\/\//i,
	/\bready in\s+\d+/i,
	/\blistening on\b/i,
	/\bserver (?:started|listening|running)\b/i,
	/\bcompiled successfully\b/i,
	/\baccepting connections\b/i,
	/\bnow listening\b/i,
];

/**
 * True if `line` matches any auto-ready pattern OR any of the framework
 * profile's own ready patterns.
 */
export function matchesAutoReady(
	line: string,
	profile: FrameworkProfile = UNKNOWN_PROFILE,
): boolean {
	for (const pattern of AUTO_READY_PATTERNS) {
		if (pattern.test(line)) return true;
	}
	for (const pattern of profile.readyPatterns) {
		if (pattern.test(line)) return true;
	}
	return false;
}

/** Test-only: exposes the full profile list. */
export function _profiles(): readonly FrameworkProfile[] {
	return PROFILES;
}
