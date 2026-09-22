import { Logger } from "@clankermux/logger";

const log = new Logger("GrokSubscription");

/**
 * grok.com's own subscription list for the signed-in user. It accepts the
 * Grok CLI bearer without cookies, costs no quota and changes nothing
 * upstream; the plan name, status, period end and renewal intent all come
 * from here, since the CLI proxy reports none of them.
 */
export const GROK_SUBSCRIPTIONS_ENDPOINT =
	"https://grok.com/rest/subscriptions";

const REQUEST_TIMEOUT_MS = 5_000;

/** What the account row can store from one subscription record. */
export interface GrokSubscriptionSnapshot {
	/** Display name, e.g. "SuperGrok" or "SuperGrok Heavy". */
	planTier: string | null;
	/** Lowercased status without its enum prefix, e.g. "active", "canceled". */
	subscriptionStatus: string | null;
	startedAtMs: number | null;
	/** End of the current billing period, i.e. the next renewal. */
	endsAtMs: number | null;
	/** null when the record states no renewal intent. */
	willRenew: boolean | null;
	cadence: "monthly" | "yearly" | null;
}

/**
 * `none` is a reachable negative answer: the account holds no subscription
 * record at all. `failed` states nothing, so the caller keeps what it stored.
 */
export type GrokSubscriptionFetchOutcome =
	| { status: "ok"; subscription: GrokSubscriptionSnapshot }
	| { status: "none"; planTier: string | null }
	| { status: "failed" };

const FAILED = { status: "failed" } as const;

/** Statuses after which the subscription cannot renew on its own. */
const ENDED_STATUSES: ReadonlySet<string> = new Set([
	"canceled",
	"cancelled",
	"expired",
	"ended",
]);

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: null;
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function msFrom(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

/** `SUBSCRIPTION_STATUS_ACTIVE` → `active`. */
function normalizeStatus(value: unknown): string | null {
	return (
		nullableString(value)
			?.replace(/^SUBSCRIPTION_STATUS_/, "")
			.toLowerCase() ?? null
	);
}

function cadenceFrom(value: unknown): "monthly" | "yearly" | null {
	switch (nullableString(value)?.replace(/^BILLING_INTERVAL_/, "")) {
		case "MONTHLY":
			return "monthly";
		case "YEARLY":
		case "ANNUAL":
		case "ANNUALLY":
			return "yearly";
		default:
			return null;
	}
}

function snapshotFrom(
	record: UnknownRecord,
	planTier: string | null,
): GrokSubscriptionSnapshot {
	const stripe = asRecord(record.stripe);
	const subscriptionStatus = normalizeStatus(record.status);
	const cancelAtPeriodEnd =
		typeof record.cancelAtPeriodEnd === "boolean"
			? record.cancelAtPeriodEnd
			: typeof stripe?.cancelAtPeriodEnd === "boolean"
				? stripe.cancelAtPeriodEnd
				: null;
	return {
		planTier,
		subscriptionStatus,
		startedAtMs: msFrom(record.createTime),
		endsAtMs:
			msFrom(record.billingPeriodEnd) ?? msFrom(stripe?.currentPeriodEnd),
		willRenew:
			subscriptionStatus !== null && ENDED_STATUSES.has(subscriptionStatus)
				? false
				: cancelAtPeriodEnd === null
					? null
					: !cancelAtPeriodEnd,
		cadence: cadenceFrom(record.billingInterval),
	};
}

/**
 * Pure parser for a `/rest/subscriptions` body. Never throws.
 *
 * An account can carry several records (a lapsed one beside its replacement),
 * so the active one wins; otherwise the one whose period ends last, which is
 * the most recent state of the account.
 */
export function parseGrokSubscriptions(
	body: unknown,
): GrokSubscriptionFetchOutcome {
	const root = asRecord(body);
	if (!root || !Array.isArray(root.subscriptions)) return FAILED;

	const planTier = nullableString(
		asRecord(asRecord(root.dominantPlan)?.surfaceNames)?.SURFACE_DISPLAY,
	);
	if (root.subscriptions.length === 0) return { status: "none", planTier };

	const snapshots = root.subscriptions
		.map(asRecord)
		.filter((record): record is UnknownRecord => record !== null)
		.map((record) => snapshotFrom(record, planTier));
	if (snapshots.length === 0) return FAILED;

	const latestFirst = [...snapshots].sort(
		(a, b) => (b.endsAtMs ?? 0) - (a.endsAtMs ?? 0),
	);
	const chosen =
		latestFirst.find((s) => s.subscriptionStatus === "active") ??
		latestFirst[0];
	return { status: "ok", subscription: chosen };
}

/**
 * Read the account's subscription from grok.com. Never throws: every failure
 * degrades to `failed`, so a moved or stalled endpoint costs the account its
 * subscription details and nothing else.
 */
export async function fetchGrokSubscription(
	accessToken: string,
	options: { fetchImpl?: typeof fetch } = {},
): Promise<GrokSubscriptionFetchOutcome> {
	const token = accessToken?.trim();
	if (!token) return FAILED;
	try {
		const response = await (options.fetchImpl ?? fetch)(
			GROK_SUBSCRIPTIONS_ENDPOINT,
			{
				method: "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/json",
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			},
		);
		if (!response.ok) {
			log.warn(
				`Failed to fetch the Grok subscription: ${response.status} ${response.statusText}`,
			);
			void response.body?.cancel().catch(() => {});
			return FAILED;
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			log.warn("Grok subscription response was not JSON");
			return FAILED;
		}
		const outcome = parseGrokSubscriptions(body);
		if (outcome.status === "failed")
			log.warn("Grok subscription response carried no subscriptions list");
		return outcome;
	} catch (error) {
		log.warn(
			"Error fetching the Grok subscription:",
			error instanceof Error ? error.message : String(error),
		);
		return FAILED;
	}
}
