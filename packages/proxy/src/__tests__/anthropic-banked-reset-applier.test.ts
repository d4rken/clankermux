/**
 * The Anthropic banked-reset auto-applier: the pure decision, the scheduler
 * tick over injected doubles, and the production pool gate over a stubbed
 * usage cache.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ModelFamily } from "@clankermux/core";
import type {
	AccountPauseMarker,
	AnthropicBankedResetAutoClaim,
	AnthropicBankedResetEventRow,
} from "@clankermux/database";
import type { UsageData } from "@clankermux/providers";
import { makeAccount } from "@clankermux/test-support";
import type {
	Account,
	AnthropicBankedResetClaimRequest,
	AnthropicBankedResetGrant,
	AnthropicBankedResetStatus,
	AnthropicBankedResetWindow,
	ApiKey,
} from "@clankermux/types";
import {
	AnthropicBankedResetApplyScheduler,
	BANKED_RESET_AUTO_APPLY_LEAD_MS,
	BANKED_RESET_CONFIRM_READ_INTERVAL_MS,
	BANKED_RESET_WEEKLY_LIMIT_COOLDOWN_MS,
	BANKED_RESET_WEEKLY_LIMIT_MIN_GAIN_MS,
	type BankedResetApplyDeps,
	createAnthropicBankedResetApplyScheduler,
	decideBankedResetAction,
} from "../anthropic-banked-reset-applier";
import {
	recordFamilyWeeklyExhausted,
	resetFamilyWeeklyMemoForTests,
} from "../family-weekly-memo";
import type { AnthropicBankedResetClaimDispatchOutcome } from "../handlers/token-manager";

const NOW = Date.parse("2026-09-22T12:00:00Z");
const DAY = 86_400_000;

afterEach(() => resetFamilyWeeklyMemoForTests());

function account(overrides: Partial<Account> = {}): Account {
	return makeAccount({
		id: "acct-1",
		name: "claude-one",
		provider: "anthropic",
		refresh_token: "rt",
		access_token: "at",
		anthropic_auto_apply_banked_resets_enabled: true,
		anthropic_auto_apply_banked_reset_on_weekly_limit_enabled: true,
		...overrides,
	});
}

function grant(
	overrides: Partial<AnthropicBankedResetGrant> = {},
): AnthropicBankedResetGrant {
	return {
		id: "g1",
		label: null,
		resetsTotal: 2,
		resetsLeft: 2,
		startsAt: null,
		endsAt: NOW + 3 * DAY,
		clears: ["seven_day"],
		paused: false,
		usableNow: true,
		useRequiresLimit: true,
		percentUsed: {},
		blocking: [],
		...overrides,
	};
}

function status(
	overrides: Partial<AnthropicBankedResetStatus> = {},
): AnthropicBankedResetStatus {
	return {
		eligible: true,
		ineligibleReason: null,
		atLimit: true,
		exhausted: ["seven_day"],
		grants: [grant()],
		nextGrantId: "g1",
		weeklyResetsAt: null,
		cooldownUntil: null,
		...overrides,
	};
}

function decide(
	inputs: {
		account?: Partial<Account>;
		status?: AnthropicBankedResetStatus | null;
		anchor?: number | null;
		rearmAt?: number | null;
		windowResetsAt?: Parameters<
			typeof decideBankedResetAction
		>[0]["windowResetsAt"];
	} = {},
) {
	return decideBankedResetAction({
		account: account(inputs.account),
		status: inputs.status === undefined ? status() : inputs.status,
		autoApplyCooldownAnchorAt: inputs.anchor ?? null,
		rearmAt: inputs.rearmAt ?? null,
		windowResetsAt: inputs.windowResetsAt ?? { seven_day: NOW + 2 * DAY },
		now: NOW,
	});
}

const weeklyOnly = {
	anthropic_auto_apply_banked_resets_enabled: false,
	anthropic_auto_apply_banked_reset_on_weekly_limit_enabled: true,
};
const expiryOnly = {
	anthropic_auto_apply_banked_resets_enabled: true,
	anthropic_auto_apply_banked_reset_on_weekly_limit_enabled: false,
};

describe("decideBankedResetAction", () => {
	it.each([
		["account disabled", { account: { disabled: true } }, "account-disabled"],
		[
			"both toggles off",
			{
				account: {
					anthropic_auto_apply_banked_resets_enabled: false,
					anthropic_auto_apply_banked_reset_on_weekly_limit_enabled: false,
				},
			},
			"toggle-disabled",
		],
		["not OAuth", { account: { refresh_token: "" } }, "not-anthropic-oauth"],
		[
			"needs re-auth",
			{ account: { paused: true, pause_reason: "oauth_invalid_grant" } },
			"needs-reauth",
		],
		["no status", { status: null }, "no-status"],
		["ineligible", { status: status({ eligible: false }) }, "ineligible"],
		[
			"no next grant",
			{ status: status({ nextGrantId: null }) },
			"no-next-grant",
		],
		[
			"grant not usable",
			{ status: status({ grants: [grant({ usableNow: false })] }) },
			"grant-not-usable",
		],
		[
			"grant paused",
			{ status: status({ grants: [grant({ paused: true })] }) },
			"grant-paused",
		],
		[
			"grant expired",
			{ status: status({ grants: [grant({ endsAt: NOW })] }) },
			"grant-expired",
		],
		[
			"server cooldown",
			{ status: status({ cooldownUntil: NOW + 60_000 }) },
			"server-cooldown",
		],
	] as const)("skips: %s", (_label, inputs, reason) => {
		const decision = decide(inputs as Parameters<typeof decide>[0]);
		expect(decision).toEqual({ action: "skip", reason });
	});

	it("never auto-claims a 5h-only grant, even at its expiry and limit", () => {
		const decision = decide({
			status: status({
				exhausted: ["five_hour"],
				grants: [grant({ clears: ["five_hour"], endsAt: NOW + 60_000 })],
			}),
		});
		expect(decision).toEqual({ action: "skip", reason: "no-weekly-window" });
	});

	it("claims only the server's next grant", () => {
		const decision = decide({
			status: status({
				grants: [grant({ id: "g1" }), grant({ id: "g2" })],
				nextGrantId: "g2",
			}),
			account: weeklyOnly,
		});
		expect(decision.action === "claim" && decision.grantId).toBe("g2");
	});

	describe("expiry", () => {
		const near = NOW + BANKED_RESET_AUTO_APPLY_LEAD_MS;

		it("claims a grant needing no limit inside the lead", () => {
			const decision = decide({
				account: expiryOnly,
				status: status({
					exhausted: [],
					grants: [grant({ endsAt: near, useRequiresLimit: false })],
				}),
			});
			expect(decision).toEqual({
				action: "claim",
				grantId: "g1",
				grantEndsAt: near,
				cause: "expiry",
			});
		});

		it("skips a limit-requiring grant while no window it clears is at its limit", () => {
			const decision = decide({
				account: expiryOnly,
				status: status({ exhausted: [], grants: [grant({ endsAt: near })] }),
			});
			expect(decision).toEqual({ action: "skip", reason: "not-at-limit" });
		});

		it("skips outside the lead", () => {
			const decision = decide({
				account: expiryOnly,
				status: status({
					grants: [grant({ endsAt: near + 1, useRequiresLimit: false })],
				}),
			});
			expect(decision).toEqual({ action: "skip", reason: "not-near-expiry" });
		});

		it("holds the re-arm deadline too", () => {
			const decision = decide({
				account: expiryOnly,
				rearmAt: NOW + 60_000,
				status: status({ grants: [grant({ endsAt: near })] }),
			});
			expect(decision).toEqual({ action: "skip", reason: "rearm" });
		});

		it("ignores the weekly cooldown after a reset: the next grant is another one", () => {
			const decision = decide({
				account: expiryOnly,
				anchor: NOW - 1,
				status: status({ grants: [grant({ endsAt: near })] }),
			});
			expect(decision.action).toBe("claim");
		});

		it("protects a manually paused account", () => {
			const decision = decide({
				account: { ...expiryOnly, paused: true, pause_reason: "manual" },
				status: status({ grants: [grant({ endsAt: near })] }),
			});
			expect(decision.action).toBe("claim");
		});
	});

	describe("weekly limit", () => {
		it("claims when a weekly window the grant clears is exhausted", () => {
			const decision = decide({ account: weeklyOnly });
			expect(decision).toMatchObject({
				action: "claim",
				cause: "weekly-limit",
				windows: ["seven_day"],
				lastChance: false,
			});
		});

		it("ignores an exhausted window the grant does not clear", () => {
			const decision = decide({
				account: weeklyOnly,
				status: status({ exhausted: ["seven_day_opus"] }),
			});
			expect(decision).toEqual({
				action: "skip",
				reason: "weekly-not-exhausted",
			});
		});

		it("skips a pause the reset cannot lift, claims through an overage pause", () => {
			expect(
				decide({
					account: { ...weeklyOnly, paused: true, pause_reason: "manual" },
				}),
			).toEqual({ action: "skip", reason: "paused" });
			expect(
				decide({
					account: {
						...weeklyOnly,
						paused: true,
						pause_reason: "overage",
						auto_pause_on_overage_enabled: true,
					},
				}).action,
			).toBe("claim");
		});

		it("holds the one-hour cooldown after an anchoring auto claim", () => {
			expect(
				decide({
					account: weeklyOnly,
					anchor: NOW - BANKED_RESET_WEEKLY_LIMIT_COOLDOWN_MS + 1,
				}),
			).toEqual({ action: "skip", reason: "cooldown" });
			expect(
				decide({
					account: weeklyOnly,
					anchor: NOW - BANKED_RESET_WEEKLY_LIMIT_COOLDOWN_MS,
				}).action,
			).toBe("claim");
		});

		it("holds a re-arm deadline after not_limited, cooldown or ineligible", () => {
			expect(decide({ account: weeklyOnly, rearmAt: NOW + 1 })).toEqual({
				action: "skip",
				reason: "rearm",
			});
			expect(decide({ account: weeklyOnly, rearmAt: NOW }).action).toBe(
				"claim",
			);
		});

		it("marks the last chance when the grant expires before the window resets", () => {
			const lastChance = (
				windowResetsAt: Record<string, number>,
				weeklyResetsAt: number | null = null,
			) => {
				const decision = decide({
					account: weeklyOnly,
					status: status({ weeklyResetsAt }),
					windowResetsAt,
				});
				return decision.action === "claim" && decision.cause === "weekly-limit"
					? decision.lastChance
					: undefined;
			};
			expect(lastChance({ seven_day: NOW + 4 * DAY })).toBe(true);
			expect(lastChance({ seven_day: NOW + 2 * DAY })).toBe(false);
			expect(lastChance({}, NOW + 4 * DAY)).toBe(true);
			expect(lastChance({})).toBeUndefined();
		});

		describe("minimum gain", () => {
			const HOUR = 60 * 60_000;

			it("keeps the grant when the exhausted window resets on its own within 12h", () => {
				expect(
					decide({
						account: weeklyOnly,
						windowResetsAt: { seven_day: NOW + 2 * HOUR },
					}),
				).toEqual({ action: "skip", reason: "reset-soon" });
				expect(
					decide({
						account: weeklyOnly,
						windowResetsAt: {
							seven_day: NOW + BANKED_RESET_WEEKLY_LIMIT_MIN_GAIN_MS - 1,
						},
					}),
				).toEqual({ action: "skip", reason: "reset-soon" });
			});

			it("claims when the natural reset is 13h away", () => {
				expect(
					decide({
						account: weeklyOnly,
						windowResetsAt: { seven_day: NOW + 13 * HOUR },
					}),
				).toMatchObject({
					action: "claim",
					cause: "weekly-limit",
					resetsAt: NOW + 13 * HOUR,
					lastChance: false,
				});
			});

			it("fails closed when no natural reset is known", () => {
				expect(decide({ account: weeklyOnly, windowResetsAt: {} })).toEqual({
					action: "skip",
					reason: "weekly-reset-unknown",
				});
				expect(
					decide({
						account: weeklyOnly,
						windowResetsAt: {},
						status: status({
							exhausted: ["seven_day_opus"],
							grants: [grant({ clears: ["seven_day_opus"] })],
						}),
					}),
				).toEqual({ action: "skip", reason: "weekly-reset-unknown" });
			});

			it("takes the status's weekly reset for seven_day when usage omits it", () => {
				expect(
					decide({
						account: weeklyOnly,
						windowResetsAt: {},
						status: status({ weeklyResetsAt: NOW + 2 * HOUR }),
					}),
				).toEqual({ action: "skip", reason: "reset-soon" });
			});

			it("claims when any cleared window's reset is far enough, ranking by the latest", () => {
				const decision = decide({
					account: weeklyOnly,
					windowResetsAt: {
						seven_day: NOW + 2 * HOUR,
						seven_day_opus: NOW + 20 * HOUR,
					},
					status: status({
						exhausted: ["seven_day", "seven_day_opus"],
						grants: [grant({ clears: ["seven_day", "seven_day_opus"] })],
					}),
				});
				expect(decision).toMatchObject({
					action: "claim",
					windows: ["seven_day", "seven_day_opus"],
					resetsAt: NOW + 20 * HOUR,
				});
			});

			it("claims on the last chance even when the window resets within 12h", () => {
				expect(
					decide({
						account: weeklyOnly,
						windowResetsAt: { seven_day: NOW + 2 * HOUR },
						status: status({ grants: [grant({ endsAt: NOW + HOUR })] }),
					}),
				).toMatchObject({
					action: "claim",
					cause: "weekly-limit",
					lastChance: true,
					resetsAt: NOW + 2 * HOUR,
				});
			});
		});
	});
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

interface Harness {
	deps: BankedResetApplyDeps;
	dispatched: AnthropicBankedResetClaimRequest[];
	claims: Array<{ grantId: string; cause: string }>;
	forcedReads: number;
	/** Accounts given a non-forced, TTL-gated status read. */
	cachedReads: string[];
	/** The windows each pool check was asked about. */
	poolChecks: AnthropicBankedResetWindow[][];
	expiredAt: number[];
	resumed: string[];
	cleared: string[];
	usageRefreshes: string[];
}

