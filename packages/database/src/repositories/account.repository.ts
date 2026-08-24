import { getAppVersionSync } from "@clankermux/core";
import {
	type Account,
	type AccountIdentity,
	type AccountRow,
	type RateLimitReason,
	toAccount,
} from "@clankermux/types";
import { BaseRepository } from "./base.repository";

// Shared identity COALESCE-merge fragment. Each field is COALESCE'd against its
// existing column so a null arriving piecemeal never erases a previously-captured
// value. Used by both updateTokens (token-path capture) and
// setAccountIdentityFromProfile (profile-fetch capture); keeping it in one place
// guarantees the two paths can never drift.
const IDENTITY_COALESCE_SET = `identity_external_id = COALESCE(?, identity_external_id),
				identity_email = COALESCE(?, identity_email),
				identity_organization_name = COALESCE(?, identity_organization_name),
				identity_plan_tier = COALESCE(?, identity_plan_tier),
				identity_rate_limit_tier = COALESCE(?, identity_rate_limit_tier)`;

function identityBindParams(identity: AccountIdentity): Array<string | null> {
	// Order MUST match the `?` placeholders in IDENTITY_COALESCE_SET above.
	return [
		identity.externalAccountId,
		identity.email,
		identity.organizationName,
		identity.planTier,
		identity.rateLimitTier,
	];
}

/** The account's stored tier pair, as it was before an identity write. */
interface StoredTiers {
	plan_tier: string | null;
	rate_limit_tier: string | null;
}

export class AccountRepository extends BaseRepository<Account> {
	/**
	 * Run an identity-bearing account UPDATE and, when it actually changed the
	 * account's EFFECTIVE tier pair, append the matching `account_tier_history`
	 * row — both in ONE transaction.
	 *
	 * Three properties this exists to guarantee, none of which a caller-side
	 * "update then insert" would have:
	 *
	 *  1. **Change-only.** The identity writes are COALESCE merges, so an
	 *     incoming null PRESERVES the stored tier. The comparison is therefore
	 *     against the merged effective values, not against the incoming ones —
	 *     otherwise every token refresh that omits the tier would record a
	 *     spurious "changed to null" transition.
	 *  2. **CAS-honest.** `updateTokens` guards its write on the refresh token it
	 *     exchanged. A rejected write changes nothing, so it must not leave a
	 *     history row claiming a tier the account never adopted — hence the
	 *     `changes > 0` gate.
	 *  3. **Atomic.** A crash between the two writes would either lose the
	 *     transition or invent one; one transaction cannot.
	 *
	 * ## Why it runs through the adapter and not the raw handle
	 *
	 * The transaction goes to {@link BunSqlAdapter.runTransaction}, which wraps it
	 * in the SAME async SQLITE_BUSY retry loop every other write on this
	 * connection gets. Calling `db.transaction(fn)()` directly would drop these
	 * writes to the bare C-level busy_timeout (250ms), and the writes coming
	 * through here are token refreshes: when the cleanup/vacuum worker holds the
	 * writer slot, a fail-fast refresh takes the account out of the pool until the
	 * next attempt.
	 *
	 * A no-identity call has nothing to compare and no history row to append, so
	 * it stays the single `runWithChanges` statement it has always been — same
	 * retry envelope, no transaction it does not need.
	 *
	 * Returns the UPDATE's affected-row count so CAS callers can report it.
	 */
	private async writeIdentityWithTierHistory(
		accountId: string,
		sql: string,
		params: unknown[],
		identity: AccountIdentity | null | undefined,
	): Promise<number> {
		if (!identity) return this.runWithChanges(sql, params);

		const db = this.adapter.getSQLiteDb();
		return this.adapter.runTransaction(() => {
			const before = db
				.query(
					`SELECT identity_plan_tier AS plan_tier,
					        identity_rate_limit_tier AS rate_limit_tier
					 FROM accounts WHERE id = ?`,
				)
				.get(accountId) as StoredTiers | null | undefined;

			const changes = db.run(sql, params as never[]).changes;
			if (changes === 0 || !before) return changes;

			// COALESCE-merged effective values — exactly what the UPDATE just wrote.
			const planTier = identity.planTier ?? before.plan_tier;
			const rateLimitTier = identity.rateLimitTier ?? before.rate_limit_tier;
			if (
				planTier === before.plan_tier &&
				rateLimitTier === before.rate_limit_tier
			) {
				return changes;
			}

			db.run(
				`INSERT INTO account_tier_history (
					account_id, observed_at, plan_tier, rate_limit_tier, source, app_version
				) VALUES (?, ?, ?, ?, 'identity-capture', ?)`,
				[
					accountId,
					Date.now(),
					planTier,
					rateLimitTier,
					// getAppVersionSync, NEVER getVersionSync — see the note in
					// backfills.ts: getVersionSync's no-environment fallback is the Claude
					// CLI compat version, which is not the build that made this record.
					getAppVersionSync(),
				] as never[],
			);
			return changes;
		});
	}

