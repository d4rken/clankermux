import { isAccountAvailable, isPinActive } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import { getFreshRoutingCapacity, usageCache } from "@clankermux/providers";
import {
	type Account,
	getSdkBridgeInnerMetaContext,
	type RequestMeta,
} from "@clankermux/types";
import { getResolvedRoute, RoutingPolicyError } from "../resolved-route";
import { eligibleRouteAccounts } from "../routing-service";
import type { ProxyContext } from "./proxy-types";

const _log = new Logger("AccountSelector");

// On-demand cold-start usage refresh tuning.
const COLD_START_SOFT_WAIT_MS = 300;
const COLD_REFRESH_COOLDOWN_MS = 30_000;
const lastColdRefreshAttempt = new Map<string, number>();

/** Test hook: reset the on-demand refresh cooldown state. */
export function __resetColdRefreshState(): void {
	lastColdRefreshAttempt.clear();
}

/**
 * Refresh unknown Anthropic usage before a selection so the FEFO capacity
 * comparator has real data on the first request(s) after a cold start —
 * WITHOUT ever stalling a request.
 *
 * Anthropic only: this warmer drives the Anthropic `/oauth/usage` poller via
 * `usageCache.refreshNow`. Codex is excluded here because it is NOT wired into
 * that poller — its free `GET /wham/usage` read (`fetchCodexUsageStatus`) is
 * driven by the manual refresh / spend coordinator, not this selection-time
 * warmer — and Zai/others have no windowed capacity model used by the comparator
 * here.
 *
 * Only blocks briefly (≤300ms) at a true cold start — when every account in the
 * top available priority tier is unknown. Otherwise the refresh runs in the
 * background and warms the cache for the next request.
 */
export async function ensureUsageFreshForSelection(
	accounts: Account[],
	ctx: ProxyContext,
	now: number,
): Promise<void> {
	try {
		const maxAge = ctx.config.getUsagePollIntervalMs() * 2;
		// Anthropic only: this warmer uses the Anthropic `/oauth/usage` poller
		// (`refreshNow`). Codex is not wired into that poller here (it has its own
		// free read elsewhere); Zai/others have no capacity model here.
		const anthropic = accounts.filter(
			(a) => a.provider === "anthropic" && isAccountAvailable(a, now),
		);
		if (anthropic.length === 0) return;
		const stale = anthropic.filter(
			(a) =>
				getFreshRoutingCapacity(usageCache, a.id, a.provider, now, maxAge) ===
					null &&
				(usageCache.getRateLimitedUntil(a.id) ?? 0) <= now &&
				now - (lastColdRefreshAttempt.get(a.id) ?? 0) >
					COLD_REFRESH_COOLDOWN_MS,
		);
		if (stale.length === 0) return;
		for (const a of stale) lastColdRefreshAttempt.set(a.id, now);
		const fetches = stale.map((a) =>
			usageCache.refreshNow(a.id).catch(() => false),
		);
		// Only block (briefly) at a true cold start: every account in the top
		// available priority tier is unknown. Otherwise refresh in the background
		// and let the result warm the cache for the next request.
		const top = Math.min(...anthropic.map((a) => a.priority));
		const topTier = anthropic.filter((a) => a.priority === top);
		const staleIds = new Set(stale.map((a) => a.id));
		if (topTier.length > 0 && topTier.every((a) => staleIds.has(a.id))) {
			await Promise.race([
				Promise.allSettled(fetches),
				new Promise<void>((resolve) =>
					setTimeout(resolve, COLD_START_SOFT_WAIT_MS),
				),
			]);
		}
	} catch {
		// Never let usage refresh failures break account selection.
	}
}

/** The request's conversation key, the same composite the session strategy uses. */
export function getRoutingAffinity(meta: RequestMeta): {
	key: string | null;
	scope: RequestMeta["affinityScope"] | null;
} {
	const partition = meta.affinityPartition?.trim();
	const prefix = partition ? `partition:${partition}:` : "";
	if (meta.affinityKey?.trim() && meta.affinityScope) {
		return {
			key: `${prefix}${meta.affinityScope}:${meta.affinityKey.trim()}`,
			scope: meta.affinityScope,
		};
	}
	if (meta.project?.trim()) {
		return { key: `${prefix}project:${meta.project.trim()}`, scope: "project" };
	}
	return { key: null, scope: null };
}

