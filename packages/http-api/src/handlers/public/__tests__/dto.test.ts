import { describe, expect, it } from "bun:test";
import {
	computeWeeklyWorkloads,
	type RunwayAccountSource,
} from "@clankermux/core";
import type { RequestResponse } from "@clankermux/types";
import { assertPublicSchema } from "../../../../../../scripts/public-api/validate";
import type {
	PublicAccountSnapshot,
	PublicSnapshot,
	PublicWindowSnapshot,
} from "../../../services/public-snapshot";
import {
	MAX_STRING_BYTES,
	toPublicAccountsDto,
	toPublicRequestDoneDto,
	toPublicStatusDto,
	toPublicWindowForecastDto,
	truncateUtf8,
} from "../dto";
import { toPublicWorkloadsDto } from "../workloads-dto";
import {
	assertCountsAreStatedWholeNumbers,
	assertInstantsAreIso,
} from "./wire-contract";

const NOW = Date.parse("2026-09-09T12:00:00Z");
const window = (
	over: Partial<PublicWindowSnapshot> = {},
): PublicWindowSnapshot => ({
	kind: "seven_day",
	scopeId: null,
	label: "Weekly",
	utilizationPct: 60,
	observedAtMs: NOW,
	resetsAtMs: NOW + 5 * 86400000,
	prediction: null,
	forecast: {
		state: "projected",
		exhaustsAtMs: NOW + 86400000,
		lowConfidence: false,
	},
	...over,
});
const account = (
	over: Partial<PublicAccountSnapshot> = {},
): PublicAccountSnapshot => ({
	id: "example",
	name: "Example",
	provider: "anthropic",
	paused: false,
	pauseReason: null,
	cause: null,
	availableAtMs: null,
	credentialState: "valid",
	credentialExpiresAtMs: null,
	measurementState: "fresh",
	usageObservedAtMs: NOW,
	utilizationPct: 60,
	windows: [window()],
	isDefaultCandidate: true,
	...over,
});
const snapshot = (a = account()): PublicSnapshot =>
	({
		nowMs: NOW,
		accounts: [a],
		pool: { configured: 1, paused: 0 },
	}) as PublicSnapshot;