	async findAll(): Promise<Account[]> {
		const rows = await this.query<AccountRow>(`
			SELECT
				id, name, provider, api_key, refresh_token, access_token,
				expires_at, created_at, last_used, request_count, total_requests,
				rate_limited_until, rate_limited_reason, rate_limited_at, session_start, session_request_count,
				COALESCE(paused, 0) as paused,
				rate_limit_reset, rate_limit_status, rate_limit_remaining,
				COALESCE(priority, 0) as priority,
				COALESCE(auto_fallback_enabled, 0) as auto_fallback_enabled,
				COALESCE(auto_refresh_enabled, 0) as auto_refresh_enabled,
				COALESCE(auto_pause_on_overage_enabled, 0) as auto_pause_on_overage_enabled,
				COALESCE(peak_hours_pause_enabled, 0) as peak_hours_pause_enabled,
				COALESCE(codex_auto_apply_reset_credits_enabled, 0) as codex_auto_apply_reset_credits_enabled,
				COALESCE(codex_auto_apply_reset_on_weekly_limit_enabled, 0) as codex_auto_apply_reset_on_weekly_limit_enabled,
				custom_endpoint,
				model_mappings,
				model_fallbacks,
				billing_type,
				pause_reason,
				notes,
				refresh_token_issued_at,
				refresh_token_expires_at,
				renewal_anchor,
				renewal_cadence,
				renewal_price_usd_micros,
				renewal_auto_start_date,
				identity_external_id,
				identity_email,
				identity_organization_name,
				identity_plan_tier,
				identity_rate_limit_tier,
				identity_captured_at,
				identity_profile_fetched_at,
				COALESCE(consecutive_rate_limits, 0) as consecutive_rate_limits
			FROM accounts
			ORDER BY priority DESC
		`);
		return rows.map(toAccount);
	}

	async findById(accountId: string): Promise<Account | null> {
		const row = await this.get<AccountRow>(
			`
			SELECT
				id, name, provider, api_key, refresh_token, access_token,
				expires_at, created_at, last_used, request_count, total_requests,
				rate_limited_until, rate_limited_reason, rate_limited_at, session_start, session_request_count,
				COALESCE(paused, 0) as paused,
				rate_limit_reset, rate_limit_status, rate_limit_remaining,
				COALESCE(priority, 0) as priority,
				COALESCE(auto_fallback_enabled, 0) as auto_fallback_enabled,
				COALESCE(auto_refresh_enabled, 0) as auto_refresh_enabled,
				COALESCE(auto_pause_on_overage_enabled, 0) as auto_pause_on_overage_enabled,
				COALESCE(peak_hours_pause_enabled, 0) as peak_hours_pause_enabled,
				COALESCE(codex_auto_apply_reset_credits_enabled, 0) as codex_auto_apply_reset_credits_enabled,
				COALESCE(codex_auto_apply_reset_on_weekly_limit_enabled, 0) as codex_auto_apply_reset_on_weekly_limit_enabled,
				custom_endpoint,
				model_mappings,
				model_fallbacks,
				billing_type,
				pause_reason,
				notes,
				refresh_token_issued_at,
				refresh_token_expires_at,
				renewal_anchor,
				renewal_cadence,
				renewal_price_usd_micros,
				renewal_auto_start_date,
				identity_external_id,
				identity_email,
				identity_organization_name,
				identity_plan_tier,
				identity_rate_limit_tier,
				identity_captured_at,
				identity_profile_fetched_at,
				COALESCE(consecutive_rate_limits, 0) as consecutive_rate_limits
			FROM accounts
			WHERE id = ?
		`,
			[accountId],
		);

		return row ? toAccount(row) : null;
	}

