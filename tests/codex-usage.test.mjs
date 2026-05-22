import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	parseCodexUsageHeaders,
	parseCodexUsageResponse,
} from "../src/features/usage/codex-client.ts";

const NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

describe("Codex usage parsing", () => {
	test("normalizes ChatGPT wham usage responses", () => {
		const parsed = parseCodexUsageResponse(
			{
				plan_type: "plus",
				rate_limit: {
					primary_window: {
						used_percent: 42.4,
						reset_after_seconds: 3600,
						limit_window_seconds: 18_000,
					},
					secondary_window: {
						used_percent: 12,
						reset_at: Math.floor(NOW_MS / 1000) + 7200,
						limit_window_seconds: 604_800,
					},
				},
				credits: {
					balance: "123.45",
					has_credits: true,
					unlimited: false,
				},
			},
			NOW_MS,
		);

		assert.deepEqual(parsed, {
			primaryUsedPercent: 42.4,
			primaryResetAfterSeconds: 3600,
			primaryWindowMinutes: 300,
			secondaryUsedPercent: 12,
			secondaryResetAfterSeconds: 7200,
			secondaryWindowMinutes: 10_080,
			planType: "plus",
			creditsBalance: "123.45",
			creditsHasCredits: true,
			creditsUnlimited: false,
			activeLimit: null,
		});
	});

	test("returns null for wham usage responses without primary or secondary usage", () => {
		assert.equal(parseCodexUsageResponse({ plan_type: "plus" }, NOW_MS), null);
	});

	test("parses x-codex headers with reset-after-seconds", () => {
		const parsed = parseCodexUsageHeaders(
			{
				"X-Codex-Primary-Used-Percent": "55.6",
				"x-codex-primary-reset-after-seconds": "1200",
				"x-codex-primary-window-minutes": "300",
				"x-codex-secondary-used-percent": "7",
				"x-codex-secondary-reset-after-seconds": "86400",
				"x-codex-secondary-window-minutes": "10080",
				"x-codex-plan-type": "pro",
				"x-codex-credits-balance": "9",
				"x-codex-credits-has-credits": "true",
				"x-codex-credits-unlimited": "false",
				"x-codex-active-limit": "codex",
			},
			NOW_MS,
		);

		assert.deepEqual(parsed, {
			primaryUsedPercent: 55.6,
			primaryResetAfterSeconds: 1200,
			primaryWindowMinutes: 300,
			secondaryUsedPercent: 7,
			secondaryResetAfterSeconds: 86400,
			secondaryWindowMinutes: 10080,
			planType: "pro",
			creditsBalance: "9",
			creditsHasCredits: true,
			creditsUnlimited: false,
			activeLimit: "codex",
		});
	});

	test("parses x-codex reset-at headers and prefers reset-after-seconds", () => {
		const parsed = parseCodexUsageHeaders(
			{
				"x-codex-primary-used-percent": "1",
				"x-codex-primary-reset-at": String(Math.floor(NOW_MS / 1000) + 900),
				"x-codex-secondary-used-percent": "2",
				"x-codex-secondary-reset-after-seconds": "30",
				"x-codex-secondary-reset-at": String(Math.floor(NOW_MS / 1000) + 900),
			},
			NOW_MS,
		);

		assert.equal(parsed?.primaryResetAfterSeconds, 900);
		assert.equal(parsed?.secondaryResetAfterSeconds, 30);
	});

	test("returns null for non-Codex headers", () => {
		assert.equal(
			parseCodexUsageHeaders({ "content-type": "application/json" }),
			null,
		);
	});
});
