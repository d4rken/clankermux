import { createHash } from "node:crypto";
import { Logger } from "@clankermux/logger";
import type { GrokSubscriptionUsageData } from "@clankermux/types";
import {
	GROK_CHAT_PROXY_ENDPOINT,
	GROK_CLI_IDENTITY_HEADERS,
} from "./providers/grok-subscription/client-identity";
import { fetchGrokSubscriptionProfile } from "./providers/grok-subscription/identity";

const log = new Logger("GrokSubscriptionUsageFetcher");

export type { GrokSubscriptionUsageData } from "@clankermux/types";

/**
 * Where a paid Grok plan reports its weekly pool.
 *
 *   GET /v1/billing?format=credits
 *   Authorization: Bearer <access token>  + the Grok-CLI identity headers
 *
 * Chat, Imagine, Voice, Build and API all draw on that one pool, so there is a
 * single utilization here and no session window. The endpoint is undocumented
 * and costs no quota.
 */
export const GROK_SUBSCRIPTION_BILLING_ENDPOINT = `${GROK_CHAT_PROXY_ENDPOINT}/v1/billing?format=credits`;

/**
 * Hard bound on the usage read, matching every other fetcher in this package.
 * `usage-fetcher.ts` only clears an account's in-flight slot in
 * `promise.finally()`, so a hung request wedges that slot for the lifetime of
 * the process — and polling is the ONLY channel that observes a locked account
 * recovering.
 */
const USAGE_FETCH_TIMEOUT_MS = 5000;

/**
 * Separate, shorter bound on the `/v1/user` lookup that precedes the billing
 * read. It has its own budget so a stalled profile read never spends the
 * billing request's.
 */
const GROK_SUBSCRIPTION_PROFILE_TIMEOUT_MS = 3000;

/**
 * Ceiling on the billing body. Both halves are needed: `content-length` is a
 * claim the server makes and a chunked response does not make it at all, so the
 * reader enforces the same bound on what actually arrives.
 */
const MAX_BILLING_BODY_BYTES = 64 * 1024;

/** The only period type this parser knows how to read. */
const WEEKLY_PERIOD_TYPE = "USAGE_PERIOD_TYPE_WEEKLY";

/**
 * Outcome of one billing read.
 *
 * `unrecognized` is a THIRD state, distinct from data and failure: the endpoint
 * answered, in a shape this parser does not know. There is nothing to cache,
 * but nothing failed either — folding it into a failure would back the poller
 * off toward its 30-minute ceiling, spacing out the warning that names the
 * unknown shape and ageing the cache past its TTL. Mirrors
 * {@link import("./zai-usage-fetcher").ZaiUsageFetchOutcome}.
 */
export type GrokSubscriptionUsageFetchOutcome =
	| { status: "ok"; data: GrokSubscriptionUsageData }
	| { status: "unrecognized" }
	| { status: "failed" };

const FAILED = { status: "failed" } as const;
const UNRECOGNIZED = { status: "unrecognized" } as const;

/** Cents are wrapped rather than served bare: `{"onDemandCap":{"val":0}}`. */
interface GrokCentsValue {
	val?: unknown;
}

interface GrokBillingConfig {
	currentPeriod?: { type?: unknown; start?: unknown; end?: unknown } | null;
	creditUsagePercent?: unknown;
	onDemandCap?: GrokCentsValue | null;
	onDemandUsed?: GrokCentsValue | null;
	prepaidBalance?: GrokCentsValue | null;
	isUnifiedBillingUser?: unknown;
}