	/**
	 * Persist refreshed OAuth tokens.
	 *
	 * When `expectedRefreshToken` is provided this becomes a compare-and-swap:
	 * the write applies ONLY while the account's stored `refresh_token` still
	 * equals the token the caller's refresh exchanged. If a concurrent reauth or
	 * rotation replaced it in the meantime, the guarded WHERE misses and the
	 * stale-generation write is rejected (0 rows changed → returns false), so a
	 * delayed refresh success can never clobber freshly-installed credentials.
	 * When `expectedRefreshToken` is omitted, the write is unconditional on
	 * `id = ?` as before. Returns true iff a row was actually written.
	 *
	 * `options.refreshTokenExpiresAt` rides along with a rotated refresh token
	 * and is written in the SAME statement, because it describes that specific
	 * token: splitting it into a second write would leave a CAS-rejected
	 * rotation's deadline attached to the token that actually survived.
	 *
	 * Three cases, in the order the SET resolves them:
	 *   1. A deadline was reported — always written. Whatever the provider just
	 *      told us about the token it just issued outranks anything stored.
	 *   2. No deadline, and the token is UNCHANGED (Qwen echoes on every
	 *      refresh; Anthropic does whenever its response omits `refresh_token`)
	 *      — keep the stored date. The credential did not change, so erasing its
	 *      known deadline would invent an unknown that isn't there.
	 *   3. No deadline, and the token DID rotate — clear it. The stored date
	 *      described the previous token, which is now dead upstream; carrying it
	 *      forward would advertise a deadline for a credential that is gone.
	 */
	async updateTokens(
		accountId: string,
		accessToken: string,
		expiresAt: number,
		refreshToken?: string,
		identity?: AccountIdentity | null,
		expectedRefreshToken?: string | null,
		options?: { refreshTokenExpiresAt?: number | null },
	): Promise<boolean> {
		const now = Date.now();
		// When identity is provided, COALESCE-merge each field so a null arriving
		// piecemeal (e.g. a Codex refresh that lacks an id_token → no email that
		// cycle) never erases a previously-captured value. identity_captured_at is
		// advanced whenever ANY identity field is written. identity_profile_fetched_at
		// is deliberately NOT touched here — it is set only by the profile-fetch
		// paths (account add/reauth and the startup backfill).
		const identitySet = identity
			? `,
				${IDENTITY_COALESCE_SET},
				identity_captured_at = ?`
			: "";
		const identityParams: Array<string | number | null> = identity
			? [...identityBindParams(identity), now]
			: [];
		// Compare-and-swap guard (see method doc): only pin on the exchanged
		// refresh token when the caller supplied one.
		const casClause =
			expectedRefreshToken != null ? " AND refresh_token = ?" : "";
		const casParams: Array<string | null> =
			expectedRefreshToken != null ? [expectedRefreshToken] : [];
		const newRefreshTokenExpiresAt = options?.refreshTokenExpiresAt ?? null;
		if (refreshToken) {
			const changes = await this.writeIdentityWithTierHistory(
				accountId,
				`UPDATE accounts SET access_token = ?, expires_at = ?, refresh_token = ?, refresh_token_issued_at = ?, refresh_token_expires_at = CASE WHEN ? IS NOT NULL THEN ? WHEN refresh_token = ? THEN refresh_token_expires_at ELSE NULL END${identitySet} WHERE id = ?${casClause}`,
				[
					accessToken,
					expiresAt,
					refreshToken,
					now,
					newRefreshTokenExpiresAt,
					newRefreshTokenExpiresAt,
					refreshToken,
					...identityParams,
					accountId,
					...casParams,
				],
				identity,
			);
			return changes > 0;
		}
		const changes = await this.writeIdentityWithTierHistory(
			accountId,
			`UPDATE accounts SET access_token = ?, expires_at = ?${identitySet} WHERE id = ?${casClause}`,
			[accessToken, expiresAt, ...identityParams, accountId, ...casParams],
			identity,
		);
		return changes > 0;
	}

