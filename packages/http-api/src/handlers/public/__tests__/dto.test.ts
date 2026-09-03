/**
 * The `/public/v1/*` wire contract, pinned.
 *
 * The consumers are a Cinnamon panel applet and an ESP32-C6 running a streaming
 * JSON scanner, neither of which can be redeployed when this changes. So the
 * things asserted here are not "the mapper works" but the contract itself: the
 * structural limits of the reader, the enums being CLOSED with an `other`
 * escape hatch, every INSTANT being an ISO string and every DURATION a number,
 * identifiers never being truncated, and — the one that matters most on an
 * unauthenticated surface — that no field arrives here that was not named.
 */
import { describe, expect, it } from "bun:test";
import type {
	RateLimitCause,
	RequestResponse,
	StopsHistoryResponse,
} from "@clankermux/types";
import type { PublicRunwaySnapshot } from "../../../services/public-runway";
import type {
	PublicAccountSnapshot,
	PublicSnapshot,
	PublicWindowSnapshot,
} from "../../../services/public-snapshot";
import {
	MAX_STRING_BYTES,
	toPublicAccountDto,
	toPublicAccountsDto,
	toPublicAvailabilityReason,
	toPublicAvailabilityState,
	toPublicCredentialState,
	toPublicMeasurementState,
	toPublicOverloadState,
	toPublicPredictionState,
	toPublicRequestDoneDto,
	toPublicRequestPhase,
	toPublicRunwayDto,
	toPublicRunwayKind,
	toPublicStatusDto,
	toPublicStatusLevel,
	toPublicStopCause,
	toPublicStopsDto,
	toPublicWindowKind,
	truncateUtf8,
} from "../dto";
import { arrayNesting, assertInstantsAreIso, depthOf } from "./wire-contract";

const NOW = 1_699_999_000_000;
const NOW_ISO = "2023-11-14T21:56:40.000Z";

function window(
	over: Partial<PublicWindowSnapshot> = {},
): PublicWindowSnapshot {
	return {
		kind: "five_hour",
		scopeId: null,
		label: "5-hour",
		utilizationPct: 42,
		observedAtMs: NOW - 30_000,
		resetsAtMs: 1_700_000_000_000,
		prediction: null,
		...over,
	};
}

function account(
	over: Partial<PublicAccountSnapshot> = {},
): PublicAccountSnapshot {
	return {
		id: "acct-1",
		name: "primary",
		provider: "anthropic",
		isDefaultCandidate: true,
		paused: false,
		pauseReason: null,
		cause: "ok",
		availableAtMs: null,
		credentialState: "valid",
		credentialExpiresAtMs: 1_700_100_000_000,
		measurementState: "fresh",
		usageObservedAtMs: NOW - 30_000,
		utilizationPct: 42,
		windows: [window()],
		...over,
	};
}

function snapshot(over: Partial<PublicSnapshot> = {}): PublicSnapshot {
	return {
		nowMs: NOW,
		pool: {
			configured: 3,
			defaultRoutable: 2,
			paused: 1,
			rateLimited: 0,
			usageExhausted: 0,
			nextAvailableAtMs: null,
		},
		routing: {
			context: "fresh_unpinned_nominal",
			defaultCandidateAccountId: "acct-1",
		},
		usage: {
			fiveHour: {
				meanUtilizationPct: 42,
				contributingAccountCount: 1,
				unknownAccountCount: 2,
				earliestResetsAtMs: 1_700_000_000_000,
				leastUsedUtilizationPct: 42,
				leastUsedAccountId: "acct-1",
			},
			sevenDay: {
				meanUtilizationPct: null,
				contributingAccountCount: 0,
				unknownAccountCount: 3,
				earliestResetsAtMs: null,
				leastUsedUtilizationPct: null,
				leastUsedAccountId: null,
			},
			worstAccountUtilizationPct: 42,
		},
		providers: [
			{
				provider: "anthropic",
				anyOverload: { state: "closed", untilMs: null, probeActive: false },
				providerWideOverload: {
					state: "closed",
					untilMs: null,
					probeActive: false,
				},
				scopedLimits: [],
			},
		],
		accounts: [account()],
		...over,
	};
}

function runway(
	over: Partial<PublicRunwaySnapshot> = {},
): PublicRunwaySnapshot {
	return {
		generatedAtMs: NOW,
		horizonMs: 1_209_600_000,
		coverage: {
			activeKeyCount: 3,
			statedKeyCount: 2,
			unobservedKeyCount: 1,
		},
		worstStatedOutcome: {
			kind: "runway",
			exhaustsAtMs: 1_700_040_000_000,
			causes: [{ accountId: "acct-1", windowKind: "five_hour" }],
			band: {
				earliestExhaustsAtMs: 1_700_030_000_000,
				latestExhaustsAtMs: 1_700_050_000_000,
				halfWidthPct: 0.5,
			},
		},
		...over,
	};
}

function stops(over: Partial<StopsHistoryResponse> = {}): StopsHistoryResponse {
	return {
		range: "7d",
		bucketMs: 3_600_000,
		windowStartsAt: NOW - 7 * 24 * 3_600_000,
		windowEndsAt: NOW,
		totalRequests: 4_000,
		blockedRequests: 12,
		causes: [
			{
				cause: "pool_quota_exhausted",
				count: 9,
				firstSeenMs: NOW - 3 * 3_600_000,
				lastSeenMs: NOW - 3_600_000,
				// Present on the internal shape, deliberately not on the wire.
				topRequestedModel: "gpt-5.2-codex",
				topRequestedModelCount: 9,
				sampleErrorMessage: "all_accounts_failed",
				series: [{ ts: NOW - 3 * 3_600_000, count: 9 }],
			},
			{
				cause: "model_not_served",
				count: 3,
				firstSeenMs: NOW - 2 * 3_600_000,
				lastSeenMs: NOW - 2 * 3_600_000,
				topRequestedModel: null,
				topRequestedModelCount: 0,
				sampleErrorMessage: null,
				series: [],
			},
		],
		candidates: {
			observedRequests: 3_800,
			zeroCandidateRequests: 12,
			distribution: [
				{ candidatesCount: 0, requests: 12 },
				{ candidatesCount: 2, requests: 3_788 },
			],
		},
		...over,
	};
}

