import { intervalManager } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type { Account } from "@clankermux/types";
import {
	ANTHROPIC_SUBSCRIPTION_DIAGNOSIS_RETRY_MS,
	type AnthropicSubscriptionRefreshDeps,
	anthropicSubscriptionDiagnosisThrottleMs,
	isAnthropicSubscriptionRefreshDue,
	refreshAnthropicSubscription,
} from "./anthropic-subscription-refresh";

export const ANTHROPIC_SUBSCRIPTION_DIAGNOSIS_INTERVAL_MS = 60_000;
const FIRST_RUN_DELAY_MS = 30_000;
const INTERVAL_ID = "anthropic-subscription-diagnosis";

export interface AnthropicSubscriptionDiagnosisDeps
	extends AnthropicSubscriptionRefreshDeps {
	getAccounts: () => Promise<Account[]>;
	getAccessToken: (account: Account) => Promise<string>;
}

function needsDiagnosis(account: Account): boolean {
	return (
		account.provider === "anthropic" &&
		Boolean(account.refresh_token) &&
		account.paused &&
		account.pause_reason === "usage_permission_denied"
	);
}

/** Profile diagnosis must keep running while usage requests are backed off. */
export class AnthropicSubscriptionDiagnosis {
	private stopInterval: (() => void) | null = null;
	private firstRunTimer: ReturnType<typeof setTimeout> | null = null;
	private generation = 0;
	private active = false;
	private running = false;
	private readonly log: Logger;
	private readonly tokenRetries = new Map<
		string,
		{
			accessToken: Account["access_token"];
			refreshToken: Account["refresh_token"];
			nextAttempt: number;
		}
	>();

	constructor(private readonly deps: AnthropicSubscriptionDiagnosisDeps) {
		this.log = deps.logger ?? new Logger("AnthropicSubscriptionDiagnosis");
	}

	start(): void {
		if (this.active) return;
		this.active = true;
		this.generation++;
		this.stopInterval = intervalManager.register({
			id: INTERVAL_ID,
			callback: () => this.tick(),
			intervalMs: ANTHROPIC_SUBSCRIPTION_DIAGNOSIS_INTERVAL_MS,
			immediate: false,
			maxConcurrent: 1,
			description: "Diagnose denied Anthropic subscription access",
		});
		this.firstRunTimer = setTimeout(() => {
			this.firstRunTimer = null;
			void this.tick();
		}, FIRST_RUN_DELAY_MS);
		this.firstRunTimer.unref?.();
	}

	stop(): void {
		this.active = false;
		this.generation++;
		this.tokenRetries.clear();
		this.stopInterval?.();
		this.stopInterval = null;
		if (this.firstRunTimer) clearTimeout(this.firstRunTimer);
		this.firstRunTimer = null;
	}

	async tick(): Promise<void> {
		if (!this.active || this.running) return;
		this.running = true;
		const generation = this.generation;
		const isCurrent = () => this.active && this.generation === generation;
		const now = this.deps.now ?? Date.now;
		const tokenRetryDue = (account: Account) => {
			const retry = this.tokenRetries.get(account.id);
			return (
				!retry ||
				retry.accessToken !== account.access_token ||
				retry.refreshToken !== account.refresh_token ||
				now() >= retry.nextAttempt
			);
		};
		const due = (account: Account) =>
			needsDiagnosis(account) &&
			tokenRetryDue(account) &&
			isAnthropicSubscriptionRefreshDue(
				account,
				now(),
				anthropicSubscriptionDiagnosisThrottleMs(account),
			);
		try {
			if (this.deps.canFetchProfile?.() === false) return;
			const accounts = await this.deps.getAccounts();
			if (!isCurrent()) return;
			const currentAccounts = new Map(
				accounts.map((account) => [account.id, account]),
			);
			for (const [accountId, retry] of this.tokenRetries) {
				const account = currentAccounts.get(accountId);
				if (
					!account ||
					!needsDiagnosis(account) ||
					retry.accessToken !== account.access_token ||
					retry.refreshToken !== account.refresh_token
				)
					this.tokenRetries.delete(accountId);
			}
			for (const account of accounts) {
				if (!isCurrent()) break;
				if (!due(account) || this.deps.canFetchProfile?.() === false) continue;
				try {
					const current = await this.deps.getAccount(account.id);
					if (
						!current ||
						!isCurrent() ||
						!due(current) ||
						this.deps.canFetchProfile?.() === false
					)
						continue;
					this.tokenRetries.set(account.id, {
						accessToken: current.access_token,
						refreshToken: current.refresh_token,
						nextAttempt: now() + ANTHROPIC_SUBSCRIPTION_DIAGNOSIS_RETRY_MS,
					});
					const token = await this.deps.getAccessToken(current);
					if (!token || !isCurrent()) continue;
					this.tokenRetries.delete(account.id);
					await refreshAnthropicSubscription(
						account.id,
						token,
						{
							...this.deps,
							getAccount: async (accountId) => {
								const row = await this.deps.getAccount(accountId);
								return row && needsDiagnosis(row) ? row : null;
							},
						},
						{
							throttleMs: anthropicSubscriptionDiagnosisThrottleMs(current),
							isCurrent,
						},
					);
				} catch (err) {
					this.log.warn(
						`Subscription diagnosis failed for account ${account.id}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		} catch (err) {
			this.log.warn(
				`Subscription diagnosis failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			this.running = false;
		}
	}
}