	/**
	 * Persist an account identity captured from a successful profile-endpoint
	 * fetch (account add/reauth OR the one-time startup backfill).
	 *
	 * Differs from {@link updateTokens}'s identity arg in ONE key way: it stamps
	 * `identity_profile_fetched_at = now`. That timestamp is the gate that makes
	 * the startup backfill one-time — an account with a non-null
	 * `identity_profile_fetched_at` is never re-selected. Call this ONLY when the
	 * profile fetch actually returned data; on a null (failed/rate-limited) fetch
	 * the caller must skip the write so the account stays eligible next boot.
	 *
	 * Each identity field is COALESCE-merged so a null arriving in a later fetch
	 * never erases a previously-captured value; `identity_captured_at` advances
	 * whenever this write runs (it always carries identity).
	 */
	async setAccountIdentityFromProfile(
		accountId: string,
		identity: AccountIdentity,
	): Promise<void> {
		const now = Date.now();
		await this.writeIdentityWithTierHistory(
			accountId,
			`UPDATE accounts SET
				${IDENTITY_COALESCE_SET},
				identity_captured_at = ?,
				identity_profile_fetched_at = ?
			WHERE id = ?`,
			[...identityBindParams(identity), now, now, accountId],
			identity,
		);
	}

	/**
	 * Persist an account identity captured from a token decode (no network) —
	 * the token-agnostic sibling of {@link setAccountIdentityFromProfile}.
	 *
	 * Used by the Codex startup identity backfill, which locally decodes the
	 * access-token JWT. Unlike {@link setAccountIdentityFromProfile}, it does NOT
	 * stamp `identity_profile_fetched_at` — that column is Anthropic-profile-fetch
	 * specific (its one-time gate), and Codex identity has no profile fetch. Only
	 * `identity_captured_at` advances.
	 *
	 * Each identity field is COALESCE-merged so a null arriving here never erases
	 * a previously-captured value.
	 */
	async setAccountIdentity(
		accountId: string,
		identity: AccountIdentity,
	): Promise<void> {
		const now = Date.now();
		await this.writeIdentityWithTierHistory(
			accountId,
			`UPDATE accounts SET
				${IDENTITY_COALESCE_SET},
				identity_captured_at = ?
			WHERE id = ?`,
			[...identityBindParams(identity), now, accountId],
			identity,
		);
	}

	async incrementUsage(
		accountId: string,
		sessionDurationMs: number,
	): Promise<void> {
		const now = Date.now();
		await this.run(
			`
			UPDATE accounts
			SET
				last_used = ?,
				request_count = COALESCE(request_count, 0) + 1,
				total_requests = COALESCE(total_requests, 0) + 1,
				session_start = CASE
					WHEN session_start IS NULL OR ? - COALESCE(session_start, 0) >= ? THEN ?
					ELSE session_start
				END,
				session_request_count = CASE
					WHEN session_start IS NULL OR ? - COALESCE(session_start, 0) >= ? THEN 1
					ELSE COALESCE(session_request_count, 0) + 1
				END
			WHERE id = ?
		`,
			[now, now, sessionDurationMs, now, now, sessionDurationMs, accountId],
		);
	}

	async setRateLimited(
		accountId: string,
		until: number,
		reason: RateLimitReason,
	): Promise<number> {
		await this.run(
			`UPDATE accounts
			   SET consecutive_rate_limits = COALESCE(consecutive_rate_limits, 0) + 1,
			       rate_limited_until      = ?,
			       rate_limited_reason     = ?,
			       rate_limited_at         = ?
			 WHERE id = ?`,
			[until, reason, Date.now(), accountId],
		);
		const row = await this.get<{ consecutive_rate_limits: number }>(
			`SELECT consecutive_rate_limits FROM accounts WHERE id = ?`,
			[accountId],
		);
		return row?.consecutive_rate_limits ?? 0;
	}