/** Eligible account/target pairs are resolved before strategy side effects. */
export async function getOrderedAccounts(
	meta: RequestMeta,
	ctx: ProxyContext,
): Promise<Account[]> {
	const accounts = await eligibleRouteAccounts(meta, ctx);
	if (!accounts.length)
		throw new RoutingPolicyError(
			"No account retains permission for this request's resolved model",
		);
	await ensureUsageFreshForSelection(accounts, ctx, Date.now());
	// Stamped per selection because an alias stage installs a different route.
	// The model we send, not the one upstream reports: a relabelled response is
	// still cached under the model it was asked for.
	meta.affinityModel =
		getResolvedRoute(meta).upstreamModel?.trim().toLowerCase() || null;
	const selected = await ctx.strategy.select(accounts, meta);
	const allowed = new Set(accounts.map((a) => a.id));
	const ordered = selected.filter(
		(a) => allowed.has(a.id) && getResolvedRoute(meta).target(a) !== null,
	);
	const inner = getSdkBridgeInnerMetaContext(meta);
	return inner
		? preferPlannedAccount(ordered, meta, ctx, inner.plan.preferredAccountId)
		: ordered;
}

/** Decisions that mean the conversation already has an account of its own. */
const ESTABLISHED_AFFINITY = new Set(["affinity_hit", "affinity_hold"]);

/**
 * Start a bridge turn's inner calls on the account the outer attempt chose.
 *
 * Only a conversation without an account of its own moves: an established
 * Claude Code session pin keeps its account, because its prompt cache is
 * there. The pin follows the move, so the session's next inner call is an
 * ordinary affinity hit on the preferred account.
 */
function preferPlannedAccount(
	ordered: Account[],
	meta: RequestMeta,
	ctx: ProxyContext,
	preferredAccountId: string,
): Account[] {
	const index = ordered.findIndex((a) => a.id === preferredAccountId);
	if (index <= 0 || ESTABLISHED_AFFINITY.has(meta.routing?.decision ?? ""))
		return ordered;
	const preferred = ordered[index];
	ctx.strategy.reassignAffinity?.(meta, preferred);
	if (meta.routing) {
		meta.routing.decision = "sdk_bridge_preferred";
		meta.routing.selectedAccountId = preferred.id;
	}
	return [preferred, ...ordered.filter((a) => a.id !== preferred.id)];
}
export async function selectAccountsForRequest(
	meta: RequestMeta,
	ctx: ProxyContext,
	_model?: string,
): Promise<Account[]> {
	const route = getResolvedRoute(meta);
	// A bridge inner call's destinations are the frozen plan's; a header from
	// Claude Code cannot narrow them to one account.
	const singleton =
		meta.pin?.accountId ||
		(getSdkBridgeInnerMetaContext(meta)
			? null
			: meta.headers?.get("x-clankermux-account-id"));
	meta.pinFailure = null;
	if (!singleton) {
		const selected = await getOrderedAccounts(meta, ctx);
		if (!selected.length && isPinActive(meta.pin))
			meta.pinFailure = {
				code: "pinned_no_available_account",
				message: "No allowed destination is currently available",
			};
		return selected;
	}
	const accounts = await eligibleRouteAccounts(meta, ctx);
	const account = accounts.find((a) => a.id === singleton);
	if (!account)
		throw new RoutingPolicyError(
			"The requested destination no longer permits this request",
		);
	const bypass =
		route.maintenance?.purpose === "auto_refresh" &&
		meta.headers?.get("x-clankermux-bypass-session") === "true";
	const overage =
		account.paused &&
		account.auto_pause_on_overage_enabled &&
		(!account.pause_reason || account.pause_reason === "overage");
	if (
		!isAccountAvailable(account) &&
		!(bypass && (overage || (!account.paused && !!account.rate_limited_until)))
	) {
		meta.pinFailure = {
			code: "pinned_account_unavailable",
			message: "The selected destination is currently unavailable",
		};
		return [];
	}
	const affinity = getRoutingAffinity(meta);
	meta.routing = {
		strategy: "forced",
		decision: "resolved_destination",
		selectedAccountId: account.id,
		candidatesCount: 1,
		affinityScope: affinity.scope,
		affinityKey: affinity.key,
		previousAccountId: null,
		failoverReason: null,
	};
	return [account];
}