function completedOutcome(): AnthropicBankedResetClaimDispatchOutcome {
	return {
		status: "completed",
		accountName: "claude-one",
		eventId: "row",
		ledgerStatus: "reset",
		result: null,
		reason: null,
		resetsLeft: 1,
		cleared: [],
		nextAttemptAt: null,
		replayUntil: null,
		windowsRestored: true,
		statusRefreshed: true,
	};
}

function pendingRow(
	overrides: Partial<AnthropicBankedResetEventRow> = {},
): AnthropicBankedResetEventRow {
	return {
		id: "acct-1:g1:1",
		account_id: "acct-1",
		account_name: "claude-one",
		grant_id: "g1",
		trigger: "auto",
		cause: "weekly-limit",
		attempt_seq: 1,
		request_id: "stored-request",
		status: "pending",
		reason: null,
		cleared: null,
		resets_left: null,
		error_message: null,
		grant_ends_at: null,
		next_attempt_at: null,
		rearm_at: null,
		recovery_pending_until: null,
		recovery_pause_epoch: null,
		recovery_pause_changed_at: null,
		created_at: NOW - 60_000,
		resolved_at: null,
		...overrides,
	};
}

function harness(
	options: {
		accounts?: Array<Partial<Account>>;
		status?: AnthropicBankedResetStatus | null;
		usage?: UsageData | null;
		pending?: AnthropicBankedResetEventRow[];
		otherAvailable?: boolean;
		memo?: Partial<Record<ModelFamily, number>>;
		rearmAt?: number | null;
		cooldownAnchorAt?: number | null;
		/** Whether the status cache's own TTL rules call for a read. */
		statusNeedsRefresh?: boolean;
		/** Rows owing an overage-pause verdict. */
		recovery?: AnthropicBankedResetEventRow[];
		/** The cached reading the recovery pass sees, before and after a refresh. */
		observation?: { data: UsageData; observedAtMs: number | null } | null;
		observationAfterRefresh?: {
			data: UsageData;
			observedAtMs: number | null;
		} | null;
		candidates?: Array<{ id: string; name: string }>;
		/** The account's pause as the recovery pass reads it, now. */
		pauseMarker?: () => AccountPauseMarker | null;
	} = {},
): Harness {
	let observation = options.observation ?? null;
	const reads = [...(options.accounts ?? [])];
	const h: Harness = {
		dispatched: [],
		claims: [],
		forcedReads: 0,
		cachedReads: [],
		poolChecks: [],
		expiredAt: [],
		resumed: [],
		cleared: [],
		usageRefreshes: [],
		deps: {
			listCandidateAccounts: async () =>
				options.candidates ?? [{ id: "acct-1", name: "claude-one" }],
			getRecoveryPending: async () =>
				(options.recovery ?? []).filter((row) => !h.cleared.includes(row.id)),
			clearRecoveryPending: async (rowId) => {
				h.cleared.push(rowId);
				return true;
			},
			getPauseMarker: async () =>
				options.pauseMarker ? options.pauseMarker() : null,
			resumeIfOveragePausedAt: async (accountId, pauseEpoch) => {
				// The compare-and-set the ledger does in SQL.
				const marker = options.pauseMarker?.() ?? null;
				if (!marker || marker.pauseEpoch !== pauseEpoch) return false;
				h.resumed.push(`${accountId}@${pauseEpoch}`);
				return true;
			},
			peekUsageObservation: () => observation,
			refreshUsage: async (accountId) => {
				h.usageRefreshes.push(accountId);
				if (options.observationAfterRefresh !== undefined) {
					observation = options.observationAfterRefresh;
				}
				return true;
			},
			expireStaleAttempts: async (now) => {
				h.expiredAt.push(now);
				return 0;
			},
			getAccount: async () =>
				account(reads.length > 1 ? reads.shift() : reads[0]),
			getCachedStatus: () =>
				options.status === undefined ? status() : options.status,
			refreshStatus: async (id, force) => {
				if (force) h.forcedReads++;
				else h.cachedReads.push(id);
				return true;
			},
			getPendingAttempts: async () => options.pending ?? [],
			getAutoApplyCooldownAnchorAt: async () =>
				options.cooldownAnchorAt ?? null,
			getRearmAt: async () => options.rearmAt ?? null,
			statusNeedsRefresh: () => options.statusNeedsRefresh ?? true,
			getUsage: () =>
				options.usage === undefined
					? ({
							five_hour: { utilization: 10, resets_at: null },
							seven_day: {
								utilization: 100,
								resets_at: new Date(NOW + DAY).toISOString(),
							},
						} as UsageData)
					: options.usage,
			getFamilyWeeklyMemo: () => options.memo ?? {},
			hasOtherAvailableAccount: async (_id, windows) => {
				h.poolChecks.push(windows);
				return options.otherAvailable ?? false;
			},
			claimAutoAttempt: async (input) => {
				h.claims.push({ grantId: input.grantId, cause: input.cause });
				return {
					id: `acct-1:${input.grantId}:1`,
					requestId: "fresh-request",
					attemptSeq: 1,
					reused: false,
				} satisfies AnthropicBankedResetAutoClaim;
			},
			dispatchClaim: async (_id, request) => {
				h.dispatched.push(request);
				return completedOutcome();
			},
			now: () => NOW,
		},
	};
	return h;
}