	/**
	 * Set a rate-limit deadline WITHOUT escalating the consecutive-streak counter.
	 *
	 * Identical to {@link setRateLimited} except it omits the
	 * `consecutive_rate_limits = COALESCE(...) + 1` clause. Used for
	 * server-directed 429s that carry an explicit reset time (the upstream told us
	 * exactly when to retry) — those should honor the deadline but must not inflate
	 * the adaptive-backoff streak (Lever B).
	 */
	async setRateLimitedDeadlineOnly(
		accountId: string,
		until: number,
		reason: RateLimitReason,
	): Promise<void> {
		await this.run(
			`UPDATE accounts
			   SET rate_limited_until  = ?,
			       rate_limited_reason = ?,
			       rate_limited_at     = ?
			 WHERE id = ?`,
			[until, reason, Date.now(), accountId],
		);
	}

	/**
	 * Zero the 429 streak and null its timestamp. With `notAfterMs` the write is
	 * guarded: it only applies when the CURRENT `rate_limited_at` predates that
	 * bound (or is already NULL) — a stability reset driven by a stale success
	 * must not erase the timestamp of a 429 that landed after the request
	 * started, because the success-path clear's own stale guard keys on that
	 * very timestamp (nulling it would let the stale clear through).
	 */
	async resetConsecutiveRateLimits(
		accountId: string,
		notAfterMs?: number,
	): Promise<void> {
		if (notAfterMs === undefined) {
			await this.run(
				`UPDATE accounts SET consecutive_rate_limits = 0, rate_limited_at = NULL WHERE id = ?`,
				[accountId],
			);
			return;
		}
		await this.run(
			`UPDATE accounts SET consecutive_rate_limits = 0, rate_limited_at = NULL
			 WHERE id = ? AND (rate_limited_at IS NULL OR rate_limited_at < ?)`,
			[accountId, notAfterMs],
		);
	}

	async updateRateLimitMeta(
		accountId: string,
		status: string,
		reset: number | null,
		remaining?: number | null,
	): Promise<void> {
		await this.run(
			`UPDATE accounts SET rate_limit_status = ?, rate_limit_reset = ?, rate_limit_remaining = ? WHERE id = ?`,
			[status, reset, remaining ?? null, accountId],
		);
	}

	async clearRateLimitState(accountId: string): Promise<number> {
		return this.runWithChanges(
			`UPDATE accounts
			 SET
			 	rate_limited_until = NULL,
			 	rate_limited_reason = NULL,
			 	rate_limited_at = NULL,
			 	rate_limit_reset = NULL,
			 	rate_limit_status = NULL,
			 	rate_limit_remaining = NULL
			 WHERE id = ?`,
			[accountId],
		);
	}