function centsFrom(wrapper: GrokCentsValue | null | undefined): number | null {
	const value = wrapper?.val;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** RFC3339 with microseconds, e.g. `2026-09-22T10:53:34.916969+00:00`. */
function msFrom(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Turn one billing body into an outcome. Exported for the parser's own tests;
 * the transport above has nothing to do with which of the three states applies.
 *
 * Never logs the body — it is account financial data — only the derived numbers
 * and a description of the shape.
 */
export function parseGrokSubscriptionBilling(
	body: unknown,
	now: number = Date.now(),
): GrokSubscriptionUsageFetchOutcome {
	if (!body || typeof body !== "object") {
		log.warn("Grok billing response was not a JSON object");
		return FAILED;
	}
	const rawConfig = (body as { config?: unknown }).config;
	if (!rawConfig || typeof rawConfig !== "object") {
		log.warn("Grok billing response carried no `config` object");
		return FAILED;
	}
	const config = rawConfig as GrokBillingConfig;

	const periodType =
		typeof config.currentPeriod?.type === "string"
			? config.currentPeriod.type
			: null;
	const resetAt = msFrom(config.currentPeriod?.end);
	const unifiedBilling = config.isUnifiedBillingUser === true;
	if (
		periodType !== WEEKLY_PERIOD_TYPE ||
		resetAt === null ||
		resetAt <= now ||
		!unifiedBilling
	) {
		log.warn(
			"Unrecognized Grok billing shape " +
				`(periodType=${periodType ?? "(absent)"}, ` +
				`periodEnd=${resetAt === null ? "(unreadable)" : resetAt <= now ? "past" : "future"}, ` +
				`unifiedBilling=${unifiedBilling}); keeping the previous reading`,
		);
		return UNRECOGNIZED;
	}

	// ABSENT is UNKNOWN, never 0. Proto3 omits zero-valued scalars, which is how
	// a real zero COULD vanish from this projection — but that does not
	// establish the endpoint ever populates the field for this billing mode, and
	// a fabricated 0% reads downstream as actionable headroom that could release
	// a cooldown on an account that is in fact exhausted.
	const percent = config.creditUsagePercent;
	let weeklyUtilization: number | null = null;
	if (percent !== undefined && percent !== null) {
		// Present but unusable is a different thing from absent: reporting no
		// reading at all beats clamping, which invents a number in the most
		// damaging direction available (a negative becomes 100% and benches a
		// healthy account; one above 100 becomes 0% and hides a spent one).
		if (
			typeof percent !== "number" ||
			!Number.isFinite(percent) ||
			percent < 0 ||
			percent > 100
		) {
			log.warn(
				`Grok billing reported an unusable creditUsagePercent (${typeof percent}, out of range or non-finite); reporting no reading`,
			);
			return FAILED;
		}
		weeklyUtilization = percent;
	}

	return {
		status: "ok",
		data: {
			kind: "grok-subscription",
			weeklyUtilization,
			weeklyResetAt: resetAt,
			weeklyPeriodStartAt: msFrom(config.currentPeriod?.start),
			onDemandCapCents: centsFrom(config.onDemandCap),
			onDemandUsedCents: centsFrom(config.onDemandUsed),
			prepaidBalanceCents: centsFrom(config.prepaidBalance),
		},
	};
}

/**
 * The name every surface gives this account's single window.
 *
 * `"weekly"` is deliberately a name other providers already use (Alibaba's
 * weekly, and the heading Anthropic's `seven_day` renders as), so a Grok
 * account's week lands in the same cross-account reset comparison and the same
 * window-duration lookup as everybody else's. A bespoke name would put it in a
 * category of one, which no comparison ever marks.
 */
export const GROK_SUBSCRIPTION_WINDOW = "weekly";

/**
 * Representative utilization percent (0-100), or null for UNKNOWN.
 *
 * One pool means no ranking to do: the weekly reading IS the representative
 * one. Null passes straight through — never folded to 0 — because the callers
 * of this (the load balancer's utilization read, the accounts page) treat a
 * number as measured headroom.
 */
export function getRepresentativeGrokSubscriptionUtilization(
	usage: GrokSubscriptionUsageData | null,
): number | null {
	return usage?.weeklyUtilization ?? null;
}

/**
 * Window label for the representative reading. Unlike the multi-window
 * providers' equivalents this does not depend on the percentage: the weekly
 * window exists (the reading always carries its reset) whether or not the
 * endpoint reported a utilization for it.
 */
export function getRepresentativeGrokSubscriptionWindow(
	usage: GrokSubscriptionUsageData | null,
): string | null {
	return usage ? GROK_SUBSCRIPTION_WINDOW : null;
}

/**
 * The `x-userid` the billing call carries, per account.
 *
 * Resolving it costs a `/v1/user` read, and the value only changes when the
 * credentials do — so it is memoised against a SHA-256 digest of the access
 * token that produced it (never the token itself) and re-resolved after a
 * rotation or a re-auth.
 */
const userIdByAccount = new Map<
	string,
	{ tokenDigest: string; userId: string }
>();

function digestToken(accessToken: string): string {
	return createHash("sha256").update(accessToken).digest("hex");
}

/**
 * Drop one account's memo entry, which nothing else ever expires, for account
 * removal; with no id, drop the whole memo (test seam, so a stubbed `/v1/user`
 * is actually dialled).
 */
export function clearGrokSubscriptionUserIdCache(accountId?: string): void {
	if (accountId === undefined) userIdByAccount.clear();
	else userIdByAccount.delete(accountId);
}

/** Test seam: the memo entry held for one account, if any. */
export function peekGrokSubscriptionUserIdMemo(
	accountId: string,
): { tokenDigest: string; userId: string } | undefined {
	const entry = userIdByAccount.get(accountId);
	return entry ? { ...entry } : undefined;
}

async function resolveUserId(
	accessToken: string,
	accountId: string | undefined,
	signal: AbortSignal,
): Promise<string | null> {
	const tokenDigest = digestToken(accessToken);
	const memo = accountId ? userIdByAccount.get(accountId) : undefined;
	if (memo && memo.tokenDigest === tokenDigest) return memo.userId;
	const profile = await fetchGrokSubscriptionProfile(accessToken, { signal });
	const userId = profile?.externalAccountId ?? null;
	if (userId && accountId) {
		userIdByAccount.set(accountId, { tokenDigest, userId });
	}
	return userId;
}

/**
 * Read at most {@link MAX_BILLING_BODY_BYTES} of the response, or null when it
 * is larger than that.
 */
async function readBoundedText(response: Response): Promise<string | null> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_BILLING_BODY_BYTES) {
		void response.body?.cancel().catch(() => {});
		return null;
	}
	const body = response.body;
	if (!body) return "";
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return text + decoder.decode();
			bytes += value.byteLength;
			if (bytes > MAX_BILLING_BODY_BYTES) return null;
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/**
 * Read the account's weekly pool from the Grok CLI chat proxy. Never throws:
 * every failure mode degrades to an outcome, so provider operation is
 * unaffected by a billing endpoint that moved, stalled or changed shape.
 */
export async function fetchGrokSubscriptionUsage(
	accessToken: string,
	options: { accountId?: string } = {},
): Promise<GrokSubscriptionUsageFetchOutcome> {
	const token = accessToken?.trim();
	if (!token) {
		log.warn("No Grok subscription access token available; skipping the read");
		return FAILED;
	}

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		// Sent to match the reference client. It was tested against the live
		// endpoint and changed nothing in the response, so an unavailable profile
		// must not cost the account its quota reading.
		const userId = await resolveUserId(
			token,
			options.accountId,
			AbortSignal.timeout(GROK_SUBSCRIPTION_PROFILE_TIMEOUT_MS),
		);
		// Armed only now, so the billing read gets its whole budget however long
		// the profile lookup took.
		const controller = new AbortController();
		timeoutId = setTimeout(() => controller.abort(), USAGE_FETCH_TIMEOUT_MS);
		const headers: Record<string, string> = {
			...GROK_CLI_IDENTITY_HEADERS,
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
		};
		if (userId) headers["x-userid"] = userId;

		const response = await fetch(GROK_SUBSCRIPTION_BILLING_ENDPOINT, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		if (!response.ok) {
			log.warn(
				`Failed to fetch Grok subscription usage: ${response.status} ${response.statusText}`,
			);
			void response.body?.cancel().catch(() => {});
			return FAILED;
		}

		const text = await readBoundedText(response);
		if (text === null) {
			log.warn(
				`Grok billing response exceeded ${MAX_BILLING_BODY_BYTES} bytes; discarding it`,
			);
			return FAILED;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			log.warn("Grok billing response was not JSON");
			return FAILED;
		}
		return parseGrokSubscriptionBilling(parsed);
	} catch (error) {
		// An abort lands here too, so a timeout degrades to the failure path
		// rather than propagating into the polling loop.
		log.warn(
			"Error fetching Grok subscription usage:",
			error instanceof Error ? error.message : String(error),
		);
		return FAILED;
	} finally {
		clearTimeout(timeoutId);
	}
}
