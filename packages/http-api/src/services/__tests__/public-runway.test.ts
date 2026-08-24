/**
 * The de-identified projection of the quota-runway scan.
 *
 * What this file exists to pin is not the arithmetic — that is
 * `capacity-runway.test.ts`'s and `runway.test.ts`'s job, and this service
 * deliberately runs the SAME scan rather than a second one. What is pinned here
 * is the boundary: which facts survive onto an unauthenticated wire and which
 * are dropped, and that the coverage counts travel with the figure they qualify.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { RUNWAY_HORIZON_MS } from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import { type AnyUsageData, usageCache } from "@clankermux/providers";
import type { Account, ApiKey } from "@clankermux/types";
import { toPublicRunwayDto } from "../../handlers/public/dto";
import { createPublicRunwayReader } from "../public-runway";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const BASE = 1_700_000_000_000;

const SEEDED_IDS = ["acc-1", "acc-2", "codex-1"];

function makeAccount(partial: Partial<Account>): Account {
	return {
		id: "acc-1",
		name: "Account 1",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: BASE,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		consecutive_rate_limits: 0,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		codex_auto_apply_reset_credits_enabled: false,
		codex_auto_apply_reset_on_weekly_limit_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		notes: null,
		refresh_token_issued_at: null,
		refresh_token_expires_at: null,
		renewal_anchor: null,
		renewal_cadence: null,
		renewal_price_usd_micros: null,
		renewal_auto_start_date: null,
		...partial,
	} as Account;
}

function makeKey(partial: Partial<ApiKey>): ApiKey {
	return {
		id: "k1",
		// The names really do look like this, which is exactly why none of them
		// may reach an unauthenticated wire.
		name: "impatience (claude)",
		hashedKey: "sha256$deadbeef",
		prefixLast8: "abcdefgh",
		createdAt: BASE,
		lastUsed: null,
		usageCount: 0,
		isActive: true,
		pinnedAccountId: null,
		pinnedProviders: null,
		...partial,
	};
}

function makeDbOps(options: {
	accounts?: Account[];
	keys?: ApiKey[];
	/**
	 * Rows the stored-payload recovery scan finds, i.e. the LEGACY Codex channel
	 * a restart-emptied cache falls back to. Keyed off the `request_payloads`
	 * query so the persisted-column query beside it still reads empty.
	 */
	payloadRows?: Array<{ json: string; timestamp: number }>;
}): DatabaseOperations {
	return {
		getAllAccounts: async () => options.accounts ?? [],
		getApiKeys: async () => options.keys ?? [],
		getAdapter: () => ({
			query: async (sql: string) =>
				sql.includes("request_payloads") ? (options.payloadRows ?? []) : [],
			get: async () => null,
		}),
		getRecentUsageSnapshotsForAccounts: async () => [],
	} as unknown as DatabaseOperations;
}

/**
 * A retained request payload carrying Codex usage headers, exactly as the
 * stored-payload recovery reads them.
 */
function codexPayloadRow(
	weeklyPct: number,
	resetMs: number,
	timestampMs: number,
): { json: string; timestamp: number } {
	return {
		json: JSON.stringify({
			response: {
				status: 200,
				headers: {
					"x-codex-secondary-window-minutes": String(7 * 24 * 60),
					"x-codex-secondary-used-percent": String(weeklyPct),
					"x-codex-secondary-reset-at": String(Math.floor(resetMs / 1000)),
				},
			},
			meta: { timestamp: timestampMs },
		}),
		timestamp: timestampMs,
	};
}

/** Anthropic-shaped payload with both account-wide windows. */
function usage(
	fivePct: number,
	fiveResetMs: number,
	sevenPct: number,
	sevenResetMs: number,
): AnyUsageData {
	return {
		five_hour: {
			utilization: fivePct,
			resets_at: new Date(fiveResetMs).toISOString(),
		},
		seven_day: {
			utilization: sevenPct,
			resets_at: new Date(sevenResetMs).toISOString(),
		},
	} as unknown as AnyUsageData;
}

const HEALTHY = () => usage(10, BASE + 4 * HOUR_MS, 5, BASE + 6 * DAY_MS);
const SPENT = () => usage(100, BASE + 2 * HOUR_MS, 20, BASE + 6 * DAY_MS);

