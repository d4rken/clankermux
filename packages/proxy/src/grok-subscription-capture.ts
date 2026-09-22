import type { DatabaseOperations } from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import { fetchGrokSubscription } from "@clankermux/providers/grok-subscription";

const log = new Logger("GrokSubscriptionCapture");

/**
 * How often one grok-subscription account's subscription is re-read. A plan,
 * renewal date or cancellation changes a few times a year at most, so this
 * matches the Codex subscription check rather than the usage poll.
 */
export const GROK_SUBSCRIPTION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type GrokSubscriptionCaptureOps = Pick<
	DatabaseOperations,
	| "setAccountIdentityFromProfile"
	| "setAccountSubscriptionState"
	| "touchAccountSubscriptionCheck"
	| "syncProviderRenewalAnchor"
>;

export interface GrokSubscriptionCaptureDeps {
	fetchSubscription?: typeof fetchGrokSubscription;
	now?: () => number;
}

/**
 * Read the account's subscription from grok.com and store it in the same
 * identity and subscription columns the Anthropic and Codex captures fill.
 *
 * Every attempt stamps `identity_subscription_checked_at`, which is the
 * caller's throttle. A failed read only advances that stamp: it states nothing
 * about the period, and writing an empty one would erase what an earlier read
 * observed.
 *
 * Never throws: this is display metadata, and no failure here may reach the
 * scheduler tick that also refreshes tokens.
 */
export async function captureGrokSubscription(
	dbOps: GrokSubscriptionCaptureOps,
	account: { id: string; name: string },
	accessToken: string,
	deps: GrokSubscriptionCaptureDeps = {},
): Promise<void> {
	const now = (deps.now ?? Date.now)();
	try {
		const outcome = await (deps.fetchSubscription ?? fetchGrokSubscription)(
			accessToken,
		);
		if (outcome.status === "failed") {
			await dbOps.touchAccountSubscriptionCheck(account.id, now);
			return;
		}

		const subscription = outcome.status === "ok" ? outcome.subscription : null;
		const planTier =
			outcome.status === "ok"
				? outcome.subscription.planTier
				: outcome.planTier;
		const written = await dbOps.setAccountIdentityFromProfile(
			account.id,
			{
				externalAccountId: null,
				email: null,
				organizationName: null,
				planTier,
				rateLimitTier: null,
				// "none" rather than null: the identity merge keeps a stored status
				// when handed null, which would leave a lapsed account reading active.
				subscriptionStatus: subscription?.subscriptionStatus ?? "none",
				subscriptionStartedAt: subscription?.startedAtMs ?? null,
			},
			accessToken,
		);
		// The token was replaced while the read was in flight, so the answer may
		// describe other credentials. The unstamped throttle retries next tick.
		if (!written) return;

		await dbOps.setAccountSubscriptionState(account.id, {
			endsAtMs: subscription?.endsAtMs ?? null,
			willRenew: subscription?.willRenew ?? null,
			graceEndsAtMs: null,
			checkedAtMs: now,
		});
		if (subscription) {
			await dbOps.syncProviderRenewalAnchor(account.id, {
				endsAtMs: subscription.endsAtMs,
				cadence: subscription.cadence,
				graceEndsAtMs: null,
			});
		}
	} catch (error) {
		log.warn(
			`Could not capture the subscription for '${account.name}':`,
			error instanceof Error ? error.message : String(error),
		);
	}
}