describe("replacement public contract", () => {
	it("keeps account identity and windows, removing ambiguous duplicate metrics", () => {
		const dto = toPublicAccountsDto(snapshot());
		expect(Object.keys(dto.accounts[0] ?? {})).toEqual([
			"id",
			"name",
			"provider",
			"availability",
			"credential",
			"measurementState",
			"usageObservedAt",
			"windows",
		]);
		expect(dto.accounts[0]?.windows[0]?.forecast).toEqual({
			outcome: "exhausts_before_reset",
			quality: "supported",
			reason: null,
			exhaustsAt: new Date(NOW + 86400000).toISOString(),
			reassessAt: null,
		});
		expect(dto.accounts[0]?.windows[0]).not.toHaveProperty("prediction");
		assertPublicSchema("accounts", dto);
		assertInstantsAreIso(dto);
	});
	it("does not serialize upstream secrets or extra snapshot fields", () => {
		const a = Object.assign(account(), {
			accessToken: "SECRET",
			identityEmail: "SECRET",
		});
		a.windows[0] = Object.assign(window(), { secret: "SECRET" });
		expect(JSON.stringify(toPublicAccountsDto(snapshot(a)))).not.toContain(
			"SECRET",
		);
	});
	it("preserves long IDs while bounding UTF-8 labels", () => {
		const dto = toPublicAccountsDto(
			snapshot(account({ id: "x".repeat(200), name: "🙂".repeat(100) })),
		);
		expect(dto.accounts[0]?.id).toHaveLength(200);
		expect(Buffer.byteLength(dto.accounts[0]?.name ?? "")).toBeLessThanOrEqual(
			MAX_STRING_BYTES,
		);
		expect(truncateUtf8("🙂", 3)).toBe("");
	});
	it("never reports after-reset extrapolation as exhaustion", () => {
		expect(
			toPublicWindowForecastDto(
				window({
					forecast: {
						state: "projected",
						exhaustsAtMs: NOW + 8 * 86400000,
						lowConfidence: false,
					},
				}),
				NOW,
			),
		).toMatchObject({ outcome: "lasts_until_reset", exhaustsAt: null });
		expect(
			toPublicWindowForecastDto(window({ resetsAtMs: NOW }), NOW),
		).toMatchObject({ outcome: "unknown", reason: "reset_elapsed" });
	});
	it.each([
		"no-usage",
		"unstarted",
		"short-history",
	] as const)("explains learning: %s", (reason) => {
		const dto = toPublicWindowForecastDto(
			window({
				forecast: { state: "learning", reason, readyAtMs: NOW + 3600000 },
			}),
			NOW,
		);
		expect(dto.quality).toBe("unavailable");
		expect(dto.reason).toBe(reason.replaceAll("-", "_"));
		expect(dto.reassessAt).toBe(
			reason === "short-history" ? new Date(NOW + 3600000).toISOString() : null,
		);
	});
	it("marks stale window forecasts unavailable", () => {
		expect(
			toPublicAccountsDto(snapshot(account({ measurementState: "stale" })))
				.accounts[0]?.windows[0]?.forecast,
		).toMatchObject({
			quality: "unavailable",
			reason: "stale",
			exhaustsAt: null,
		});
	});
	it("separates ready service from account capacity", () => {
		const dto = toPublicStatusDto(snapshot(), { version: "test", uptimeS: 42 });
		expect(dto).toEqual({
			schema: "clankermux.public.status.v1",
			generatedAt: new Date(NOW).toISOString(),
			serviceState: "ready",
			version: "test",
			uptimeS: 42,
			accounts: { configured: 1, paused: 0 },
		});
		assertPublicSchema("status", dto);
	});
	it("serializes independent availability and forecast timestamps and named coverage", () => {
		const source: RunwayAccountSource = {
			id: "example",
			name: "PRIVATE",
			provider: "anthropic",
			usageData: null,
			usageObservedAtMs: NOW,
			windowObservations: {
				fiveHour: null,
				sevenDay: { pct: 60, resetMs: NOW + 5 * 86400000 },
			},
		};
		const weekly = computeWeeklyWorkloads([source], NOW);
		const dto = toPublicWorkloadsDto(
			[
				{
					id: "class:anthropic",
					label: "Claude",
					parentId: null,
					computedAtMs: NOW + 30000,
					availableAccounts: 1,
					constrainedAccounts: 0,
					unknownAccounts: 0,
					nextRecoveryAtMs: null,
				},
			],
			weekly,
			NOW,
			NOW + 30000,
		);
		expect(dto.workloads[0]?.weekly.computedAt).not.toBe(
			dto.workloads[0]?.availability.computedAt,
		);
		expect(dto.workloads[0]?.weekly.coverage).toEqual({
			eligibleAccounts: 1,
			modeledAccounts: 1,
			idleAccounts: 0,
			learningAccounts: 0,
			unavailableAccounts: 0,
		});
		expect(JSON.stringify(dto)).not.toContain("PRIVATE");
		assertPublicSchema("workloads", dto);
		assertInstantsAreIso(dto);
		assertCountsAreStatedWholeNumbers(dto);
	});
});

describe("public request cost provenance", () => {
	it.each([
		[0, "reported", 0, "reported"],
		[0.02, "estimated", 0.02, "estimated"],
		[0.02, undefined, 0.02, "unknown"],
		[undefined, "reported", null, "unknown"],
		[0.02, "untrusted", 0.02, "unknown"],
	] as const)("maps cost %s with source %s", (costUsd, costSource, expectedCost, expectedSource) => {
		const dto = toPublicRequestDoneDto(
			{
				id: "cost-test",
				method: "POST",
				path: "/v1/messages",
				costUsd,
				costSource,
			} as RequestResponse,
			NOW,
		);
		expect(dto.costUsd).toBe(expectedCost);
		expect(dto.costSource).toBe(expectedSource);
	});
});
