/**
 * The subscription period Devin already reports in `GetUserStatus` and the
 * normalizer used to discard: `planStart`, `planEnd`, `gracePeriodStatus` and
 * `gracePeriodEnd`.
 */
import { describe, expect, it } from "bun:test";
import { extractDevinSubscriptionState, normalizeDevinUsage } from "../client";
import {
	GetUserStatusResponseSchema,
	GracePeriodStatus,
	PlanStatusSchema,
	TimestampSchema,
	UserStatusSchema,
} from "../vendor/devin-proto";
import { create } from "../vendor/protobuf";

/** 2026-04-10T10:00:00Z and 2026-10-03T10:00:00Z in whole seconds. */
const PLAN_START_SECONDS = 1_775_815_200;
const PLAN_END_SECONDS = 1_791_367_200;

function statusResponse(planStatus: Record<string, unknown>) {
	return create(GetUserStatusResponseSchema, {
		userStatus: create(UserStatusSchema, {
			planStatus: create(PlanStatusSchema, planStatus),
		}),
	});
}

describe("normalizeDevinUsage — subscription period", () => {
	it("converts the plan bounds to ms", () => {
		const usage = normalizeDevinUsage(
			statusResponse({
				planStart: create(TimestampSchema, {
					seconds: BigInt(PLAN_START_SECONDS),
				}),
				planEnd: create(TimestampSchema, { seconds: BigInt(PLAN_END_SECONDS) }),
			}),
		);

		expect(usage.planStartMs).toBe(PLAN_START_SECONDS * 1000);
		expect(usage.planEndMs).toBe(PLAN_END_SECONDS * 1000);
	});

	it("reports an absent or zero timestamp as null, never the epoch", () => {
		const absent = normalizeDevinUsage(statusResponse({}));
		expect(absent.planStartMs).toBeNull();
		expect(absent.planEndMs).toBeNull();
		expect(absent.gracePeriodEndMs).toBeNull();

		const zeroed = normalizeDevinUsage(
			statusResponse({
				planEnd: create(TimestampSchema, { seconds: 0n }),
			}),
		);
		expect(zeroed.planEndMs).toBeNull();
	});

	it("lowercases the grace-period status and drops UNSPECIFIED", () => {
		expect(
			normalizeDevinUsage(
				statusResponse({ gracePeriodStatus: GracePeriodStatus.ACTIVE }),
			).gracePeriodStatus,
		).toBe("active");
		expect(
			normalizeDevinUsage(
				statusResponse({ gracePeriodStatus: GracePeriodStatus.EXPIRED }),
			).gracePeriodStatus,
		).toBe("expired");
		expect(
			normalizeDevinUsage(
				statusResponse({ gracePeriodStatus: GracePeriodStatus.NONE }),
			).gracePeriodStatus,
		).toBe("none");
		expect(
			normalizeDevinUsage(
				statusResponse({ gracePeriodStatus: GracePeriodStatus.UNSPECIFIED }),
			).gracePeriodStatus,
		).toBeNull();
	});

	it("captures a running grace period's end", () => {
		const usage = normalizeDevinUsage(
			statusResponse({
				gracePeriodStatus: GracePeriodStatus.ACTIVE,
				gracePeriodEnd: create(TimestampSchema, {
					seconds: BigInt(PLAN_END_SECONDS),
				}),
			}),
		);

		expect(usage.gracePeriodEndMs).toBe(PLAN_END_SECONDS * 1000);
	});
});

describe("extractDevinSubscriptionState", () => {
	it("reports renewal intent as unreported, never as false", () => {
		// Devin states a period end and nothing about renewal. A false here would
		// relabel a healthy account's date as "Ends".
		expect(
			extractDevinSubscriptionState(
				{ planEndMs: PLAN_END_SECONDS * 1000, gracePeriodEndMs: null },
				5_000,
			),
		).toEqual({
			endsAtMs: PLAN_END_SECONDS * 1000,
			willRenew: null,
			graceEndsAtMs: null,
			checkedAtMs: 5_000,
		});
	});

	it("records the attempt even when nothing was reported", () => {
		expect(
			extractDevinSubscriptionState(
				{ planEndMs: null, gracePeriodEndMs: null },
				7_000,
			),
		).toEqual({
			endsAtMs: null,
			willRenew: null,
			graceEndsAtMs: null,
			checkedAtMs: 7_000,
		});
	});
});
