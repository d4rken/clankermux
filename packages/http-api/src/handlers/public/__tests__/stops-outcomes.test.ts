import { describe, expect, it } from "bun:test";
import {
	classifyRequestOutcomeCause,
	outcomeForCause,
	STOP_CAUSES,
	type StopsHistoryResponse,
} from "@clankermux/types";
import { assertPublicSchema } from "../../../../../../scripts/public-api/validate";
import {
	toPublicErrorCategory,
	toPublicStopCause,
	toPublicStopsDto,
} from "../dto";

describe("public Stops outcome contract", () => {
	it("publishes only blocked causes and additive aggregate outcome counts", () => {
		const summary: StopsHistoryResponse = {
			range: "7d",
			bucketMs: 3600000,
			windowStartsAt: 0,
			windowEndsAt: 1,
			totalRequests: 1000,
			blockedRequests: 2,
			outcomeTotals: {
				blocked: 2,
				failed: 1,
				disconnected: 129,
				unclassified: 3,
			},
			excludedAttemptAuditRows: 31,
			causes: (
				[
					["pool_quota_exhausted", 2],
					["all_accounts_failed", 1],
					["client_disconnected", 129],
					["other", 3],
				] as const
			).map(([cause, count]) => ({
				cause,
				count,
				firstSeenMs: 0,
				lastSeenMs: 1,
				topRequestedModel: "private-model",
				topRequestedModelCount: count,
				sampleErrorMessage: "private sample",
				series: [{ ts: 0, count }],
			})),
			candidates: {
				observedRequests: 1000,
				zeroCandidateRequests: 2,
				distribution: [{ candidatesCount: 2, requests: 1000 }],
			},
		};
		const dto = toPublicStopsDto(summary, 1);
		expect(dto.blockedRequests).toBe(2);
		expect(dto.failedRequests).toBe(1);
		expect(dto.disconnectedRequests).toBe(129);
		expect(dto.unclassifiedRequests).toBe(3);
		expect(dto.excludedAttemptAuditRows).toBe(31);
		expect(dto.causes.map((c) => c.cause)).toEqual(["pool_quota_exhausted"]);
		expect(dto.causes.reduce((n, c) => n + c.count, 0)).toBe(
			dto.blockedRequests,
		);
		expect(JSON.stringify(dto)).not.toContain("private");
		expect(JSON.stringify(dto)).not.toContain("series");
		assertPublicSchema("stops", dto);
	});
	it("maps every blocked history cause to the existing public vocabulary", () => {
		for (const cause of STOP_CAUSES)
			if (outcomeForCause(cause) === "blocked")
				expect(toPublicStopCause(cause)).not.toBe("other");
	});
	it("keeps event-stream categories stable where history now has more precise causes", () => {
		expect(toPublicErrorCategory("all_accounts_failed", 503)).toBe(
			"pool_quota_exhausted",
		);
		expect(classifyRequestOutcomeCause("all_accounts_failed", 503)).toBe(
			"all_accounts_failed",
		);
		expect(toPublicErrorCategory("pinned_account_missing", 503)).toBe(
			"upstream_error",
		);
		expect(toPublicErrorCategory("anthropic_excluded_no_account", 503)).toBe(
			"pool_quota_exhausted",
		);
		expect(toPublicErrorCategory("client disconnected", 200)).toBe(
			"client_disconnected",
		);
		expect(toPublicErrorCategory("request timed out", 200)).toBe(
			"request_timed_out",
		);
		expect(toPublicErrorCategory("stream error", 200)).toBe("stream_error");
		expect(toPublicErrorCategory("native_responses_no_terminal", 200)).toBe(
			"other",
		);
	});
});