describe("AnthropicBankedResetApplyScheduler", () => {
	it("claims at the weekly limit after a forced status read", async () => {
		const h = harness({ accounts: [weeklyOnly] });
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.forcedReads).toBe(1);
		expect(h.dispatched).toEqual([
			{
				grantId: "g1",
				requestId: "fresh-request",
				autoApply: {
					ledgerRowId: "acct-1:g1:1",
					cause: "weekly-limit",
					replay: false,
				},
			},
		]);
	});

	it("forces at most one status read per account per confirm interval", async () => {
		let now = NOW;
		const h = harness({ accounts: [weeklyOnly], rearmAt: NOW + DAY });
		h.deps.now = () => now;
		const scheduler = new AnthropicBankedResetApplyScheduler(h.deps);
		await scheduler.tick();
		now += BANKED_RESET_CONFIRM_READ_INTERVAL_MS - 1;
		await scheduler.tick();
		expect(h.forcedReads).toBe(1);
		now += 1;
		await scheduler.tick();
		expect(h.forcedReads).toBe(2);
	});

	it("expires stale claims at the start of every tick, before any replay", async () => {
		const h = harness({ accounts: [weeklyOnly], pending: [pendingRow()] });
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.expiredAt).toEqual([NOW]);
	});

	it("conserves the grant while another account can serve the scope", async () => {
		const h = harness({ accounts: [weeklyOnly], otherAvailable: true });
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.claims).toEqual([]);
	});

	it("claims on the last chance even when another account could serve", async () => {
		const h = harness({
			accounts: [weeklyOnly],
			otherAvailable: true,
			status: status({ grants: [grant({ endsAt: NOW + DAY / 2 })] }),
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.claims).toEqual([{ grantId: "g1", cause: "weekly-limit" }]);
	});

	it("does no forced read when discovery finds nothing", async () => {
		const h = harness({
			accounts: [weeklyOnly],
			usage: {
				five_hour: { utilization: 10, resets_at: null },
				seven_day: { utilization: 40, resets_at: null },
			} as UsageData,
			status: status({ exhausted: [] }),
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.forcedReads).toBe(0);
		expect(h.claims).toEqual([]);
	});

	it("discovers a family-weekly memo entry for a window the grant clears", async () => {
		const h = harness({
			accounts: [weeklyOnly],
			usage: null,
			status: status({
				exhausted: [],
				grants: [grant({ clears: ["seven_day_opus"] })],
			}),
			memo: { opus: NOW + DAY },
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.forcedReads).toBe(1);
		expect(h.poolChecks).toEqual([["seven_day_opus"]]);
	});

	it("forces no read for a memo whose window the cached grant does not clear", async () => {
		const h = harness({
			accounts: [weeklyOnly],
			usage: null,
			status: status({ exhausted: [] }),
			memo: { opus: NOW + DAY },
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.forcedReads).toBe(0);
	});

	it("forces no read for an at-limit window the cached grant does not clear", async () => {
		const h = harness({
			accounts: [weeklyOnly],
			status: status({
				exhausted: [],
				grants: [grant({ clears: ["seven_day_opus"] })],
			}),
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.forcedReads).toBe(0);
		expect(h.claims).toEqual([]);
	});

	it("still forces the read that populates a missing status", async () => {
		const h = harness({ accounts: [weeklyOnly], status: null });
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.forcedReads).toBe(1);
	});

	it("forces no read for a missing status while another account can serve the at-limit window", async () => {
		const h = harness({
			accounts: [weeklyOnly],
			status: null,
			otherAvailable: true,
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.poolChecks).toEqual([["seven_day"]]);
		expect(h.forcedReads).toBe(0);
	});

	it("forces no read when the at-limit window resets on its own within 12h", async () => {
		const h = harness({
			accounts: [weeklyOnly],
			usage: {
				five_hour: { utilization: 10, resets_at: null },
				seven_day: {
					utilization: 100,
					resets_at: new Date(NOW + 2 * 60 * 60_000).toISOString(),
				},
			} as UsageData,
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.forcedReads).toBe(0);
		expect(h.poolChecks).toEqual([]);
	});

	it("forces no read during the weekly cooldown, last chance included", async () => {
		for (const endsAt of [NOW + 3 * DAY, NOW + DAY / 2]) {
			const h = harness({
				accounts: [weeklyOnly],
				status: status({ grants: [grant({ endsAt })] }),
				cooldownAnchorAt: NOW - BANKED_RESET_WEEKLY_LIMIT_COOLDOWN_MS / 2,
			});
			await new AnthropicBankedResetApplyScheduler(h.deps).tick();
			expect(h.forcedReads).toBe(0);
			expect(h.poolChecks).toEqual([]);
		}
	});

	it("still forces the read when the at-limit window's reset is unknown", async () => {
		const h = harness({
			accounts: [weeklyOnly],
			usage: {
				five_hour: { utilization: 10, resets_at: null },
				seven_day: { utilization: 100, resets_at: null },
			} as UsageData,
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.forcedReads).toBe(1);
	});

	it("claims a memo-only opus limit using the memo's reset time", async () => {
		const h = harness({
			accounts: [weeklyOnly],
			usage: {
				five_hour: { utilization: 10, resets_at: null },
				seven_day: {
					utilization: 50,
					resets_at: new Date(NOW + DAY).toISOString(),
				},
			} as UsageData,
			status: status({
				exhausted: ["seven_day_opus"],
				grants: [grant({ clears: ["seven_day_opus"] })],
			}),
			memo: { opus: NOW + 3 * DAY },
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.claims).toEqual([{ grantId: "g1", cause: "weekly-limit" }]);
	});

	it("forces no read for a weekly-only candidate another account can serve", async () => {
		const h = harness({ accounts: [weeklyOnly], otherAvailable: true });
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.poolChecks).toEqual([["seven_day"]]);
		expect(h.forcedReads).toBe(0);
		expect(h.claims).toEqual([]);
	});

	it("still reads and claims an expiring grant while another account can serve", async () => {
		const h = harness({
			otherAvailable: true,
			status: status({
				grants: [grant({ endsAt: NOW + BANKED_RESET_AUTO_APPLY_LEAD_MS })],
			}),
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.forcedReads).toBe(1);
		expect(h.claims).toEqual([{ grantId: "g1", cause: "expiry" }]);
		expect(h.dispatched).toHaveLength(1);
	});

	it("keeps the status cache fresh for a weekly-only account at a limit", async () => {
		const h = harness({ accounts: [weeklyOnly], otherAvailable: true });
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.cachedReads).toEqual(["acct-1"]);
	});

	it("does no cached status read for a weekly-only account below its limits", async () => {
		const h = harness({
			accounts: [weeklyOnly],
			usage: {
				five_hour: { utilization: 10, resets_at: null },
				seven_day: { utilization: 40, resets_at: null },
			} as UsageData,
			status: status({ exhausted: [] }),
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.cachedReads).toEqual([]);
	});

	it("sends no claim when the toggle is turned off during the forced status read", async () => {
		const h = harness({
			accounts: [
				weeklyOnly,
				{
					...weeklyOnly,
					anthropic_auto_apply_banked_reset_on_weekly_limit_enabled: false,
				},
			],
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.forcedReads).toBe(1);
		expect(h.claims).toEqual([]);
		expect(h.dispatched).toEqual([]);
	});

	it("sends no claim when the account is disabled during the forced status read", async () => {
		const h = harness({
			accounts: [weeklyOnly, { ...weeklyOnly, disabled: true }],
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.dispatched).toEqual([]);
	});

	it("replays a due pending row with its stored request id and claims nothing new", async () => {
		const h = harness({ accounts: [weeklyOnly], pending: [pendingRow()] });
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.claims).toEqual([]);
		expect(h.forcedReads).toBe(0);
		expect(h.dispatched).toEqual([
			{
				grantId: "g1",
				requestId: "stored-request",
				autoApply: {
					ledgerRowId: "acct-1:g1:1",
					cause: "weekly-limit",
					replay: true,
				},
			},
		]);
	});

	it("waits for a backed-off pending row", async () => {
		const h = harness({
			accounts: [weeklyOnly],
			pending: [pendingRow({ next_attempt_at: NOW + 60_000 })],
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.dispatched).toEqual([]);
		expect(h.forcedReads).toBe(0);
	});

	it("starts no new attempt, and forces no read, while a manual claim is pending", async () => {
		const manual = pendingRow({
			id: "manual-row",
			trigger: "manual",
			cause: null,
			attempt_seq: null,
			request_id: "manual-request",
		});
		for (const accounts of [[weeklyOnly], [expiryOnly]]) {
			const h = harness({ accounts, pending: [manual] });
			await new AnthropicBankedResetApplyScheduler(h.deps).tick();
			expect(h.claims).toEqual([]);
			expect(h.dispatched).toEqual([]);
			expect(h.forcedReads).toBe(0);
		}
	});

	it("still replays its own pending auto row beside a pending manual claim", async () => {
		const h = harness({
			accounts: [weeklyOnly],
			pending: [
				pendingRow({
					id: "manual-row",
					trigger: "manual",
					cause: null,
					attempt_seq: null,
					request_id: "manual-request",
					created_at: NOW - 120_000,
				}),
				pendingRow(),
			],
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.claims).toEqual([]);
		expect(h.dispatched.map((request) => request.requestId)).toEqual([
			"stored-request",
		]);
	});

	it("starts no new claim, expiry included, beside a dormant pending auto row", async () => {
		const near = NOW + BANKED_RESET_AUTO_APPLY_LEAD_MS - 1;
		const h = harness({
			accounts: [expiryOnly],
			pending: [pendingRow({ grant_id: "g_old" })],
			status: status({
				grants: [grant({ endsAt: near, useRequiresLimit: false })],
			}),
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.forcedReads).toBe(0);
		expect(h.claims).toEqual([]);
		expect(h.dispatched).toEqual([]);
	});

	it("forces no status read while the cache holds an unexpired ineligible status", async () => {
		const h = harness({
			accounts: [weeklyOnly],
			status: status({
				eligible: false,
				ineligibleReason: "config_off",
				grants: [],
				nextGrantId: null,
			}),
			statusNeedsRefresh: false,
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.forcedReads).toBe(0);
	});

	it("reads again once the ineligible status is due by the cache's rules", async () => {
		const h = harness({
			accounts: [weeklyOnly],
			status: status({ eligible: false, ineligibleReason: "config_off" }),
			statusNeedsRefresh: true,
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.forcedReads).toBe(1);
	});

	it("claims nothing while the account's re-arm deadline stands", async () => {
		const h = harness({ accounts: [weeklyOnly], rearmAt: NOW + 60_000 });
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.claims).toEqual([]);
	});

	it("leaves a pending row dormant while its toggle is off", async () => {
		const h = harness({
			accounts: [expiryOnly],
			pending: [pendingRow()],
			status: status({ exhausted: [] }),
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.dispatched).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// One weekly-limit claim per tick
// ---------------------------------------------------------------------------

interface FleetMember {
	id: string;
	account: Partial<Account>;
	status?: AnthropicBankedResetStatus;
	/** When the member's exhausted `seven_day` window resets on its own. */
	weeklyResetsAt?: number;
	pending?: AnthropicBankedResetEventRow[];
	forcedReadFails?: boolean;
}

function fleet(members: FleetMember[]) {
	const byId = new Map(members.map((member) => [member.id, member]));
	const dispatched: Array<{
		accountId: string;
		request: AnthropicBankedResetClaimRequest;
	}> = [];
	const forcedReads: string[] = [];
	const deps: BankedResetApplyDeps = {
		listCandidateAccounts: async () =>
			members.map((member) => ({ id: member.id, name: member.id })),
		expireStaleAttempts: async () => 0,
		getRecoveryPending: async () => [],
		clearRecoveryPending: async () => true,
		getPauseMarker: async () => null,
		resumeIfOveragePausedAt: async () => false,
		peekUsageObservation: () => null,
		refreshUsage: async () => true,
		getAccount: async (id) => {
			const member = byId.get(id);
			return member ? account({ id, name: id, ...member.account }) : null;
		},
		getCachedStatus: (id) => byId.get(id)?.status ?? status(),
		refreshStatus: async (id, force) => {
			if (!force) return true;
			forcedReads.push(id);
			return !byId.get(id)?.forcedReadFails;
		},
		getPendingAttempts: async (id) => byId.get(id)?.pending ?? [],
		getAutoApplyCooldownAnchorAt: async () => null,
		getRearmAt: async () => null,
		statusNeedsRefresh: () => true,
		getUsage: (id) =>
			({
				five_hour: { utilization: 10, resets_at: null },
				seven_day: {
					utilization: 100,
					resets_at: new Date(
						byId.get(id)?.weeklyResetsAt ?? NOW + DAY,
					).toISOString(),
				},
			}) as UsageData,
		getFamilyWeeklyMemo: () => ({}),
		hasOtherAvailableAccount: async () => false,
		claimAutoAttempt: async (input) => ({
			id: `${input.accountId}:${input.grantId}:1`,
			requestId: `request-${input.accountId}`,
			attemptSeq: 1,
			reused: false,
		}),
		dispatchClaim: async (accountId, request) => {
			dispatched.push({ accountId, request });
			return completedOutcome();
		},
		now: () => NOW,
	};
	return { deps, dispatched, forcedReads };
}

describe("AnthropicBankedResetApplyScheduler weekly-limit ranking", () => {
	const expiring = status({
		exhausted: [],
		grants: [
			grant({
				endsAt: NOW + BANKED_RESET_AUTO_APPLY_LEAD_MS,
				useRequiresLimit: false,
			}),
		],
	});

	it("spends one grant per tick, on the account whose window resets latest", async () => {
		const f = fleet([
			{ id: "a", account: weeklyOnly, weeklyResetsAt: NOW + 2 * DAY },
			{ id: "b", account: weeklyOnly, weeklyResetsAt: NOW + 4 * DAY },
			{ id: "c", account: weeklyOnly, weeklyResetsAt: NOW + 3 * DAY },
		]);
		await new AnthropicBankedResetApplyScheduler(f.deps).tick();
		expect(f.dispatched.map(({ accountId }) => accountId)).toEqual(["b"]);
		expect(f.forcedReads).toEqual(["b"]);
	});

	it("breaks a tie on the grant that ends first", async () => {
		const endingIn = (days: number) =>
			status({ grants: [grant({ endsAt: NOW + days * DAY })] });
		const f = fleet([
			{ id: "a", account: weeklyOnly, status: endingIn(6) },
			{ id: "b", account: weeklyOnly, status: endingIn(5) },
			{ id: "c", account: weeklyOnly, status: endingIn(6) },
		]);
		await new AnthropicBankedResetApplyScheduler(f.deps).tick();
		expect(f.dispatched.map(({ accountId }) => accountId)).toEqual(["b"]);
	});

	it("falls through to the next account when the first fails its confirmation", async () => {
		const f = fleet([
			{ id: "a", account: weeklyOnly, weeklyResetsAt: NOW + 2 * DAY },
			{
				id: "b",
				account: weeklyOnly,
				weeklyResetsAt: NOW + 4 * DAY,
				forcedReadFails: true,
			},
			{ id: "c", account: weeklyOnly, weeklyResetsAt: NOW + 3 * DAY },
		]);
		await new AnthropicBankedResetApplyScheduler(f.deps).tick();
		expect(f.forcedReads).toEqual(["b", "c"]);
		expect(f.dispatched.map(({ accountId }) => accountId)).toEqual(["c"]);
	});

	it("still claims an expiring grant on another account in the same tick", async () => {
		const f = fleet([
			{ id: "a", account: weeklyOnly, weeklyResetsAt: NOW + 2 * DAY },
			{ id: "b", account: weeklyOnly, weeklyResetsAt: NOW + 4 * DAY },
			{ id: "e", account: expiryOnly, status: expiring },
		]);
		await new AnthropicBankedResetApplyScheduler(f.deps).tick();
		expect(
			f.dispatched.map(({ accountId, request }) => [
				accountId,
				request.autoApply?.cause,
			]),
		).toEqual([
			["e", "expiry"],
			["b", "weekly-limit"],
		]);
	});

	it("re-checks the pool right before the weekly claim, after this tick's expiry claims", async () => {
		const f = fleet([
			{ id: "b", account: weeklyOnly },
			{ id: "e", account: expiryOnly, status: expiring },
		]);
		const checks: boolean[] = [];
		f.deps.hasOtherAvailableAccount = async () => {
			const restored = f.dispatched.some(({ accountId }) => accountId === "e");
			checks.push(restored);
			return restored;
		};
		await new AnthropicBankedResetApplyScheduler(f.deps).tick();
		expect(checks).toEqual([false, true]);
		expect(f.dispatched.map(({ accountId }) => accountId)).toEqual(["e"]);
	});

	it("gives the tick's weekly slot to a pending weekly-limit replay", async () => {
		const f = fleet([
			{
				id: "a",
				account: weeklyOnly,
				pending: [pendingRow({ id: "a:g1:1", account_id: "a" })],
			},
			{ id: "b", account: weeklyOnly, weeklyResetsAt: NOW + 4 * DAY },
		]);
		await new AnthropicBankedResetApplyScheduler(f.deps).tick();
		expect(
			f.dispatched.map(({ accountId, request }) => [
				accountId,
				request.autoApply?.replay,
			]),
		).toEqual([["a", true]]);
		expect(f.forcedReads).toEqual([]);
	});

	it("holds the weekly slot while a replayable weekly-limit claim backs off", async () => {
		const f = fleet([
			{
				id: "a",
				account: weeklyOnly,
				pending: [
					pendingRow({
						id: "a:g1:1",
						account_id: "a",
						next_attempt_at: NOW + 60_000,
					}),
				],
			},
			{ id: "b", account: weeklyOnly, weeklyResetsAt: NOW + 4 * DAY },
		]);
		await new AnthropicBankedResetApplyScheduler(f.deps).tick();
		expect(f.dispatched).toEqual([]);
		expect(f.forcedReads).toEqual([]);
	});

	it("leaves the weekly slot open beside a backed-off claim that may not replay", async () => {
		const f = fleet([
			{
				id: "a",
				account: expiryOnly,
				pending: [
					pendingRow({
						id: "a:g1:1",
						account_id: "a",
						next_attempt_at: NOW + 60_000,
					}),
				],
			},
			{ id: "b", account: weeklyOnly, weeklyResetsAt: NOW + 4 * DAY },
		]);
		await new AnthropicBankedResetApplyScheduler(f.deps).tick();
		expect(f.dispatched.map(({ accountId }) => accountId)).toEqual(["b"]);
	});

	it("leaves the weekly slot open after an expiry replay", async () => {
		const f = fleet([
			{
				id: "a",
				account: expiryOnly,
				pending: [
					pendingRow({ id: "a:g1:1", account_id: "a", cause: "expiry" }),
				],
			},
			{ id: "b", account: weeklyOnly },
		]);
		await new AnthropicBankedResetApplyScheduler(f.deps).tick();
		expect(f.dispatched.map(({ accountId }) => accountId)).toEqual(["a", "b"]);
	});
});

// ---------------------------------------------------------------------------
// Production pool gate
// ---------------------------------------------------------------------------

function usageWith(windows: Record<string, number>): UsageData {
	const at = new Date(NOW + DAY).toISOString();
	const data: Record<string, unknown> = {
		five_hour: { utilization: 0, resets_at: at },
		seven_day: { utilization: windows.seven_day ?? 0, resets_at: at },
	};
	for (const [key, value] of Object.entries(windows)) {
		if (key !== "seven_day") data[key] = { utilization: value, resets_at: at };
	}
	return data as UsageData;
}

function poolScheduler(options: {
	exhausted: AnthropicBankedResetStatus["exhausted"];
	clears: AnthropicBankedResetGrant["clears"];
	others: Array<{
		account: Partial<Account>;
		usage: UsageData | null;
		/** The reading a usage refresh leaves behind. */
		usageAfterRefresh?: UsageData | null;
	}>;
	keys?: Array<Partial<ApiKey>>;
}) {
	const self = account(weeklyOnly);
	const others = options.others.map(({ account: overrides }, index) =>
		account({
			id: `other-${index}`,
			name: `other-${index}`,
			anthropic_auto_apply_banked_resets_enabled: false,
			anthropic_auto_apply_banked_reset_on_weekly_limit_enabled: false,
			...overrides,
		}),
	);
	const usageById = new Map<string, UsageData | null>([
		[
			"acct-1",
			usageWith(
				Object.fromEntries(options.exhausted.map((window) => [window, 100])),
			),
		],
		...options.others.map(
			({ usage }, index) => [`other-${index}`, usage] as const,
		),
	]);
	const refreshNow = mock(async (id: string) => {
		const other = options.others[Number(id.replace("other-", ""))];
		if (other?.usageAfterRefresh !== undefined) {
			usageById.set(id, other.usageAfterRefresh);
		}
		return true;
	});
	const dispatched: AnthropicBankedResetClaimRequest[] = [];
	const scheduler = createAnthropicBankedResetApplyScheduler({
		dbOps: {
			getAllAccounts: async () => [self, ...others],
			getAccount: async (id: string) =>
				[self, ...others].find((candidate) => candidate.id === id) ?? null,
			getActiveApiKeys: async () => (options.keys ?? []) as ApiKey[],
			expireStaleAnthropicBankedResetAttempts: async () => 0,
			getPendingAnthropicBankedResetAttempts: async () => [],
			getAnthropicBankedResetAutoApplyCooldownAnchorAt: async () => null,
			getAnthropicBankedResetRearmAt: async () => null,
			getAnthropicBankedResetRecoveryPending: async () => [],
			clearAnthropicBankedResetRecoveryPending: async () => true,
			getAccountPauseMarker: async () => null,
			resumeAccountIfOveragePausedAt: async () => false,
			claimAnthropicBankedResetAutoAttempt: async (input) => ({
				id: `acct-1:${input.grantId}:1`,
				requestId: "req",
				attemptSeq: 1,
				reused: false,
			}),
		},
		coordinator: { refreshStatus: async () => ({ success: true }) },
		usage: {
			get: (id: string) => usageById.get(id) ?? null,
			peekWithAge: () => null,
			refreshNow,
		},
		overrides: {
			getCachedStatus: () =>
				status({
					exhausted: options.exhausted,
					grants: [grant({ clears: options.clears })],
				}),
			dispatchClaim: async (_id, request) => {
				dispatched.push(request);
				return completedOutcome();
			},
			now: () => NOW,
		},
	});
	return { scheduler, dispatched, refreshNow };
}

describe("createAnthropicBankedResetApplyScheduler pool gate", () => {
	it("conserves an account-wide grant while another account has weekly headroom", async () => {
		const { scheduler, dispatched } = poolScheduler({
			exhausted: ["seven_day"],
			clears: ["seven_day"],
			others: [{ account: {}, usage: usageWith({ seven_day: 50 }) }],
		});
		await scheduler.tick();
		expect(dispatched).toEqual([]);
	});

	it("does not conserve an opus grant just because a sonnet-capable account exists", async () => {
		const { scheduler, dispatched } = poolScheduler({
			exhausted: ["seven_day_opus"],
			clears: ["seven_day_opus"],
			others: [
				{
					account: {},
					usage: usageWith({
						seven_day: 50,
						seven_day_opus: 100,
						seven_day_sonnet: 10,
					}),
				},
			],
		});
		await scheduler.tick();
		expect(dispatched).toHaveLength(1);
	});

	it("treats an opus family-weekly memo entry on the alternative as unavailable", async () => {
		recordFamilyWeeklyExhausted("other-0", "opus", NOW + DAY, NOW - 1_000);
		const { scheduler, dispatched } = poolScheduler({
			exhausted: ["seven_day_opus"],
			clears: ["seven_day_opus"],
			others: [{ account: {}, usage: usageWith({ seven_day: 50 }) }],
		});
		await scheduler.tick();
		expect(dispatched).toHaveLength(1);
	});

	it("skips paused, rate-limited and non-OAuth alternatives", async () => {
		const { scheduler, dispatched } = poolScheduler({
			exhausted: ["seven_day"],
			clears: ["seven_day"],
			others: [
				{ account: { paused: true }, usage: usageWith({ seven_day: 0 }) },
				{
					account: { rate_limited_until: NOW + 60_000 },
					usage: usageWith({ seven_day: 0 }),
				},
				{ account: { refresh_token: "" }, usage: usageWith({ seven_day: 0 }) },
			],
		});
		await scheduler.tick();
		expect(dispatched).toHaveLength(1);
	});

	it("reads an unknown alternative's usage once and counts it able to serve if still unknown", async () => {
		const { scheduler, dispatched, refreshNow } = poolScheduler({
			exhausted: ["seven_day"],
			clears: ["seven_day"],
			others: [{ account: {}, usage: null }],
		});
		await scheduler.tick();
		expect(refreshNow).toHaveBeenCalledTimes(1);
		expect(dispatched).toEqual([]);
	});

	it("claims once the one read shows the unknown alternative at its limit", async () => {
		const { scheduler, dispatched, refreshNow } = poolScheduler({
			exhausted: ["seven_day"],
			clears: ["seven_day"],
			others: [
				{
					account: {},
					usage: null,
					usageAfterRefresh: usageWith({ seven_day: 100 }),
				},
			],
		});
		await scheduler.tick();
		expect(refreshNow).toHaveBeenCalledTimes(1);
		expect(dispatched).toHaveLength(1);
	});

	it("does not count an alternative whose 5-hour window is at its limit", async () => {
		const { scheduler, dispatched } = poolScheduler({
			exhausted: ["seven_day"],
			clears: ["seven_day"],
			others: [
				{ account: {}, usage: usageWith({ seven_day: 10, five_hour: 100 }) },
			],
		});
		await scheduler.tick();
		expect(dispatched).toHaveLength(1);
	});

	it("reads an alternative lacking the 5-hour window once, then counts it able to serve", async () => {
		const reading = usageWith({ seven_day: 10 }) as Record<string, unknown>;
		delete reading.five_hour;
		const { scheduler, dispatched, refreshNow } = poolScheduler({
			exhausted: ["seven_day_opus"],
			clears: ["seven_day_opus"],
			others: [{ account: {}, usage: reading as UsageData }],
		});
		await scheduler.tick();
		expect(refreshNow).toHaveBeenCalledTimes(1);
		expect(dispatched).toEqual([]);
	});

	it("treats traffic pinned to the exhausted account as having no substitute", async () => {
		const { scheduler, dispatched } = poolScheduler({
			exhausted: ["seven_day"],
			clears: ["seven_day"],
			others: [{ account: {}, usage: usageWith({ seven_day: 0 }) }],
			keys: [{ pinnedAccountId: "acct-1" }],
		});
		await scheduler.tick();
		expect(dispatched).toHaveLength(1);
	});
});

describe("owed overage-pause verdicts", () => {
	const HOUR = 60 * 60_000;
	const EPOCH = 5;
	function owed(
		overrides: Partial<AnthropicBankedResetEventRow> = {},
	): AnthropicBankedResetEventRow {
		return pendingRow({
			id: "owed-row",
			account_id: "acct-owed",
			status: "reset",
			resolved_at: NOW - 60_000,
			recovery_pending_until: NOW - 60_000 + HOUR,
			recovery_pause_epoch: EPOCH,
			recovery_pause_changed_at: NOW - 3_600_000,
			...overrides,
		});
	}
	function overagePause(pauseEpoch = EPOCH): AccountPauseMarker {
		return {
			paused: true,
			pauseReason: "overage",
			autoPauseOnOverageEnabled: true,
			pauseEpoch,
			pauseChangedAt: NOW - 3_600_000,
		};
	}
	const headroom = {
		five_hour: { utilization: 10, resets_at: null },
		seven_day: {
			utilization: 20,
			resets_at: new Date(NOW + DAY).toISOString(),
		},
	} as UsageData;
	const atLimit = {
		five_hour: { utilization: 10, resets_at: null },
		seven_day: {
			utilization: 100,
			resets_at: new Date(NOW + DAY).toISOString(),
		},
	} as UsageData;

	async function run(options: Parameters<typeof harness>[0]) {
		const h = harness({
			candidates: [],
			pauseMarker: () => overagePause(),
			...options,
		});
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		return h;
	}

	it("lifts exactly the claim-time pause from a post-claim reading with headroom, for an account with no toggle on", async () => {
		const h = await run({
			recovery: [owed()],
			observation: { data: headroom, observedAtMs: NOW - 1_000 },
		});
		expect(h.resumed).toEqual([`acct-owed@${EPOCH}`]);
		expect(h.cleared).toEqual(["owed-row"]);
		expect(h.usageRefreshes).toEqual([]);
		expect(h.dispatched).toEqual([]);
	});

	it("never lifts a newer pause: operator resume, headroom, re-pause for overage, then a tick", async () => {
		// The claim recorded pause EPOCH. The operator resumes (EPOCH + 1), a
		// poll sees headroom, traffic spends a window and the account is paused
		// for overage again (EPOCH + 2), all before the next tick.
		let marker = overagePause();
		const h = harness({
			candidates: [],
			recovery: [owed()],
			pauseMarker: () => marker,
			observation: { data: headroom, observedAtMs: NOW - 30_000 },
		});
		marker = {
			...marker,
			paused: false,
			pauseReason: null,
			pauseEpoch: EPOCH + 1,
		};
		marker = { ...overagePause(EPOCH + 2), pauseChangedAt: NOW - 10_000 };
		await new AnthropicBankedResetApplyScheduler(h.deps).tick();
		expect(h.resumed).toEqual([]);
		expect(h.cleared).toEqual(["owed-row"]);
		expect(h.usageRefreshes).toEqual([]);
	});

	it("settles without resuming once the account is no longer paused", async () => {
		const h = await run({
			recovery: [owed()],
			pauseMarker: () => ({
				...overagePause(EPOCH + 1),
				paused: false,
				pauseReason: null,
			}),
			observation: { data: headroom, observedAtMs: NOW - 1_000 },
		});
		expect(h.resumed).toEqual([]);
		expect(h.cleared).toEqual(["owed-row"]);
	});

	it("requires the reading to postdate the recorded pause as well as the claim", async () => {
		const h = await run({
			recovery: [owed({ recovery_pause_changed_at: NOW - 500 })],
			observation: { data: headroom, observedAtMs: NOW - 1_000 },
		});
		expect(h.resumed).toEqual([]);
		expect(h.cleared).toEqual([]);
		expect(h.usageRefreshes).toEqual(["acct-owed"]);
	});

	it("keeps the pause but settles the verdict when the reading is at a limit", async () => {
		const h = await run({
			recovery: [owed()],
			observation: { data: atLimit, observedAtMs: NOW - 1_000 },
		});
		expect(h.resumed).toEqual([]);
		expect(h.cleared).toEqual(["owed-row"]);
	});

	it("ignores a reading from before the claim and reads once, leaving the mark without one", async () => {
		const h = await run({
			recovery: [owed(), owed({ id: "owed-row-2" })],
			observation: { data: headroom, observedAtMs: NOW - 120_000 },
		});
		expect(h.usageRefreshes).toEqual(["acct-owed"]);
		expect(h.resumed).toEqual([]);
		expect(h.cleared).toEqual([]);
		expect(h.dispatched).toEqual([]);
	});

	it("uses the reading its one refresh produced", async () => {
		const h = await run({
			recovery: [owed()],
			observation: null,
			observationAfterRefresh: { data: headroom, observedAtMs: NOW },
		});
		expect(h.usageRefreshes).toEqual(["acct-owed"]);
		expect(h.resumed).toEqual([`acct-owed@${EPOCH}`]);
		expect(h.cleared).toEqual(["owed-row"]);
	});

	it("gives up once the recovery window has passed", async () => {
		const h = await run({
			recovery: [owed({ recovery_pending_until: NOW })],
			observation: { data: headroom, observedAtMs: NOW - 1_000 },
		});
		expect(h.resumed).toEqual([]);
		expect(h.cleared).toEqual(["owed-row"]);
		expect(h.usageRefreshes).toEqual([]);
	});
});
