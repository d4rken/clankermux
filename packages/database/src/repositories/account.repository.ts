import {
	type Account,
	type AccountRow,
	type RateLimitReason,
	toAccount,
} from "@clankermux/types";
import { BaseRepository } from "./base.repository";

export class AccountRepository extends BaseRepository<Account> {
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
				custom_endpoint,
				model_mappings,
				model_fallbacks,
				billing_type,
				pause_reason,
				notes,
				refresh_token_issued_at,
				renewal_anchor,
				renewal_cadence,
				renewal_price_usd_micros,
				renewal_auto_start_date,
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
				custom_endpoint,
				model_mappings,
				model_fallbacks,
				billing_type,
				pause_reason,
				notes,
				refresh_token_issued_at,
				renewal_anchor,
				renewal_cadence,
				renewal_price_usd_micros,
				renewal_auto_start_date,
				COALESCE(consecutive_rate_limits, 0) as consecutive_rate_limits
			FROM accounts
			WHERE id = ?
		`,
			[accountId],
		);

		return row ? toAccount(row) : null;
	}

	async updateTokens(
		accountId: string,
		accessToken: string,
		expiresAt: number,
		refreshToken?: string,
	): Promise<void> {
		const now = Date.now();
		if (refreshToken) {
			await this.run(
				`UPDATE accounts SET access_token = ?, expires_at = ?, refresh_token = ?, refresh_token_issued_at = ? WHERE id = ?`,
				[accessToken, expiresAt, refreshToken, now, accountId],
			);
		} else {
			await this.run(
				`UPDATE accounts SET access_token = ?, expires_at = ? WHERE id = ?`,
				[accessToken, expiresAt, accountId],
			);
		}
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

	async resetConsecutiveRateLimits(accountId: string): Promise<void> {
		await this.run(
			`UPDATE accounts SET consecutive_rate_limits = 0, rate_limited_at = NULL WHERE id = ?`,
			[accountId],
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