	/**
	 * Compare-and-clear the rate-limit lock for the usage-poller's
	 * capacity-restored path. Clears the SAME columns as `clearRateLimitState`,
	 * but ONLY when the account's cooldown is STILL the exact one the caller
	 * observed — `rate_limited_until`, `rate_limited_at` AND `rate_limited_reason`
	 * all unchanged — and only when that cooldown is strictly OLDER than the
	 * evidence that justifies clearing it.
	 *
	 * Pinning on `rate_limited_at` (not just the deadline) matters because repeated
	 * 429s can reuse the SAME upstream reset time: a concurrent cooldown that
	 * happens to carry the same `rate_limited_until` would otherwise be cleared
	 * out from under a request that just set it. `rate_limited_at` is the write
	 * instant, so it changes on every fresh cooldown.
	 *
	 * Pinning on the REASON is what keeps the release quota-derived: the caller
	 * passes the exact eligible reason it observed (see
	 * `QUOTA_DERIVED_RATE_LIMIT_REASONS`), so a concurrent rewrite to ANY other
	 * reason — an `out_of_credits` floor, or a per-IP burst cooldown, which must
	 * never be released on account-quota evidence — misses the WHERE. This
	 * supersedes the older "everything except `out_of_credits`" guard.
	 *
	 * `rate_limited_at < ?` is the CAUSAL guard: the cooldown must predate the
	 * start of the usage request that produced the evidence. A cooldown written
	 * while that request was in flight is temporally ambiguous — the reading may
	 * predate it — so it is refused and re-evaluated on the next poll. Both
	 * cooldown writers stamp `rate_limited_at = Date.now()`, so a same-millisecond
	 * write equals the boundary and fails the strict `<`. A NULL `rate_limited_at`
	 * also fails it (NULL comparisons are never true), i.e. fails CLOSED.
	 *
	 * Together this makes the poller's read-check-clear ATOMIC at the DB layer: any
	 * concurrent cooldown write between the caller's read and this write leaves the
	 * new state intact. Returns true iff a row actually changed.
	 */
	async clearRateLimitOnCapacityRestore(
		accountId: string,
		expectedRateLimitedUntil: number,
		expectedRateLimitedAt: number | null,
		expectedRateLimitedReason: string,
		evidenceFetchStartedAt: number,
	): Promise<boolean> {
		const changes = await this.runWithChanges(
			`UPDATE accounts
			SET
				rate_limited_until = NULL,
				rate_limited_reason = NULL,
				rate_limited_at = NULL,
				rate_limit_reset = NULL,
				rate_limit_status = NULL,
				rate_limit_remaining = NULL
			WHERE id = ?
				AND rate_limited_until = ?
				AND rate_limited_at IS ?
				AND rate_limited_reason = ?
				AND rate_limited_at < ?`,
			[
				accountId,
				expectedRateLimitedUntil,
				expectedRateLimitedAt,
				expectedRateLimitedReason,
				evidenceFetchStartedAt,
			],
		);
		return changes > 0;
	}

	async pause(accountId: string, reason = "manual"): Promise<void> {
		await this.run(
			`UPDATE accounts SET paused = 1, pause_reason = ? WHERE id = ?`,
			[reason, accountId],
		);
	}

	/**
	 * Pause only if the account is currently active. Used by automated pausing
	 * (e.g. expired-subscription detection) so it never overwrites the reason
	 * on an account the user (or another guard) already paused. Returns true
	 * when the account was actually paused by this call.
	 *
	 * When `expectedRefreshToken` is provided the pause is additionally gated on
	 * the account still holding that exact refresh token. This guards the
	 * OAuth-invalid-grant pause against a stale/in-flight refresh (using an old
	 * token) re-pausing an account that was just re-authenticated — after reauth
	 * the stored refresh token differs, so the guarded UPDATE no-ops.
	 */
	async pauseIfActive(
		accountId: string,
		reason: string,
		expectedRefreshToken?: string | null,
	): Promise<boolean> {
		if (expectedRefreshToken != null) {
			const changes = await this.runWithChanges(
				`UPDATE accounts SET paused = 1, pause_reason = ? WHERE id = ? AND COALESCE(paused, 0) = 0 AND refresh_token = ?`,
				[reason, accountId, expectedRefreshToken],
			);
			return changes > 0;
		}
		const changes = await this.runWithChanges(
			`UPDATE accounts SET paused = 1, pause_reason = ? WHERE id = ? AND COALESCE(paused, 0) = 0`,
			[reason, accountId],
		);
		return changes > 0;
	}

	async resume(accountId: string): Promise<void> {
		await this.run(
			`UPDATE accounts SET paused = 0, pause_reason = NULL WHERE id = ?`,
			[accountId],
		);
	}

	/**
	 * Resume only if the account is paused with the given reason. Used by the
	 * automated subscription-renewal resume so it never lifts a manual pause.
	 * Returns true when the account was actually resumed by this call.
	 */
	async resumeIfPausedWithReason(
		accountId: string,
		reason: string,
	): Promise<boolean> {
		const changes = await this.runWithChanges(
			`UPDATE accounts SET paused = 0, pause_reason = NULL WHERE id = ? AND paused = 1 AND pause_reason = ?`,
			[accountId, reason],
		);
		return changes > 0;
	}

	async resetSession(accountId: string, timestamp: number): Promise<void> {
		await this.run(
			`UPDATE accounts SET session_start = ?, session_request_count = 0 WHERE id = ?`,
			[timestamp, accountId],
		);
	}

