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

const CODEX_HEADER_PREFIX = "x-codex-";

function getHeader(
	headers: Record<string, string>,
	name: string,
): string | undefined {
	// Try lowercased (Node.js normalizes headers to lowercase)
	const lower = `${CODEX_HEADER_PREFIX}${name}`.toLowerCase();
	if (headers[lower] !== undefined) return headers[lower];
	// Try original casing
	const original = `${CODEX_HEADER_PREFIX}${name}`;
	if (headers[original] !== undefined) return headers[original];
	return undefined;
}

export function parseCodexHeaders(
	headers: Record<string, string>,
): CodexUsageData | null {
	const pct = getHeader(headers, "primary-used-percent");
	const secPct = getHeader(headers, "secondary-used-percent");

	// If neither primary nor secondary percent is present, these aren't codex headers
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

export function formatResetAfterSeconds(seconds: number | null): string | null {
	if (seconds == null || seconds <= 0) return null;

	const totalMinutes = Math.floor(seconds / 60);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;

	if (hours > 0) {
		return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
	}
	return `${minutes}m`;
}

export function formatCodexUsageStatus(data: CodexUsageData): string | null {
	const parts: string[] = [];

	if (data.primaryUsedPercent != null) {
		parts.push(`${Math.round(data.primaryUsedPercent)}%`);
	}

	if (data.secondaryUsedPercent != null) {
		parts.push(`${Math.round(data.secondaryUsedPercent)}%`);
	}

	return parts.length > 0 ? parts.join(" │ ") : null;
}