// ---------------------------------------------------------------------------
// Golden payloads
// ---------------------------------------------------------------------------

describe("golden: GET /public/v1/status", () => {
	it("matches the pinned shape exactly", () => {
		expect(
			toPublicStatusDto(snapshot(), { uptimeS: 3_600, version: "2026.8.80" }),
		).toEqual({
			schema: "clankermux.public.status.v1",
			generatedAt: NOW_ISO,
			status: "ok",
			uptimeS: 3_600,
			version: "2026.8.80",
			pool: {
				configured: 3,
				defaultRoutable: 2,
				paused: 1,
				rateLimited: 0,
				usageExhausted: 0,
				nextAvailableAt: null,
			},
			routing: {
				context: "fresh_unpinned_nominal",
				defaultCandidateAccountId: "acct-1",
			},
			usage: {
				fiveHour: {
					meanUtilizationPct: 42,
					contributingAccountCount: 1,
					unknownAccountCount: 2,
					earliestResetsAt: "2023-11-14T22:13:20.000Z",
					leastUsedUtilizationPct: 42,
					leastUsedAccountId: "acct-1",
				},
				sevenDay: {
					meanUtilizationPct: null,
					contributingAccountCount: 0,
					unknownAccountCount: 3,
					earliestResetsAt: null,
					leastUsedUtilizationPct: null,
					leastUsedAccountId: null,
				},
				worstAccountUtilizationPct: 42,
			},
			providers: [
				{
					provider: "anthropic",
					anyOverload: { state: "closed", until: null, probeActive: false },
					providerWideOverload: {
						state: "closed",
						until: null,
						probeActive: false,
					},
					scopedLimits: [],
				},
			],
		});
	});

	it("names the least-used account beside the mean, and whose reading it is", () => {
		// The mean cannot answer a widget's question: routing picks ONE account,
		// so what matters is whether ANY account still has room. The id travels
		// with the percentage or the figure names nobody.
		const dto = toPublicStatusDto(snapshot(), { uptimeS: 1, version: "v" });
		expect(dto.usage.fiveHour.leastUsedUtilizationPct).toBe(42);
		expect(dto.usage.fiveHour.leastUsedAccountId).toBe("acct-1");
	});

	it("states both least-used fields as null when nothing contributed", () => {
		// Never 0: a window nobody reported is not a window at 0% used.
		const dto = toPublicStatusDto(snapshot(), { uptimeS: 1, version: "v" });
		expect(dto.usage.sevenDay.contributingAccountCount).toBe(0);
		expect(dto.usage.sevenDay.leastUsedUtilizationPct).toBeNull();
		expect(dto.usage.sevenDay.leastUsedAccountId).toBeNull();
	});

	it("states the routing context beside the candidate it belongs to", () => {
		// Without the context the candidate reads as "the account the load
		// balancer is using", which is not a thing that exists — routing is per
		// request and this prediction omits every request-dependent gate.
		const dto = toPublicStatusDto(snapshot(), { uptimeS: 1, version: "v" });
		expect(dto.routing.context).toBe("fresh_unpinned_nominal");
		expect(dto.routing.defaultCandidateAccountId).toBe("acct-1");
	});

	it("defines defaultRoutable against that same context", () => {
		// A count that meant something else would contradict the candidate beside
		// it, and a client would have no way to tell which to believe.
		const dto = toPublicStatusDto(
			snapshot({
				pool: {
					configured: 5,
					defaultRoutable: 0,
					paused: 0,
					rateLimited: 5,
					usageExhausted: 0,
					nextAvailableAtMs: 1_700_000_000_000,
				},
				routing: {
					context: "fresh_unpinned_nominal",
					defaultCandidateAccountId: null,
				},
			}),
			{ uptimeS: 1, version: "v" },
		);
		expect(dto.pool.defaultRoutable).toBe(0);
		expect(dto.routing.defaultCandidateAccountId).toBeNull();
		expect(dto.status).toBe("degraded");
	});
});