	/**
	 * Expire the account's active-session anchor so the no-affinity
	 * `global_session` routing path stops re-sticking new requests to it.
	 *
	 * Distinct from `resetSession()`, which sets `session_start = now` and
	 * thus makes the account MORE sticky. Here we null `session_start` so the
	 * account is no longer a candidate for the active-session continue path.
	 * Returns the number of rows changed. Plain UPDATE — no schema change.
	 */
	async clearSessionAnchor(accountId: string): Promise<number> {
		return this.runWithChanges(
			`UPDATE accounts SET session_start = NULL, session_request_count = 0 WHERE id = ?`,
			[accountId],
		);
	}

	async updateRequestCount(accountId: string, count: number): Promise<void> {
		await this.run(
			`UPDATE accounts SET session_request_count = ? WHERE id = ?`,
			[count, accountId],
		);
	}

	async rename(accountId: string, newName: string): Promise<void> {
		await this.run(`UPDATE accounts SET name = ? WHERE id = ?`, [
			newName,
			accountId,
		]);
	}

	async updatePriority(accountId: string, priority: number): Promise<void> {
		await this.run(`UPDATE accounts SET priority = ? WHERE id = ?`, [
			priority,
			accountId,
		]);
	}

	async setAutoFallbackEnabled(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		await this.run(
			`UPDATE accounts SET auto_fallback_enabled = ? WHERE id = ?`,
			[enabled ? 1 : 0, accountId],
		);
	}

	async setAutoPauseOnOverageEnabled(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		await this.run(
			`UPDATE accounts SET auto_pause_on_overage_enabled = ? WHERE id = ?`,
			[enabled ? 1 : 0, accountId],
		);
	}

	async setBillingType(
		accountId: string,
		billingType: string | null,
	): Promise<void> {
		await this.run(`UPDATE accounts SET billing_type = ? WHERE id = ?`, [
			billingType,
			accountId,
		]);
	}

	async setNotes(accountId: string, notes: string | null): Promise<void> {
		await this.run(`UPDATE accounts SET notes = ? WHERE id = ?`, [
			notes,
			accountId,
		]);
	}

	async setRenewal(
		accountId: string,
		anchor: string | null,
		cadence: string | null,
		priceUsdMicros: number | null,
		autoStartDate: string | null,
	): Promise<void> {
		await this.run(
			`UPDATE accounts
			 SET renewal_anchor = ?, renewal_cadence = ?,
			     renewal_price_usd_micros = ?, renewal_auto_start_date = ?
			 WHERE id = ?`,
			[anchor, cadence, priceUsdMicros, autoStartDate, accountId],
		);
	}

	/**
	 * Per-account renewal config for the payments auto-recorder. An account is
	 * "active" for auto-recording when anchor is set, cadence is
	 * monthly/yearly, and price > 0 — the recorder filters; this returns all
	 * rows so it can also see why an account is skipped.
	 */
	async getRenewalConfigs(): Promise<
		Array<{
			id: string;
			name: string;
			renewal_anchor: string | null;
			renewal_cadence: string | null;
			renewal_price_usd_micros: number | null;
			renewal_auto_start_date: string | null;
			paused: number;
		}>
	> {
		return this.query(
			`
			SELECT id, name, renewal_anchor, renewal_cadence,
			       renewal_price_usd_micros, renewal_auto_start_date,
			       COALESCE(paused, 0) as paused
			FROM accounts
		`,
		);
	}

	/**
	 * Clear expired rate_limited_until values from all accounts
	 * @param now The current timestamp to compare against
	 * @returns Number of accounts that had their rate_limited_until cleared
	 */
	async clearExpiredRateLimits(now: number): Promise<number> {
		return this.runWithChanges(
			`UPDATE accounts SET rate_limited_until = NULL WHERE rate_limited_until <= ?`,
			[now],
		);
	}

	/**
	 * Check if there are any accounts for a specific provider
	 */
	async hasAccountsForProvider(provider: string): Promise<boolean> {
		const result = await this.get<{ count: number }>(
			`SELECT COUNT(*) as count FROM accounts WHERE provider = ?`,
			[provider],
		);
		return result ? result.count > 0 : false;
	}
}
