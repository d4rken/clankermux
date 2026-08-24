/**
 * The `/public/v1/*` wire contract, pinned.
 *
 * The consumer is an ESP32-C6 running a streaming JSON scanner and a Cinnamon
 * applet, neither of which can be redeployed when this changes. So the things
 * asserted here are not "the mapper works" but the contract itself: the
 * structural limits of the reader (one nested array, bounded depth), the
 * enums being CLOSED with an `other` escape hatch, every timestamp being epoch
 * ms, strings truncated UTF-8-safely, and — the one that matters most on an
 * unauthenticated surface — that no field arrives here that was not named.
 */
import { describe, expect, it } from "bun:test";
import { RUNWAY_HORIZON_MS } from "@clankermux/core";
import type { RequestResponse } from "@clankermux/types";
import type {
	PublicAccountSnapshot,
	PublicSnapshot,
} from "../../../services/public-snapshot";
import {
	MAX_STRING_BYTES,
	toPublicAccountDto,
	toPublicAccountsDto,
	toPublicHealth,
	toPublicPauseReason,
	toPublicRequestDoneDto,
	toPublicRunwayKind,
	toPublicStatusDto,
	toPublicStatusLevel,
	truncateUtf8,
} from "../dto";

function account(
	over: Partial<PublicAccountSnapshot> = {},
): PublicAccountSnapshot {
	return {
		id: "acct-1",
		name: "primary",
		provider: "anthropic",
		paused: false,
		pauseReason: null,
		cause: "ok",
		utilizationPct: 42,
		fiveHourPct: 42,
		fiveHourResetsAt: 1_700_000_000_000,
		sevenDayPct: 11,
		sevenDayResetsAt: 1_700_500_000_000,
		willExhaustBeforeReset: false,
		rateLimitResetAt: null,
		providerOverloadedUntil: null,
		providerWideOverloadedUntil: null,
		runwayKind: "beyond-horizon",
		runwayExhaustsAtMs: null,
		stale: false,
		limits: [
			{
				kind: "session",
				pct: 42,
				resetsAt: 1_700_000_000_000,
				label: "5-hour",
			},
		],
		...over,
	};
}

function snapshot(over: Partial<PublicSnapshot> = {}): PublicSnapshot {
	return {
		now: 1_699_999_000_000,
		pool: {
			configured: 3,
			routable: 2,
			paused: 1,
			rateLimited: 0,
			usageExhausted: 0,
			nextAvailableAt: null,
		},
		usage: { fiveHourPct: 42, sevenDayPct: 11, worstAccountPct: 42 },
		runway: {
			kind: "beyond-horizon",
			exhaustsAtMs: null,
			horizonMs: RUNWAY_HORIZON_MS,
			worstAccountId: "acct-1",
		},
		accounts: [account()],
		stale: false,
		...over,
	};
}

// ---------------------------------------------------------------------------
// Golden payloads
// ---------------------------------------------------------------------------

describe("golden: GET /public/v1/status", () => {
	it("matches the pinned shape exactly", () => {
		expect(
			toPublicStatusDto(snapshot(), { uptimeS: 3_600, version: "2026.8.71" }),
		).toEqual({
			schema: "clankermux.public.v1",
			status: "ok",
			now: 1_699_999_000_000,
			nowIso: "2023-11-14T21:56:40.000Z",
			uptimeS: 3_600,
			version: "2026.8.71",
			pool: {
				configured: 3,
				routable: 2,
				paused: 1,
				rateLimited: 0,
				usageExhausted: 0,
				nextAvailableAt: null,
			},
			usage: { fiveHourPct: 42, sevenDayPct: 11, worstAccountPct: 42 },
			runway: {
				kind: "beyond_horizon",
				exhaustsAt: null,
				horizonMs: RUNWAY_HORIZON_MS,
				worstAccountId: "acct-1",
			},
			stale: false,
		});
	});

	it("carries nowIso as the ONLY non-epoch timestamp", () => {
		const dto = toPublicStatusDto(snapshot(), {
			uptimeS: 1,
			version: "v",
		});
		const stringFields = Object.entries(dto).filter(
			([, v]) => typeof v === "string",
		);
		// schema, status, version and nowIso. Nothing else is a string, so no
		// other field can smuggle a date in.
		expect(stringFields.map(([k]) => k).sort()).toEqual([
			"nowIso",
			"schema",
			"status",
			"version",
		]);
		expect(dto.nowIso).toBe(new Date(dto.now).toISOString());
	});

	it("has no arrays at all", () => {
		const dto = toPublicStatusDto(snapshot(), { uptimeS: 1, version: "v" });
		expect(JSON.stringify(dto)).not.toContain("[");
	});
});