describe("golden: GET /public/v1/accounts", () => {
	it("matches the pinned shape exactly", () => {
		expect(toPublicAccountsDto(snapshot())).toEqual({
			schema: "clankermux.public.accounts.v1",
			generatedAt: NOW_ISO,
			accounts: [
				{
					id: "acct-1",
					name: "primary",
					provider: "anthropic",
					isDefaultCandidate: true,
					availability: {
						state: "available",
						reason: null,
						availableAt: null,
					},
					credential: {
						state: "valid",
						expiresAt: "2023-11-16T02:00:00.000Z",
					},
					measurementState: "fresh",
					usageObservedAt: "2023-11-14T21:56:10.000Z",
					utilizationPct: 42,
					windows: [
						{
							kind: "five_hour",
							scopeId: null,
							label: "5-hour",
							utilizationPct: 42,
							observedAt: "2023-11-14T21:56:10.000Z",
							resetsAt: "2023-11-14T22:13:20.000Z",
							prediction: null,
						},
					],
				},
			],
		});
	});

	it("emits every field EXPLICITLY — a new snapshot field must not leak", () => {
		const withExtra = {
			...account(),
			// A field a future change might add to the snapshot type. The DTO is
			// built from a named list, so it must not appear on the wire.
			identityEmail: "operator@example.com",
			refreshToken: "secret",
		} as unknown as PublicAccountSnapshot;
		const dto = toPublicAccountDto(withExtra);
		expect(Object.keys(dto).sort()).toEqual([
			"availability",
			"credential",
			"id",
			"isDefaultCandidate",
			"measurementState",
			"name",
			"provider",
			"usageObservedAt",
			"utilizationPct",
			"windows",
		]);
		const wire = JSON.stringify(dto);
		expect(wire).not.toContain("operator@example.com");
		expect(wire).not.toContain("secret");
	});

	it("no longer carries the fields the reshaped contract replaced", () => {
		// `windows[]` replaces all five of these, plus the whole `pooled` block,
		// which moved to /public/v1/status. Serving both shapes would represent
		// one observation twice in two vocabularies.
		const wire = JSON.stringify(toPublicAccountsDto(snapshot()));
		for (const gone of [
			"pooled",
			"limits",
			"fiveHourPct",
			"fiveHourResetsAt",
			"sevenDayPct",
			"sevenDayResetsAt",
			"willExhaustBeforeReset",
			"stale",
			"health",
			"paused",
			"pauseReason",
			"rateLimitResetAt",
			"providerOverloadedUntil",
			"providerWideOverloadedUntil",
			"isPrimary",
		]) {
			expect(wire).not.toContain(`"${gone}"`);
		}
	});

	it("carries no field whose name begins with identity", () => {
		// A smoke alarm, not the wall: the named-field allowlist above is the
		// actual privacy boundary.
		const wire = JSON.stringify(toPublicAccountsDto(snapshot()));
		expect(/"identity/i.test(wire)).toBe(false);
	});

	it("serialises a window with no prediction as an explicit null", () => {
		// Not an omitted key: a device with a fixed record layout needs the field
		// to exist, and null is the honest "no established trend".
		const dto = toPublicAccountsDto(
			snapshot({
				accounts: [account({ windows: [window({ prediction: null })] })],
			}),
		);
		expect(dto.accounts[0]?.windows[0]).toHaveProperty("prediction", null);
	});

	it("carries the measurement and its prediction in ONE record", () => {
		const dto = toPublicAccountsDto(
			snapshot({
				accounts: [
					account({
						windows: [
							window({
								prediction: {
									state: "rising",
									slopePerHour: 4,
									etaExhaustMs: 1_700_040_000_000,
									predictedAtReset: 88,
									resetsAtMs: 1_700_000_000_000,
									willExhaustBeforeReset: true,
									lowConfidence: false,
								},
							}),
						],
					}),
				],
			}),
		);
		const first = dto.accounts[0]?.windows[0];
		expect(first?.utilizationPct).toBe(42);
		expect(first?.prediction).toEqual({
			predictedUtilizationAtResetPct: 88,
			exhaustsAt: "2023-11-15T09:20:00.000Z",
			willExhaustBeforeReset: true,
			lowConfidence: false,
			state: "rising",
		});
	});

	it("publishes etaExhaustMs as an INSTANT, not a duration", () => {
		// The internal field is `last.t + offset` — an absolute epoch instant
		// wearing a duration's name. Propagating the misnomer is the trap.
		const dto = toPublicAccountsDto(
			snapshot({
				accounts: [
					account({
						windows: [
							window({
								prediction: {
									state: "rising",
									slopePerHour: 4,
									etaExhaustMs: 1_700_040_000_000,
									predictedAtReset: 88,
									resetsAtMs: 1_700_000_000_000,
									willExhaustBeforeReset: true,
									lowConfidence: false,
								},
							}),
						],
					}),
				],
			}),
		);
		const prediction = dto.accounts[0]?.windows[0]?.prediction;
		expect(prediction).not.toBeNull();
		expect(typeof prediction?.exhaustsAt).toBe("string");
		expect(JSON.stringify(dto)).not.toContain("etaExhaust");
	});
});

describe("golden: GET /public/v1/runway", () => {
	it("matches the pinned shape exactly", () => {
		expect(toPublicRunwayDto(runway())).toEqual({
			schema: "clankermux.public.runway.v1",
			generatedAt: NOW_ISO,
			horizonMs: 1_209_600_000,
			coverage: {
				activeKeyCount: 3,
				statedKeyCount: 2,
				unobservedKeyCount: 1,
			},
			worstStatedOutcome: {
				kind: "runway",
				exhaustsAt: "2023-11-15T09:20:00.000Z",
				causes: [{ accountId: "acct-1", windowKind: "five_hour" }],
				earliestExhaustsAt: "2023-11-15T06:33:20.000Z",
				latestExhaustsAt: "2023-11-15T12:06:40.000Z",
			},
		});
	});

	it("carries NO API key data — no ids, names, pins or eligibility maps", () => {
		// `/api/runway` reports a row per key with `keyName` (they look like
		// "impatience (claude)"), `pin` and `eligibleAccountIds`. None of it may
		// reach an unauthenticated surface. Asserted on the SERIALISED wire so a
		// field nested anywhere is covered.
		const wire = JSON.stringify(toPublicRunwayDto(runway()));
		for (const forbidden of [
			"keys",
			"keyId",
			"keyName",
			"pin",
			"isActive",
			"eligibleAccountIds",
			"unprojectableAccountIds",
			"impatience",
		]) {
			expect(wire).not.toContain(forbidden);
		}
	});

	it("does not re-serve per-account usage — that is the accounts resource", () => {
		const wire = JSON.stringify(toPublicRunwayDto(runway()));
		for (const forbidden of [
			"utilizationPct",
			"resetsAt",
			"observedAt",
			"windows",
			"usageAsOf",
		]) {
			expect(wire).not.toContain(forbidden);
		}
		// A cause REFERENCING an account id is a resource reference and stays.
		expect(wire).toContain("accountId");
	});

	it("reports a null instant on every kind that has none", () => {
		for (const kind of [
			"out-now",
			"beyond-horizon",
			"unknown",
			"no-accounts",
		]) {
			const dto = toPublicRunwayDto(
				runway({
					worstStatedOutcome: {
						kind,
						exhaustsAtMs: null,
						causes: [],
						band: null,
					},
				}),
			);
			expect(dto.worstStatedOutcome?.exhaustsAt).toBeNull();
		}
	});

	it("brackets the instant with the band the same key reported", () => {
		const dto = toPublicRunwayDto(runway());
		expect(dto.worstStatedOutcome?.earliestExhaustsAt).toBe(
			"2023-11-15T06:33:20.000Z",
		);
		expect(dto.worstStatedOutcome?.latestExhaustsAt).toBe(
			"2023-11-15T12:06:40.000Z",
		);
		// The point estimate sits inside its own band, which is the only reason
		// publishing both is honest rather than confusing.
		const point = Date.parse(dto.worstStatedOutcome?.exhaustsAt ?? "");
		expect(
			Date.parse(dto.worstStatedOutcome?.earliestExhaustsAt ?? ""),
		).toBeLessThanOrEqual(point);
		expect(
			Date.parse(dto.worstStatedOutcome?.latestExhaustsAt ?? ""),
		).toBeGreaterThanOrEqual(point);
	});

	it("states both band ends as null when no band was stated", () => {
		// Modelled reset credits make the burn non-monotonic, so two probes bound
		// nothing and the scan declines to claim a band. That must read as absent,
		// never as a zero-width band around the point estimate.
		const dto = toPublicRunwayDto(
			runway({
				worstStatedOutcome: {
					kind: "runway",
					exhaustsAtMs: 1_700_040_000_000,
					causes: [],
					band: null,
				},
			}),
		);
		expect(dto.worstStatedOutcome?.exhaustsAt).not.toBeNull();
		expect(dto.worstStatedOutcome?.earliestExhaustsAt).toBeNull();
		expect(dto.worstStatedOutcome?.latestExhaustsAt).toBeNull();
	});

	it("leaves an OPEN band end null rather than collapsing it onto the other", () => {
		// A probe that found no run-out inside the horizon has not found a late
		// bound — folding the other end in would invent one.
		const dto = toPublicRunwayDto(
			runway({
				worstStatedOutcome: {
					kind: "runway",
					exhaustsAtMs: 1_700_040_000_000,
					causes: [],
					band: {
						earliestExhaustsAtMs: 1_700_030_000_000,
						latestExhaustsAtMs: null,
						halfWidthPct: 0.5,
					},
				},
			}),
		);
		expect(dto.worstStatedOutcome?.earliestExhaustsAt).toBe(
			"2023-11-15T06:33:20.000Z",
		);
		expect(dto.worstStatedOutcome?.latestExhaustsAt).toBeNull();
	});

	it("reports a null outcome when nothing anywhere could be stated", () => {
		const dto = toPublicRunwayDto(runway({ worstStatedOutcome: null }));
		expect(dto.worstStatedOutcome).toBeNull();
		// …but the coverage counts still say how much of the pool was blind.
		expect(dto.coverage.unobservedKeyCount).toBe(1);
	});
});

describe("golden: GET /public/v1/stops", () => {
	it("matches the pinned shape exactly", () => {
		expect(toPublicStopsDto(stops(), NOW)).toEqual({
			schema: "clankermux.public.stops.v1",
			generatedAt: NOW_ISO,
			range: "7d",
			windowStartsAt: "2023-11-07T21:56:40.000Z",
			windowEndsAt: NOW_ISO,
			totalRequests: 4_000,
			blockedRequests: 12,
			causes: [
				{
					cause: "pool_quota_exhausted",
					count: 9,
					firstSeenAt: "2023-11-14T18:56:40.000Z",
					lastSeenAt: "2023-11-14T20:56:40.000Z",
				},
				{
					cause: "model_not_served",
					count: 3,
					firstSeenAt: "2023-11-14T19:56:40.000Z",
					lastSeenAt: "2023-11-14T19:56:40.000Z",
				},
			],
			candidates: {
				observedRequests: 3_800,
				zeroCandidateRequests: 12,
				distribution: [
					{ candidatesCount: 0, requests: 12 },
					{ candidatesCount: 2, requests: 3_788 },
				],
			},
		});
	});

	it("drops the series, the raw message and the model it was asked for", () => {
		// Each for its own reason: a per-cause series is a second array level
		// inside a record array, a raw `error_message` is unreviewed third-party
		// text on an unauthenticated wire, and which model a caller asked for is
		// traffic detail rather than a pool fact.
		const wire = JSON.stringify(toPublicStopsDto(stops(), NOW));
		for (const forbidden of [
			"series",
			"sampleErrorMessage",
			"all_accounts_failed",
			"topRequestedModel",
			"gpt-5.2-codex",
		]) {
			expect(wire).not.toContain(forbidden);
		}
	});

	it("states the range it counted rather than leaving it to be assumed", () => {
		const dto = toPublicStopsDto(stops(), NOW);
		expect(dto.range).toBe("7d");
		expect(Date.parse(dto.windowEndsAt) - Date.parse(dto.windowStartsAt)).toBe(
			7 * 24 * 3_600_000,
		);
	});

	it("reports zero blocked with no cause rows rather than omitting the block", () => {
		const dto = toPublicStopsDto(
			stops({
				blockedRequests: 0,
				causes: [],
				candidates: {
					observedRequests: 0,
					zeroCandidateRequests: 0,
					distribution: [],
				},
			}),
			NOW,
		);
		expect(dto.blockedRequests).toBe(0);
		expect(dto.causes).toEqual([]);
		// The denominator survives: 4000 requests and none blocked is a
		// measurement, and it is the one worth seeing.
		expect(dto.totalRequests).toBe(4_000);
		expect(dto.candidates.observedRequests).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Instants and durations
// ---------------------------------------------------------------------------

describe("instants vs durations", () => {
	const populated = snapshot({
		pool: {
			configured: 2,
			defaultRoutable: 1,
			paused: 0,
			rateLimited: 1,
			usageExhausted: 1,
			nextAvailableAtMs: 1_700_000_000_000,
		},
		providers: [
			{
				provider: "anthropic",
				anyOverload: {
					state: "open",
					untilMs: 1_700_000_500_000,
					probeActive: true,
				},
				providerWideOverload: {
					state: "half-open",
					untilMs: null,
					probeActive: false,
				},
				scopedLimits: [
					{
						scopeId: "opus",
						label: "Claude Opus 4.5",
						meanUtilizationPct: 12,
						contributingAccountCount: 1,
						unknownAccountCount: 0,
						earliestResetsAtMs: 1_700_200_000_000,
						leastUsedUtilizationPct: 12,
						leastUsedAccountId: "acct-1",
					},
				],
			},
		],
		accounts: [
			account({
				availableAtMs: 1_700_000_000_000,
				credentialExpiresAtMs: 1_700_300_000_000,
				windows: [
					window({
						prediction: {
							state: "rising",
							slopePerHour: 4,
							etaExhaustMs: 1_700_040_000_000,
							predictedAtReset: 88,
							resetsAtMs: 1_700_000_000_000,
							willExhaustBeforeReset: true,
							lowConfidence: false,
						},
					}),
				],
			}),
		],
	});

	it("emits no instant as a number on any resource", () => {
		assertInstantsAreIso(
			toPublicStatusDto(populated, { uptimeS: 3_600, version: "v" }),
		);
		assertInstantsAreIso(toPublicAccountsDto(populated));
		assertInstantsAreIso(toPublicRunwayDto(runway()));
		assertInstantsAreIso(toPublicStopsDto(stops(), NOW));
	});

	it("emits no duration as a string", () => {
		const status = toPublicStatusDto(populated, {
			uptimeS: 3_600,
			version: "v",
		});
		expect(typeof status.uptimeS).toBe("number");
		expect(typeof toPublicRunwayDto(runway()).horizonMs).toBe("number");
	});

	it("gives no instant field a unit suffix", () => {
		const wire = `${JSON.stringify(
			toPublicStatusDto(populated, { uptimeS: 1, version: "v" }),
		)}${JSON.stringify(toPublicAccountsDto(populated))}${JSON.stringify(
			toPublicRunwayDto(runway()),
		)}`;
		for (const misnamed of [
			"AtMs",
			"resetsAtMs",
			"exhaustsAtMs",
			"untilMs",
			"nowMs",
			"etaExhaustMs",
		]) {
			expect(wire).not.toContain(misnamed);
		}
	});
});

// ---------------------------------------------------------------------------
// Identifiers are never truncated
// ---------------------------------------------------------------------------

describe("identifiers are never truncated", () => {
	const longId = `${"a".repeat(MAX_STRING_BYTES + 40)}-tail`;

	it("passes a long account id through whole", () => {
		// Truncation would leave a syntactically valid key that binds a stream
		// event to the wrong record, and only for the ids long enough to need it.
		const dto = toPublicAccountsDto(
			snapshot({ accounts: [account({ id: longId })] }),
		);
		expect(dto.accounts[0]?.id).toBe(longId);
	});

	it("passes a long routing candidate id through whole", () => {
		const dto = toPublicStatusDto(
			snapshot({
				routing: {
					context: "fresh_unpinned_nominal",
					defaultCandidateAccountId: longId,
				},
			}),
			{ uptimeS: 1, version: "v" },
		);
		expect(dto.routing.defaultCandidateAccountId).toBe(longId);
	});

	it("passes a long request id and accountId through whole on the summary", () => {
		const dto = toPublicRequestDoneDto(
			summary({ id: longId, accountUsed: longId }),
			0,
		);
		expect(dto.id).toBe(longId);
		expect(dto.accountId).toBe(longId);
	});

	it("passes a long least-used account id through whole", () => {
		const dto = toPublicStatusDto(
			snapshot({
				usage: {
					fiveHour: {
						meanUtilizationPct: 42,
						contributingAccountCount: 1,
						unknownAccountCount: 0,
						earliestResetsAtMs: null,
						leastUsedUtilizationPct: 42,
						leastUsedAccountId: longId,
					},
					sevenDay: {
						meanUtilizationPct: null,
						contributingAccountCount: 0,
						unknownAccountCount: 1,
						earliestResetsAtMs: null,
						leastUsedUtilizationPct: null,
						leastUsedAccountId: null,
					},
					worstAccountUtilizationPct: 42,
				},
			}),
			{ uptimeS: 1, version: "v" },
		);
		expect(dto.usage.fiveHour.leastUsedAccountId).toBe(longId);
	});

	it("passes a long runway cause account id through whole", () => {
		const dto = toPublicRunwayDto(
			runway({
				worstStatedOutcome: {
					kind: "out-now",
					exhaustsAtMs: null,
					causes: [{ accountId: longId, windowKind: "seven_day" }],
					band: null,
				},
			}),
		);
		expect(dto.worstStatedOutcome?.causes[0]?.accountId).toBe(longId);
	});

	it("passes a long provider through whole on BOTH resources it joins", () => {
		// `accounts[].provider` and `providers[].provider` are the two ends of one
		// join. Truncating either would make two providers sharing a 96-byte
		// prefix collide, and account-to-provider correlation stops being
		// lossless — silently, and only for the names long enough to be cut.
		const longProvider = `${"p".repeat(MAX_STRING_BYTES + 40)}-tail`;
		const accountsDto = toPublicAccountsDto(
			snapshot({ accounts: [account({ provider: longProvider })] }),
		);
		expect(accountsDto.accounts[0]?.provider).toBe(longProvider);

		const statusDto = toPublicStatusDto(
			snapshot({
				providers: [
					{
						provider: longProvider,
						anyOverload: { state: "closed", untilMs: null, probeActive: false },
						providerWideOverload: {
							state: "closed",
							untilMs: null,
							probeActive: false,
						},
						scopedLimits: [],
					},
				],
			}),
			{ uptimeS: 1, version: "v" },
		);
		expect(statusDto.providers[0]?.provider).toBe(longProvider);
	});

	it("still truncates DISPLAY text beside those ids", () => {
		const dto = toPublicAccountsDto(
			snapshot({
				accounts: [account({ id: longId, name: "n".repeat(200) })],
			}),
		);
		expect(dto.accounts[0]?.id).toBe(longId);
		expect(Buffer.byteLength(dto.accounts[0]?.name ?? "", "utf8")).toBe(
			MAX_STRING_BYTES,
		);
	});
});

// ---------------------------------------------------------------------------
// Structural limits of the consumer
// ---------------------------------------------------------------------------

describe("structural limits", () => {
	it("nests at most ONE array inside each record array", () => {
		// accounts[] + windows[] and providers[] + scopedLimits[] each spend the
		// whole budget. A third level would overrun the device's scanner.
		expect(arrayNesting(toPublicAccountsDto(snapshot()))).toBeLessThanOrEqual(
			2,
		);
		expect(
			arrayNesting(toPublicStatusDto(snapshot(), { uptimeS: 1, version: "v" })),
		).toBeLessThanOrEqual(2);
		expect(arrayNesting(toPublicRunwayDto(runway()))).toBeLessThanOrEqual(2);
		// stops[] spends its budget on causes[] and distribution[] as SIBLINGS,
		// which is one level each — the series that would have nested inside a
		// cause is exactly what this surface drops.
		expect(arrayNesting(toPublicStopsDto(stops(), NOW))).toBeLessThanOrEqual(2);
	});

	it("keeps object depth far below the reader's 16-deep ceiling", () => {
		expect(depthOf(toPublicAccountsDto(snapshot()))).toBeLessThan(8);
		expect(
			depthOf(toPublicStatusDto(snapshot(), { uptimeS: 1, version: "v" })),
		).toBeLessThan(8);
		expect(depthOf(toPublicRunwayDto(runway()))).toBeLessThan(8);
		expect(depthOf(toPublicStopsDto(stops(), NOW))).toBeLessThan(8);
	});
});

// ---------------------------------------------------------------------------
// Closed descriptive enums
// ---------------------------------------------------------------------------

describe("availability is a closed set with an escape hatch", () => {
	const mapping: Array<[string, string]> = [
		["ok", "available"],
		["allowed", "available"],
		["allowed_warning", "available"],
		["queueing_soft", "available"],
		["queueing_hard", "rate_limited"],
		["rate_limited", "rate_limited"],
		["usage_exhausted", "usage_exhausted"],
		["blocked", "blocked"],
		["payment_required", "blocked"],
		["unknown", "other"],
	];

	for (const [cause, state] of mapping) {
		it(`maps ${cause} to ${state}`, () => {
			expect(toPublicAvailabilityState(cause, false)).toBe(
				state as ReturnType<typeof toPublicAvailabilityState>,
			);
		});
	}

	it("maps a cause the vocabulary has never seen to other, not available", () => {
		// A cause added upstream later must degrade to a value the firmware
		// treats as "warn", never to one it treats as healthy.
		expect(toPublicAvailabilityState("some_future_cause", false)).toBe("other");
		expect(toPublicAvailabilityState("", false)).toBe("other");
	});

	it("lets paused outrank every cause", () => {
		for (const [cause] of mapping) {
			expect(toPublicAvailabilityState(cause, true)).toBe("paused");
		}
	});
});

describe("availableAt belongs to a state that is NOT available", () => {
	/** The availability object the DTO builds for one snapshot account. */
	const availabilityOf = (over: Partial<PublicAccountSnapshot>) =>
		toPublicAccountDto(account(over)).availability;

	// Every cause the state mapping calls `available`. The snapshot still carries
	// an instant for these: `resolveRateLimitPresentation` surfaces the stored
	// provider reset beside a soft status, and that reset is a QUOTA fact, not a
	// block.
	for (const cause of ["ok", "allowed", "allowed_warning", "queueing_soft"]) {
		it(`emits no lift instant beside an available account (${cause})`, () => {
			// An available account has no future instant at which it becomes
			// available. The deployed shape published one anyway — a healthy
			// account read as "available at 03:00 tomorrow", a day away from a
			// window that was not binding anything.
			const availability = availabilityOf({
				cause: cause as RateLimitCause,
				availableAtMs: 1_700_000_000_000,
			});
			expect(availability.state).toBe("available");
			expect(availability.availableAt).toBeNull();
		});
	}

	it("emits the instant a rate-limited account's block lifts", () => {
		const availability = availabilityOf({
			cause: "rate_limited",
			availableAtMs: 1_700_000_000_000,
		});
		expect(availability.state).toBe("rate_limited");
		expect(availability.availableAt).toBe("2023-11-14T22:13:20.000Z");
	});

	it("emits the instant a spent window resets", () => {
		const availability = availabilityOf({
			cause: "usage_exhausted",
			availableAtMs: 1_700_000_000_000,
		});
		expect(availability.state).toBe("usage_exhausted");
		expect(availability.availableAt).toBe("2023-11-14T22:13:20.000Z");
	});

	it("emits no instant for a pause, which no clock lifts", () => {
		// The snapshot already refuses to promise one; the state axis agrees
		// rather than reintroducing it.
		const availability = availabilityOf({
			paused: true,
			pauseReason: "manual",
			cause: "rate_limited",
			availableAtMs: null,
		});
		expect(availability.state).toBe("paused");
		expect(availability.availableAt).toBeNull();
	});

	it("keeps the instant beside a state the vocabulary has never seen", () => {
		// `other` is not "fine": we cannot tell that the account is usable, so
		// whatever recovery instant we have is still the honest answer.
		const availability = availabilityOf({
			cause: "unknown",
			availableAtMs: 1_700_000_000_000,
		});
		expect(availability.state).toBe("other");
		expect(availability.availableAt).toBe("2023-11-14T22:13:20.000Z");
	});
});

describe("availability reason refines the state, or is null", () => {
	for (const reason of [
		"manual",
		"failure_threshold",
		"overage",
		"peak_hours",
		"oauth_invalid_grant",
		"rate_limit_window",
		"subscription_expired",
	]) {
		it(`passes the pause reason ${reason} through`, () => {
			expect(toPublicAvailabilityReason("ok", true, reason)).toBe(
				reason as ReturnType<typeof toPublicAvailabilityReason>,
			);
		});
	}

	it("collapses an unrecognized pause reason to other rather than leaking free text", () => {
		expect(toPublicAvailabilityReason("ok", true, "some_new_reason")).toBe(
			"other",
		);
		expect(toPublicAvailabilityReason("ok", true, null)).toBe("other");
	});

	it("distinguishes our own queue from the provider throttling us", () => {
		expect(toPublicAvailabilityReason("queueing_hard", false, null)).toBe(
			"queueing",
		);
		expect(toPublicAvailabilityReason("rate_limited", false, null)).toBeNull();
	});

	it("distinguishes a billing block from a generic one", () => {
		expect(toPublicAvailabilityReason("payment_required", false, null)).toBe(
			"payment_required",
		);
		expect(toPublicAvailabilityReason("blocked", false, null)).toBeNull();
	});

	it("is null when the state already says everything", () => {
		expect(toPublicAvailabilityReason("ok", false, "manual")).toBeNull();
		expect(
			toPublicAvailabilityReason("usage_exhausted", false, null),
		).toBeNull();
	});
});

describe("credential state is a closed set with an escape hatch", () => {
	for (const state of [
		"valid",
		"refreshable",
		"expired",
		"invalid",
		"missing",
		"not_applicable",
	]) {
		it(`passes ${state} through`, () => {
			expect(toPublicCredentialState(state)).toBe(
				state as ReturnType<typeof toPublicCredentialState>,
			);
		});
	}

	it("maps anything else to other", () => {
		expect(toPublicCredentialState("some_future_state")).toBe("other");
		expect(toPublicCredentialState("")).toBe("other");
	});
});

describe("measurement state is a closed set with an escape hatch", () => {
	for (const state of ["fresh", "stale", "missing", "not_applicable"]) {
		it(`passes ${state} through`, () => {
			expect(toPublicMeasurementState(state)).toBe(
				state as ReturnType<typeof toPublicMeasurementState>,
			);
		});
	}

	it("maps anything else to other", () => {
		expect(toPublicMeasurementState("some_future_state")).toBe("other");
		expect(toPublicMeasurementState("")).toBe("other");
	});
});

describe("window kind is a closed set with an escape hatch", () => {
	for (const kind of ["five_hour", "seven_day", "weekly_scoped"]) {
		it(`passes ${kind} through`, () => {
			expect(toPublicWindowKind(kind)).toBe(
				kind as ReturnType<typeof toPublicWindowKind>,
			);
		});
	}

	it("maps a window class the vocabulary has no name for to other", () => {
		// Anthropic's separate Claude-Code weekly allowance lands here today, and
		// carries a scopeId so it is still identifiable.
		expect(toPublicWindowKind("seven_day_oauth_apps")).toBe("other");
		expect(toPublicWindowKind("some_future_window")).toBe("other");
		expect(toPublicWindowKind("")).toBe("other");
	});
});

describe("prediction state is a closed set with an escape hatch", () => {
	for (const state of ["rising", "stable", "exhausted"]) {
		it(`passes ${state} through`, () => {
			expect(toPublicPredictionState(state)).toBe(
				state as ReturnType<typeof toPublicPredictionState>,
			);
		});
	}

	it("maps anything else to other", () => {
		// `insufficient_data` never reaches here — such a prediction is not served
		// at all, because its slope is a placeholder 0 nobody measured.
		expect(toPublicPredictionState("insufficient_data")).toBe("other");
		expect(toPublicPredictionState("some_future_state")).toBe("other");
	});
});

describe("overload state is a closed set with an escape hatch", () => {
	it("maps the three real states, snake-casing half-open", () => {
		expect(toPublicOverloadState("closed")).toBe("closed");
		expect(toPublicOverloadState("open")).toBe("open");
		expect(toPublicOverloadState("half-open")).toBe("half_open");
	});

	it("maps anything else to other", () => {
		expect(toPublicOverloadState("half_open")).toBe("other");
		expect(toPublicOverloadState("some_future_state")).toBe("other");
	});

	it("keeps half-open distinct from closed, which a flat timestamp cannot", () => {
		const dto = toPublicStatusDto(
			snapshot({
				providers: [
					{
						provider: "anthropic",
						anyOverload: {
							state: "half-open",
							untilMs: null,
							probeActive: true,
						},
						providerWideOverload: {
							state: "closed",
							untilMs: null,
							probeActive: false,
						},
						scopedLimits: [],
					},
				],
			}),
			{ uptimeS: 1, version: "v" },
		);
		const provider = dto.providers[0];
		expect(provider?.anyOverload).toEqual({
			state: "half_open",
			until: null,
			probeActive: true,
		});
		// Both have a null deadline; only the STATE tells them apart.
		expect(provider?.providerWideOverload.until).toBeNull();
		expect(provider?.providerWideOverload.state).toBe("closed");
	});
});

describe("request phase is a closed set with an escape hatch", () => {
	it("maps the two real phases", () => {
		expect(toPublicRequestPhase("pending")).toBe("pending");
		expect(toPublicRequestPhase("streaming")).toBe("streaming");
	});

	it("maps a phase the vocabulary has never seen to other", () => {
		// `phase` DESCRIBES a record the client renders either way, so it takes
		// the `other` escape hatch — unlike the event-type discriminator, where an
		// unknown event is simply not emitted. A raw internal phase reaching the
		// firmware is what makes it reject the replay snapshot whole.
		expect(toPublicRequestPhase("queued")).toBe("other");
		expect(toPublicRequestPhase("")).toBe("other");
	});
});

describe("runway kind is a closed set with an escape hatch", () => {
	const mapping: Array<[string, string]> = [
		["runway", "runway"],
		["out-now", "out_now"],
		["beyond-horizon", "beyond_horizon"],
		["unknown", "unknown"],
		["no-accounts", "no_accounts"],
	];

	for (const [internal, wire] of mapping) {
		it(`maps ${internal} to ${wire}`, () => {
			expect(toPublicRunwayKind(internal)).toBe(
				wire as ReturnType<typeof toPublicRunwayKind>,
			);
		});
	}

	it("maps an outcome kind the vocabulary has never seen to other", () => {
		// The dangerous default would be `beyond_horizon`, which reads as "nothing
		// runs out". A future outcome must land on the value the firmware warns on.
		expect(toPublicRunwayKind("some_future_outcome")).toBe("other");
		expect(toPublicRunwayKind("")).toBe("other");
		// The internal spelling is kebab-case; the snake_case wire spelling is NOT
		// an accepted input, so a round-trip mistake shows up rather than passing.
		expect(toPublicRunwayKind("beyond_horizon")).toBe("other");
	});
});

describe("stop cause is a closed set with an escape hatch", () => {
	for (const cause of [
		"pool_quota_exhausted",
		"family_weekly_exhausted",
		"model_not_served",
		"oauth_tokens_expired",
		"pinned_target_unavailable",
		"provider_overloaded",
		"usage_throttled",
		"context_window_exceeded",
		"upstream_error",
		"other",
	]) {
		it(`passes ${cause} through unchanged`, () => {
			expect(toPublicStopCause(cause)).toBe(
				cause as ReturnType<typeof toPublicStopCause>,
			);
		});
	}

	it("maps a cause the vocabulary has never seen to other", () => {
		// A terminal added to the proxy without a classification must arrive as
		// `other`, which the firmware renders with a warning, rather than as a
		// string its closed-set check rejects outright.
		expect(toPublicStopCause("some_future_terminal")).toBe("other");
		expect(toPublicStopCause("")).toBe("other");
	});
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe("UTF-8-safe truncation", () => {
	it("leaves a short ASCII string untouched", () => {
		expect(truncateUtf8("primary")).toBe("primary");
	});

	it("cuts a long ASCII string to exactly the byte ceiling", () => {
		const out = truncateUtf8("a".repeat(200));
		expect(out).toHaveLength(MAX_STRING_BYTES);
		expect(Buffer.byteLength(out, "utf8")).toBe(MAX_STRING_BYTES);
	});

	it("never splits a multi-byte codepoint", () => {
		// 3 bytes each: 32 of them is exactly 96, 33 would be 99.
		const out = truncateUtf8("日".repeat(50));
		expect(Buffer.byteLength(out, "utf8")).toBe(96);
		expect(out).toBe("日".repeat(32));
		expect(
			new TextDecoder("utf-8", { fatal: true }).decode(
				new TextEncoder().encode(out),
			),
		).toBe(out);
	});

	it("stops BEFORE a codepoint that would overflow rather than after", () => {
		// 4-byte emoji: 24 fit in 96 bytes, the 25th does not.
		const out = truncateUtf8("😀".repeat(40));
		expect(Buffer.byteLength(out, "utf8")).toBe(96);
		expect([...out]).toHaveLength(24);
	});

	it("handles a boundary that lands mid-codepoint", () => {
		// 95 ASCII bytes then a 3-byte character: the character cannot fit.
		const out = truncateUtf8(`${"a".repeat(95)}日`);
		expect(out).toBe("a".repeat(95));
		expect(Buffer.byteLength(out, "utf8")).toBe(95);
	});

	it("applies to every free-text field on the wire", () => {
		// DISPLAY text only. `provider` is deliberately absent from this list —
		// see the identifier cases above.
		const dto = toPublicAccountDto(
			account({
				name: "n".repeat(200),
				windows: [window({ label: "L".repeat(200) })],
			}),
		);
		expect(Buffer.byteLength(dto.name, "utf8")).toBe(MAX_STRING_BYTES);
		expect(Buffer.byteLength(dto.windows[0]?.label ?? "", "utf8")).toBe(
			MAX_STRING_BYTES,
		);
	});
});

// ---------------------------------------------------------------------------
// Status level
// ---------------------------------------------------------------------------

describe("status level", () => {
	const pool = (over: Partial<PublicSnapshot["pool"]>) => ({
		configured: 3,
		defaultRoutable: 2,
		paused: 0,
		rateLimited: 0,
		usageExhausted: 0,
		nextAvailableAtMs: null,
		...over,
	});

	it("is unhealthy with no accounts configured", () => {
		expect(
			toPublicStatusLevel(pool({ configured: 0, defaultRoutable: 0 })),
		).toBe("unhealthy");
	});

	it("is ok whenever something is routable", () => {
		expect(toPublicStatusLevel(pool({ defaultRoutable: 1 }))).toBe("ok");
	});

	it("is degraded when nothing is routable but recovery is known", () => {
		expect(
			toPublicStatusLevel(
				pool({ defaultRoutable: 0, nextAvailableAtMs: 1_700_000_000_000 }),
			),
		).toBe("degraded");
	});

	it("is unhealthy when nothing is routable and recovery is unknown", () => {
		expect(toPublicStatusLevel(pool({ defaultRoutable: 0 }))).toBe("unhealthy");
	});
});

// ---------------------------------------------------------------------------
// Summary normalization
// ---------------------------------------------------------------------------

function summary(over: Partial<RequestResponse> = {}): RequestResponse {
	return {
		id: "req-1",
		timestamp: "2023-11-14T21:56:40.000Z",
		method: "POST",
		path: "/v1/messages",
		accountUsed: "acct-1",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTimeMs: 1_234,
		failoverAttempts: 0,
		...over,
	};
}

describe("request.done normalizes the internal summary", () => {
	it("matches the pinned shape exactly", () => {
		expect(toPublicRequestDoneDto(summary(), 1_700_000_000_000)).toEqual({
			type: "request.done",
			id: "req-1",
			at: "2023-11-14T21:56:40.000Z",
			method: "POST",
			path: "/v1/messages",
			accountId: "acct-1",
			statusCode: 200,
			success: true,
			rateLimited: false,
			responseTimeMs: 1_234,
			failoverAttempts: 0,
			model: null,
			project: null,
			totalTokens: null,
			costUsd: null,
			errorMessage: null,
		});
	});

	it("normalizes the timestamp through Date.parse rather than passing it on", () => {
		const dto = toPublicRequestDoneDto(
			summary({ timestamp: "2023-11-14T22:56:40.000+01:00" }),
			0,
		);
		expect(dto.at).toBe("2023-11-14T21:56:40.000Z");
	});

	it("renames accountUsed to accountId so one field name joins everything", () => {
		const dto = toPublicRequestDoneDto(summary(), 0);
		expect(dto.accountId).toBe("acct-1");
		expect("accountUsed" in dto).toBe(false);
	});

	it("is FLAT — the summary is not nested under payload", () => {
		const dto = toPublicRequestDoneDto(summary(), 0);
		expect("payload" in dto).toBe(false);
		// The record itself is one level, its fields are the second, and there is
		// no third: every value is a scalar.
		expect(depthOf(dto)).toBe(2);
	});

	it("falls back to now for an unparseable timestamp rather than emitting null", () => {
		const dto = toPublicRequestDoneDto(
			summary({ timestamp: "not a date" }),
			1_700_000_000_000,
		);
		// A null here would drop the record off the device's time axis entirely.
		expect(dto.at).toBe("2023-11-14T22:13:20.000Z");
	});

	it("falls back to the requested model when no response model exists", () => {
		expect(
			toPublicRequestDoneDto(
				summary({ model: undefined, requestedModel: "claude-opus-5" }),
				0,
			).model,
		).toBe("claude-opus-5");
	});

	it("reports absent optional numbers as null, never 0", () => {
		const dto = toPublicRequestDoneDto(summary(), 0);
		expect(dto.totalTokens).toBeNull();
		expect(dto.costUsd).toBeNull();
	});

	it("keeps responseTimeMs a NUMBER — it is a duration, not an instant", () => {
		expect(typeof toPublicRequestDoneDto(summary(), 0).responseTimeMs).toBe(
			"number",
		);
		assertInstantsAreIso(toPublicRequestDoneDto(summary(), 0));
	});

	it("emits every field explicitly — an added RequestResponse field must not leak", () => {
		const dto = toPublicRequestDoneDto(
			summary({
				apiKeyName: "leaky",
				// biome-ignore lint/suspicious/noExplicitAny: modelling a future field
			} as any),
			0,
		);
		expect(JSON.stringify(dto)).not.toContain("leaky");
	});
});