function read(dbOps: DatabaseOperations) {
	return createPublicRunwayReader(dbOps)();
}

describe("GET /public/v1/runway", () => {
	let nowSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		nowSpy = spyOn(Date, "now").mockReturnValue(BASE);
		for (const id of SEEDED_IDS) usageCache.delete(id);
	});

	afterEach(() => {
		for (const id of SEEDED_IDS) usageCache.delete(id);
		nowSpy.mockRestore();
	});

	it("carries the horizon the scan modelled, as a DURATION", () => {
		return read(makeDbOps({})).then((snapshot) => {
			expect(snapshot.horizonMs).toBe(RUNWAY_HORIZON_MS);
			expect(typeof snapshot.horizonMs).toBe("number");
		});
	});

	it("reports the pool's worst stateable outcome, with its causes", async () => {
		usageCache.set("acc-1", SPENT());
		const snapshot = await read(
			makeDbOps({
				accounts: [makeAccount({ id: "acc-1" })],
				keys: [makeKey({})],
			}),
		);
		expect(snapshot.worstStatedOutcome?.kind).toBe("out-now");
		expect(snapshot.worstStatedOutcome?.causes).toEqual([
			{ accountId: "acc-1", windowKind: "five_hour" },
		]);
	});

	it("carries aggregate key COUNTS and no key identity whatsoever", async () => {
		usageCache.set("acc-1", HEALTHY());
		const snapshot = await read(
			makeDbOps({
				accounts: [makeAccount({ id: "acc-1" })],
				keys: [
					makeKey({ id: "k1", name: "impatience (claude)" }),
					makeKey({
						id: "k2",
						name: "desk panel",
						pinnedProviders: ["anthropic"],
					}),
				],
			}),
		);
		expect(snapshot.coverage.activeKeyCount).toBe(2);

		// Asserted on the SERIALISED wire, because a nested field is exactly what
		// a keys-shaped structure would hide behind.
		const wire = JSON.stringify(toPublicRunwayDto(snapshot));
		for (const forbidden of [
			"impatience",
			"desk panel",
			"k1",
			"k2",
			"keys",
			"keyId",
			"keyName",
			"pin",
			"isActive",
			"eligibleAccountIds",
			"unprojectableAccountIds",
			"sha256",
			"abcdefgh",
		]) {
			expect(wire).not.toContain(forbidden);
		}
	});

	it("does not re-serve per-account usage — the accounts resource owns that", async () => {
		usageCache.set("acc-1", SPENT());
		const wire = JSON.stringify(
			toPublicRunwayDto(
				await read(
					makeDbOps({
						accounts: [makeAccount({ id: "acc-1", name: "Claude Max" })],
						keys: [makeKey({})],
					}),
				),
			),
		);
		for (const forbidden of [
			"utilizationPct",
			"resetsAt",
			"observedAt",
			"windows",
			"usageAsOf",
			"metered",
			"Claude Max",
		]) {
			expect(wire).not.toContain(forbidden);
		}
		// A cause referencing an account ID is a resource reference and stays.
		expect(wire).toContain('"accountId":"acc-1"');
	});

	it("separates the keys it could state from the ones it could not", async () => {
		// `acc-1` has a reading; `codex-1` does not, so a key pinned to Codex is
		// unstateable and must not drag the headline to `unknown`.
		usageCache.set("acc-1", HEALTHY());
		const snapshot = await read(
			makeDbOps({
				accounts: [
					makeAccount({ id: "acc-1" }),
					makeAccount({ id: "codex-1", provider: "codex" }),
				],
				keys: [
					makeKey({ id: "k1", pinnedProviders: ["anthropic"] }),
					makeKey({ id: "k2", pinnedProviders: ["codex"] }),
				],
			}),
		);
		expect(snapshot.coverage.activeKeyCount).toBe(2);
		expect(snapshot.coverage.statedKeyCount).toBe(1);
		expect(snapshot.coverage.unobservedKeyCount).toBe(1);
		// The stated key's own outcome is served, NOT poisoned by the blind one…
		expect(snapshot.worstStatedOutcome?.kind).toBe("beyond-horizon");
		// …which is why the counts have to travel with it: the hidden key could
		// have been worse, so the figure is an upper bound.
		expect(
			snapshot.coverage.statedKeyCount + snapshot.coverage.unobservedKeyCount,
		).toBe(snapshot.coverage.activeKeyCount);
	});

	it("states nothing at all when every key is blind", async () => {
		const snapshot = await read(
			makeDbOps({
				accounts: [makeAccount({ id: "acc-1" })],
				keys: [makeKey({})],
			}),
		);
		expect(snapshot.worstStatedOutcome).toBeNull();
		expect(snapshot.coverage.statedKeyCount).toBe(0);
		expect(snapshot.coverage.unobservedKeyCount).toBe(1);
	});

	it("counts the unauthenticated pool ONCE when no key is configured", async () => {
		// With no active key, authentication is off and every request routes over
		// the unpinned pool — one synthetic row, not a phantom key and not zero.
		usageCache.set("acc-1", HEALTHY());
		const snapshot = await read(
			makeDbOps({ accounts: [makeAccount({ id: "acc-1" })], keys: [] }),
		);
		expect(snapshot.coverage.activeKeyCount).toBe(1);
		expect(snapshot.worstStatedOutcome?.kind).toBe("beyond-horizon");
		expect(JSON.stringify(toPublicRunwayDto(snapshot))).not.toContain(
			"unauthenticated",
		);
	});

	it("performs NO cache write — a public GET may not move routing state", async () => {
		// The Codex resolution's payload tier normally re-seeds the usage cache so
		// the proxy can see what it reconstructed. That write mutates the state
		// routing, throttling and capacity decisions read, for ten minutes, and
		// this endpoint is unauthenticated: anything on the LAN could drive it.
		const setUntimed = spyOn(usageCache, "setUntimed");
		try {
			const dbOps = makeDbOps({
				accounts: [
					makeAccount({ id: "codex-1", provider: "codex", last_used: BASE }),
				],
				keys: [makeKey({ pinnedProviders: ["codex"] })],
				payloadRows: [codexPayloadRow(80, BASE + 3 * DAY_MS, BASE - MINUTE_MS)],
			});
			// Empty cache, as after a restart.
			expect(usageCache.peekWithAge("codex-1")).toBeNull();

			const snapshot = await read(dbOps);

			// The RESULT is unchanged: the recovered reading still reached the scan,
			// so the key is stated rather than blind.
			expect(snapshot.coverage.statedKeyCount).toBe(1);
			expect(snapshot.worstStatedOutcome).not.toBeNull();
			// Only the write disappeared.
			expect(setUntimed).not.toHaveBeenCalled();
			expect(usageCache.peekWithAge("codex-1")).toBeNull();
		} finally {
			setUntimed.mockRestore();
		}
	});

	it("reports an elapsed projection as out-now, matching the ranking that chose it", async () => {
		// A `runway` whose instant has passed is not a runway of zero and is not
		// still counting down. Serving the raw outcome would let the published
		// kind contradict the ranking that selected the row.
		//
		// The WEEKLY window is the one that can do this: its full-confidence
		// estimate is anchored to the OBSERVATION rather than to `now`, so it
		// holds still while the clock moves past it. 99.95% of a window that
		// opened six days ago projects ~4 minutes out; the clock then advances
		// six, staying inside the routing freshness bar so the reading is still
		// projectable.
		usageCache.set("acc-1", usage(0, BASE + 4 * HOUR_MS, 99.95, BASE + DAY_MS));
		nowSpy.mockReturnValue(BASE + 6 * MINUTE_MS);
		const snapshot = await read(
			makeDbOps({
				accounts: [makeAccount({ id: "acc-1" })],
				keys: [makeKey({})],
			}),
		);
		expect(snapshot.worstStatedOutcome?.kind).toBe("out-now");
		expect(snapshot.worstStatedOutcome?.exhaustsAtMs).toBeNull();
		expect(snapshot.worstStatedOutcome?.causes).toEqual([
			{ accountId: "acc-1", windowKind: "seven_day" },
		]);
	});
});