describe("golden: GET /public/v1/accounts", () => {
	it("matches the pinned shape exactly", () => {
		expect(toPublicAccountsDto(snapshot())).toEqual({
			schema: "clankermux.public.v1",
			now: 1_699_999_000_000,
			pooled: { fiveHourPct: 42, sevenDayPct: 11 },
			accounts: [
				{
					id: "acct-1",
					name: "primary",
					provider: "anthropic",
					paused: false,
					pauseReason: null,
					health: "available",
					utilizationPct: 42,
					fiveHourPct: 42,
					fiveHourResetsAt: 1_700_000_000_000,
					sevenDayPct: 11,
					sevenDayResetsAt: 1_700_500_000_000,
					willExhaustBeforeReset: false,
					rateLimitResetAt: null,
					providerOverloadedUntil: null,
					providerWideOverloadedUntil: null,
					runwayKind: "beyond_horizon",
					runwayExhaustsAt: null,
					stale: false,
					limits: [
						{
							kind: "session",
							pct: 42,
							resetsAt: 1_700_000_000_000,
							label: "5-hour",
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
			"fiveHourPct",
			"fiveHourResetsAt",
			"health",
			"id",
			"limits",
			"name",
			"pauseReason",
			"paused",
			"provider",
			"providerOverloadedUntil",
			"providerWideOverloadedUntil",
			"rateLimitResetAt",
			"runwayExhaustsAt",
			"runwayKind",
			"sevenDayPct",
			"sevenDayResetsAt",
			"stale",
			"utilizationPct",
			"willExhaustBeforeReset",
		]);
		const wire = JSON.stringify(dto);
		expect(wire).not.toContain("operator@example.com");
		expect(wire).not.toContain("secret");
	});

	it("carries no field whose name begins with identity", () => {
		const wire = JSON.stringify(toPublicAccountsDto(snapshot()));
		expect(/"identity/i.test(wire)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Structural limits of the consumer
// ---------------------------------------------------------------------------

/** Deepest container nesting in a value, counting the root as 1. */
function depthOf(value: unknown, depth = 1): number {
	if (Array.isArray(value)) {
		return value.reduce<number>(
			(max, item) => Math.max(max, depthOf(item, depth + 1)),
			depth,
		);
	}
	if (value && typeof value === "object") {
		return Object.values(value).reduce<number>(
			(max, item) => Math.max(max, depthOf(item, depth + 1)),
			depth,
		);
	}
	return depth;
}

/** Nesting level of the deepest ARRAY, counting the outermost as 1. */
function arrayNesting(value: unknown, level = 0): number {
	if (Array.isArray(value)) {
		return value.reduce<number>(
			(max, item) => Math.max(max, arrayNesting(item, level + 1)),
			level + 1,
		);
	}
	if (value && typeof value === "object") {
		return Object.values(value).reduce<number>(
			(max, item) => Math.max(max, arrayNesting(item, level)),
			level,
		);
	}
	return level;
}

describe("structural limits", () => {
	it("nests at most ONE array inside the record array", () => {
		// accounts[] + limits[] spends the whole budget. A third level would
		// overrun the device's scanner, so this is a hard ceiling.
		expect(arrayNesting(toPublicAccountsDto(snapshot()))).toBe(2);
	});

	it("keeps object depth far below the reader's 16-deep ceiling", () => {
		expect(depthOf(toPublicAccountsDto(snapshot()))).toBeLessThan(8);
		expect(
			depthOf(toPublicStatusDto(snapshot(), { uptimeS: 1, version: "v" })),
		).toBeLessThan(8);
	});

	it("uses integers for every timestamp on the accounts response", () => {
		const dto = toPublicAccountsDto(
			snapshot({
				accounts: [
					account({
						rateLimitResetAt: 1_700_100_000_000,
						providerOverloadedUntil: 1_700_200_000_000,
						providerWideOverloadedUntil: 1_700_300_000_000,
					}),
				],
			}),
		);
		const first = dto.accounts[0];
		if (!first) throw new Error("expected an account");
		for (const value of [
			dto.now,
			first.fiveHourResetsAt,
			first.sevenDayResetsAt,
			first.rateLimitResetAt,
			first.providerOverloadedUntil,
			first.providerWideOverloadedUntil,
			first.limits[0]?.resetsAt,
		]) {
			expect(typeof value).toBe("number");
			expect(Number.isInteger(value)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Quota runway
// ---------------------------------------------------------------------------

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

	it("degrades an unrecognized kind on both payloads, not just one", () => {
		const snap = snapshot({
			runway: {
				kind: "quantum-superposition" as PublicSnapshot["runway"]["kind"],
				exhaustsAtMs: null,
				horizonMs: RUNWAY_HORIZON_MS,
				worstAccountId: null,
			},
			accounts: [
				account({
					runwayKind:
						"quantum-superposition" as PublicAccountSnapshot["runwayKind"],
				}),
			],
		});
		expect(
			toPublicStatusDto(snap, { uptimeS: 1, version: "v" }).runway.kind,
		).toBe("other");
		expect(toPublicAccountsDto(snap).accounts[0]?.runwayKind).toBe("other");
	});
});

describe("runway on GET /public/v1/status", () => {
	it("carries the projected instant as epoch ms and the horizon it checked", () => {
		const dto = toPublicStatusDto(
			snapshot({
				runway: {
					kind: "runway",
					exhaustsAtMs: 1_700_040_000_000,
					horizonMs: RUNWAY_HORIZON_MS,
					worstAccountId: "acct-1",
				},
			}),
			{ uptimeS: 1, version: "v" },
		);
		expect(dto.runway.kind).toBe("runway");
		expect(Number.isInteger(dto.runway.exhaustsAt)).toBe(true);
		expect(dto.runway.exhaustsAt).toBe(1_700_040_000_000);
		expect(dto.runway.horizonMs).toBe(RUNWAY_HORIZON_MS);
		expect(dto.runway.worstAccountId).toBe("acct-1");
	});

	it("reports a null instant when nothing is projected", () => {
		for (const kind of ["unknown", "beyond-horizon", "out-now"] as const) {
			const dto = toPublicStatusDto(
				snapshot({
					runway: {
						kind,
						exhaustsAtMs: null,
						horizonMs: RUNWAY_HORIZON_MS,
						worstAccountId: null,
					},
				}),
				{ uptimeS: 1, version: "v" },
			);
			expect(dto.runway.exhaustsAt).toBeNull();
			expect(dto.runway.worstAccountId).toBeNull();
		}
	});

	it("adds no array — the status response still has none", () => {
		const dto = toPublicStatusDto(snapshot(), { uptimeS: 1, version: "v" });
		expect(JSON.stringify(dto)).not.toContain("[");
		expect(Object.keys(dto.runway).sort()).toEqual([
			"exhaustsAt",
			"horizonMs",
			"kind",
			"worstAccountId",
		]);
	});

	it("truncates worstAccountId exactly as accounts[].id is truncated", () => {
		// The field only means anything as a join key, so the two must be cut by
		// the same rule or the join breaks for precisely the long ids.
		const longId = "a".repeat(MAX_STRING_BYTES + 20);
		const snap = snapshot({
			runway: {
				kind: "out-now",
				exhaustsAtMs: null,
				horizonMs: RUNWAY_HORIZON_MS,
				worstAccountId: longId,
			},
			accounts: [account({ id: longId })],
		});
		const status = toPublicStatusDto(snap, { uptimeS: 1, version: "v" });
		expect(status.runway.worstAccountId).toBe(
			toPublicAccountsDto(snap).accounts[0]?.id ?? null,
		);
	});
});

describe("runway on GET /public/v1/accounts", () => {
	it("adds SCALARS only — no second nested array", () => {
		const dto = toPublicAccountsDto(
			snapshot({
				accounts: [
					account({
						runwayKind: "runway",
						runwayExhaustsAtMs: 1_700_040_000_000,
					}),
				],
			}),
		);
		// accounts[] + limits[] and nothing deeper, still.
		expect(arrayNesting(dto)).toBe(2);
		const first = dto.accounts[0];
		if (!first) throw new Error("expected an account");
		const arrayFields = Object.entries(first)
			.filter(([, value]) => Array.isArray(value))
			.map(([key]) => key);
		expect(arrayFields).toEqual(["limits"]);
		expect(typeof first.runwayKind).toBe("string");
		expect(Number.isInteger(first.runwayExhaustsAt)).toBe(true);
	});

	it("reports null for an account with no projectable window", () => {
		const dto = toPublicAccountsDto(
			snapshot({
				accounts: [
					account({ runwayKind: "unknown", runwayExhaustsAtMs: null }),
				],
			}),
		);
		expect(dto.accounts[0]?.runwayKind).toBe("unknown");
		expect(dto.accounts[0]?.runwayExhaustsAt).toBeNull();
	});

	it("carries no API key data — no keys, names or pins reach the wire", () => {
		// `/api/runway` reports a row PER API KEY, carrying `keyName`, `pin`,
		// `eligibleAccountIds` and `outcome.unprojectableAccountIds`. None of that
		// may appear on an unauthenticated surface, and three array levels would be
		// unparseable by the device regardless.
		const wire = `${JSON.stringify(toPublicAccountsDto(snapshot()))}${JSON.stringify(
			toPublicStatusDto(snapshot(), { uptimeS: 1, version: "v" }),
		)}`;
		for (const forbidden of [
			"keys",
			"keyId",
			"keyName",
			"pin",
			"eligibleAccountIds",
			"unprojectableAccountIds",
			"causes",
		]) {
			expect(wire).not.toContain(forbidden);
		}
	});
});

// ---------------------------------------------------------------------------
// Closed enums
// ---------------------------------------------------------------------------

describe("health is a closed set with an escape hatch", () => {
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

	for (const [cause, health] of mapping) {
		it(`maps ${cause} to ${health}`, () => {
			expect(toPublicHealth(cause, false)).toBe(
				health as ReturnType<typeof toPublicHealth>,
			);
		});
	}

	it("maps a cause the vocabulary has never seen to other, not available", () => {
		// A cause added upstream later must degrade to a value the firmware
		// treats as "warn", never to one it treats as healthy.
		expect(toPublicHealth("some_future_cause", false)).toBe("other");
		expect(toPublicHealth("", false)).toBe("other");
	});

	it("lets paused outrank every cause", () => {
		for (const [cause] of mapping) {
			expect(toPublicHealth(cause, true)).toBe("paused");
		}
	});
});

describe("pauseReason is a closed set with an escape hatch", () => {
	for (const reason of [
		"manual",
		"failure_threshold",
		"overage",
		"peak_hours",
		"oauth_invalid_grant",
		"rate_limit_window",
		"subscription_expired",
	]) {
		it(`passes ${reason} through`, () => {
			expect(toPublicPauseReason(reason, true)).toBe(
				reason as ReturnType<typeof toPublicPauseReason>,
			);
		});
	}

	it("collapses an unrecognized reason to other rather than leaking free text", () => {
		expect(toPublicPauseReason("some_new_reason", true)).toBe("other");
		expect(toPublicPauseReason("", true)).toBe("other");
		expect(toPublicPauseReason(null, true)).toBe("other");
	});

	it("is null when the account is not paused, whatever the stored column says", () => {
		expect(toPublicPauseReason("manual", false)).toBeNull();
		expect(toPublicPauseReason(null, false)).toBeNull();
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
		const dto = toPublicAccountDto(
			account({
				name: "n".repeat(200),
				provider: "p".repeat(200),
				limits: [
					{
						kind: "weekly_scoped",
						pct: 1,
						resetsAt: 1,
						label: "L".repeat(200),
					},
				],
			}),
		);
		expect(Buffer.byteLength(dto.name, "utf8")).toBe(MAX_STRING_BYTES);
		expect(Buffer.byteLength(dto.provider, "utf8")).toBe(MAX_STRING_BYTES);
		expect(Buffer.byteLength(dto.limits[0]?.label ?? "", "utf8")).toBe(
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
		routable: 2,
		paused: 0,
		rateLimited: 0,
		usageExhausted: 0,
		nextAvailableAt: null,
		...over,
	});

	it("is unhealthy with no accounts configured", () => {
		expect(toPublicStatusLevel(pool({ configured: 0, routable: 0 }))).toBe(
			"unhealthy",
		);
	});

	it("is ok whenever something is routable", () => {
		expect(toPublicStatusLevel(pool({ routable: 1 }))).toBe("ok");
	});

	it("is degraded when nothing is routable but recovery is known", () => {
		expect(
			toPublicStatusLevel(
				pool({ routable: 0, nextAvailableAt: 1_700_000_000_000 }),
			),
		).toBe("degraded");
	});

	it("is unhealthy when nothing is routable and recovery is unknown", () => {
		expect(toPublicStatusLevel(pool({ routable: 0 }))).toBe("unhealthy");
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
			at: 1_699_999_000_000,
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

	it("converts the ISO timestamp to epoch ms", () => {
		const dto = toPublicRequestDoneDto(summary(), 0);
		expect(dto.at).toBe(Date.parse("2023-11-14T21:56:40.000Z"));
		expect(typeof dto.at).toBe("number");
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
		expect(dto.at).toBe(1_700_000_000_000);
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
