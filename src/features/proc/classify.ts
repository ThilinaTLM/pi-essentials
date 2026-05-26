import type { ClassifyConfig, ProcLogLevel } from "./types.js";

const ESC = "\\u001B";
const CSI = "\\u009B";
const BEL = "\\u0007";
const ANSI_PATTERN = new RegExp(
	`[${ESC}${CSI}][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?${BEL})|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))`,
	"g",
);
const URL_PATTERN = /https?:\/\/[^\s)\]}'"]+/g;

export interface Rule {
	tag: string;
	regex: RegExp;
	/** If `negate` matches the line, the rule does NOT fire. */
	negate?: RegExp;
}

/**
 * Patterns that *count as errors when they appear in log output*. Crafted to
 * avoid the v1 false-positive storm (e.g. "0 errors", "no errors found",
 * ErrorBoundary identifiers, paths under error.ts).
 */
const ERROR_RULES: Rule[] = [
	{
		// "Error:" / "error:" header form. Excludes "no errors", "0 errors",
		// trailing identifiers like ErrorBoundary, and "any errors?" prose.
		tag: "error",
		regex: /(^|[\s[(>])errors?:\s/i,
		negate: /\b(no|0|zero)\s+errors?\b|errors?\s+(found|reported|encountered)/i,
	},
	{
		// Common stack-frame intros: "    at fn (file:line:col)"
		tag: "stack-frame",
		regex: /^\s+at\s+\S+.*\(.+:\d+:\d+\)?$/,
	},
	{
		tag: "fatal",
		regex: /\bfatal(?:\s+error)?\b[:\s]/i,
	},
	{
		tag: "panic",
		regex: /^panic:|^\s*goroutine\s+\d+\s+\[/i,
	},
	{
		tag: "exception",
		regex: /\b(uncaught|unhandled)\s+(exception|promise|error)\b/i,
	},
	{
		tag: "traceback",
		regex: /^Traceback\s+\(most\s+recent\s+call\s+last\):\s*$/i,
	},
	{
		tag: "address-in-use",
		regex: /\bEADDRINUSE\b|address already in use/i,
	},
	{
		tag: "module-not-found",
		regex:
			/Cannot find module|Module not found|ERR_MODULE_NOT_FOUND|ModuleNotFoundError/i,
	},
	{
		tag: "typescript",
		// TS2345: foo. Standalone TS error code form, not "TS1234" inside text.
		regex: /\bTS\d{4}:\s/,
	},
	{
		tag: "compile",
		regex:
			/^(?:×|✘|✖)\s|Build failed|Failed to compile|Compilation (?:failed|error)|SyntaxError\b/i,
	},
	{
		tag: "bundler",
		// Anchor to the framework name + "error" to avoid matching generic prose.
		regex: /\[(?:vite|webpack|next|esbuild|rollup|parcel)\][^\n]*\berror\b/i,
	},
	{
		tag: "errno",
		regex: /\b(ENOENT|EACCES|EPERM|EBUSY|ENOTDIR|EISDIR|ECONNREFUSED):\s/,
	},
	{
		tag: "http-5xx",
		regex: /\b(?:HTTP\/[\d.]+\s+)?5\d{2}\b/,
	},
];

const WARN_RULES: Rule[] = [
	{
		tag: "warning",
		regex: /(^|[\s[(>])warn(?:ing)?[:!]/i,
	},
	{
		tag: "deprecated",
		regex: /\b(deprecated|deprecation)\b/i,
	},
];

export interface ClassifiedLine {
	level: ProcLogLevel;
	ansiStripped: string;
	tags: string[];
	urls: string[];
}

export function stripAnsi(input: string): string {
	return input.replace(ANSI_PATTERN, "");
}

export function detectUrls(input: string): string[] {
	return Array.from(new Set(input.match(URL_PATTERN) ?? []));
}

function ruleMatches(rule: Rule, text: string): boolean {
	if (!rule.regex.test(text)) return false;
	if (rule.negate?.test(text)) return false;
	return true;
}

function compileUserPatterns(
	patterns: string[] | undefined,
	tag: string,
): Rule[] {
	if (!patterns) return [];
	return patterns
		.map((source) => {
			try {
				return { tag, regex: new RegExp(source, "i") } satisfies Rule;
			} catch {
				return null;
			}
		})
		.filter((rule): rule is Rule => rule !== null);
}

export function classifyLine(
	line: string,
	config?: ClassifyConfig,
): ClassifiedLine {
	const ansiStripped = stripAnsi(line);

	// Internal supervisor diagnostics never count as errors / warnings —
	// they're our own metadata, not the child program's output.
	if (/^\[pi-proc]\s/.test(ansiStripped)) {
		return {
			level: "info",
			ansiStripped,
			tags: ["pi-proc-internal"],
			urls: detectUrls(ansiStripped),
		};
	}

	const tags: string[] = [];

	const errorRules = [
		...ERROR_RULES,
		...compileUserPatterns(config?.errorPatterns, "user-error"),
	];
	for (const rule of errorRules) {
		if (ruleMatches(rule, ansiStripped)) tags.push(rule.tag);
	}
	if (tags.length > 0) {
		return {
			level: "error",
			ansiStripped,
			tags: Array.from(new Set(tags)),
			urls: detectUrls(ansiStripped),
		};
	}

	for (const rule of WARN_RULES) {
		if (ruleMatches(rule, ansiStripped)) tags.push(rule.tag);
	}

	return {
		level: tags.length > 0 ? "warn" : "info",
		ansiStripped,
		tags: Array.from(new Set(tags)),
		urls: detectUrls(ansiStripped),
	};
}

export function matchesReady(line: string, config?: ClassifyConfig): boolean {
	if (!config?.readyPatterns?.length) return false;
	for (const source of config.readyPatterns) {
		try {
			if (new RegExp(source, "i").test(line)) return true;
		} catch {
			// ignore bad user regex
		}
	}
	return false;
}
