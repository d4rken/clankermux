import { getModelFamily, isAccountAvailable } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import { getFreshCapacity, usageCache } from "@clankermux/providers";
import type {
	Account,
	ComboFamily,
	ComboSlotInfo,
	RequestMeta,
} from "@clankermux/types";
import { isOfficialAnthropicProvider } from "../provider-overload-cooldown";
import type { ProxyContext } from "./proxy-types";

const log = new Logger("AccountSelector");

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
 * Anthropic only: it exposes a free usage endpoint. Codex usage refresh would
 * burn real quota (no free usage endpoint), and Zai/others have no windowed
 * capacity model used by the comparator here.
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
		// Anthropic only: it has a free usage endpoint. Codex usage refresh costs
		// real quota; Zai/others have no capacity model here.
		const anthropic = accounts.filter(
			(a) => a.provider === "anthropic" && isAccountAvailable(a, now),
		);
		if (anthropic.length === 0) return;
		const stale = anthropic.filter(
			(a) =>
				getFreshCapacity(usageCache, a.id, a.provider, now, maxAge) === null &&
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

// Module-level WeakMap to store combo slot info per RequestMeta
const comboSlotInfoMap = new WeakMap<RequestMeta, ComboSlotInfo>();

/** Store combo slot info on a RequestMeta for downstream consumption */
export function setComboSlotInfo(meta: RequestMeta, info: ComboSlotInfo): void {
	comboSlotInfoMap.set(meta, info);
}

/** Retrieve combo slot info from a RequestMeta (null if not combo-routed) */
export function getComboSlotInfo(meta: RequestMeta): ComboSlotInfo | null {
	return comboSlotInfoMap.get(meta) ?? null;
}

function getRoutingAffinity(meta: RequestMeta): {
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

/**
 * Gets accounts ordered by the load balancing strategy
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @returns Array of ordered accounts
 */
export async function getOrderedAccounts(
	meta: RequestMeta,
	ctx: ProxyContext,
): Promise<Account[]> {
	try {
		const allAccounts = await ctx.dbOps.getAllAccounts();
		// Warm unknown Anthropic usage so the FEFO comparator has real capacity
		// data on cold-start requests. Never stalls a request beyond a brief
		// soft wait, and only at a true cold start (see helper).
		await ensureUsageFreshForSelection(allAccounts, ctx, Date.now());
		// Return all accounts - the provider will be determined dynamically per account
		return ctx.strategy.select(allAccounts, meta);
	} catch (error) {
		log.error("Failed to get accounts from database:", error);
		console.error("\n❌ DATABASE ERROR DETECTED");
		console.error("═".repeat(50));
		console.error("The database encountered an error while loading accounts.");
		console.error(
			"This may indicate database corruption or integrity issues.\n",
		);
		console.error(
			"There is no built-in repair command. Inspect and repair the database manually with sqlite3, and review the server logs.\n",
		);
		console.error("The request will fall back to unauthenticated mode.");
		console.error(`${"═".repeat(50)}\n`);
		// Return empty array to gracefully handle database errors
		// This will cause the proxy to fall back to unauthenticated mode
		return [];
	}
}

/** Read the force-route header id (current + legacy name) from a request meta. */
function getHeaderForcedId(meta: RequestMeta): string | null {
	if (!meta.headers) return null;
	return (
		meta.headers.get("x-clankermux-account-id") ??
		meta.headers.get("x-better-ccflare-account-id")
	);
}

/**
 * Combo-aware + strategy selection tail. Shared by the normal no-pin path and
 * the class-pin path (which filters this ordered result to allowed providers).
 * When an active combo exists for the request's model family, returns
 * combo-ordered accounts filtered by availability. Falls back to normal
 * SessionStrategy when no combo is active or all slots are unavailable.
 */
async function selectByStrategy(
	meta: RequestMeta,
	ctx: ProxyContext,
	model?: string,
): Promise<Account[]> {
	// Try combo-aware routing if a model is provided
	if (model) {
		const family = getModelFamily(model);
		if (family) {
			const validFamilies: readonly string[] = [
				"opus",
				"sonnet",
				"haiku",
				"fable",
			];
			if (!validFamilies.includes(family)) {
				log.warn(`Unknown model family "${family}", skipping combo lookup`);
			} else {
				const combo = await ctx.dbOps.getActiveComboForFamily(
					family as ComboFamily,
				);
				if (combo) {
					log.info(
						`Combo routing active: ${combo.name} for family ${family} (${combo.slots.length} slots)`,
					);

					const allAccounts = await ctx.dbOps.getAllAccounts();
					const accountMap = new Map<string, Account>();
					for (const account of allAccounts) {
						accountMap.set(account.id, account);
					}

					const availableAccounts: Account[] = [];
					const slotEntries: Array<{
						accountId: string;
						modelOverride: string;
					}> = [];

					// Slots are already ordered by priority ASC from the repository
					for (const slot of combo.slots) {
						if (!slot.enabled) continue;

						const account = accountMap.get(slot.account_id);
						if (!account) {
							log.warn(
								`Combo slot references unknown account ${slot.account_id}`,
							);
							continue;
						}

						if (!isAccountAvailable(account)) {
							continue;
						}

						availableAccounts.push(account);
						slotEntries.push({
							accountId: slot.account_id,
							modelOverride: slot.model,
						});
					}

					if (availableAccounts.length > 0) {
						// Store combo slot info only when combo routing actually wins.
						// If all slots are unavailable, the normal strategy fallback must
						// not be mislabeled as combo-routed downstream.
						const slotInfo: ComboSlotInfo = {
							comboName: combo.name,
							slots: slotEntries,
						};
						setComboSlotInfo(meta, slotInfo);
						meta.comboName = combo.name;

						const affinity = getRoutingAffinity(meta);
						meta.routing = {
							strategy: "combo",
							decision: "combo",
							selectedAccountId: availableAccounts[0].id,
							candidatesCount: availableAccounts.length,
							affinityScope: affinity.scope,
							affinityKey: affinity.key,
							previousAccountId: null,
							failoverReason: null,
						};
						return availableAccounts;
					}

					// All slots unavailable — fall back to normal routing
					log.warn(
						`All ${combo.slots.length} combo slots unavailable for ${combo.name}, falling back to SessionStrategy`,
					);
				}
			}
		}
	}

	return getOrderedAccounts(meta, ctx);
}

/**
 * Enforce the per-key routing pin (Feature: API-key→account/class pin). A
 * pinned key must route ONLY to allowed accounts and never silently fall back
 * to a disallowed one. Precedence: header may narrow WITHIN the pin, but the
 * pin itself is hard.
 *
 * Allowed predicate: a specific `pin.accountId` matches by id; otherwise
 * `pin.providers` matches by provider class.
 *
 * On strict-fail this returns `[]` and sets `meta.pinFailure = { code, message }`
 * (it never throws) — handleProxy converts that into a terminal
 * pinned_target_unavailable error rather than degrading to pool_exhausted.
 *
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @param model - Optional model string for combo family detection (class pin)
 * @param pin - The resolved pin ({ accountId, providers }) — guaranteed active
 * @param headerForcedId - The force-route header id, if present
 * @returns Allowed accounts, or `[]` on strict-fail (with meta.pinFailure set)
 */
async function selectWithPin(
	meta: RequestMeta,
	ctx: ProxyContext,
	model: string | undefined,
	pin: { accountId: string | null; providers: string[] | null },
	headerForcedId: string | null,
): Promise<Account[]> {
	const affinity = getRoutingAffinity(meta);
	const isAllowed = (acc: Account): boolean =>
		pin.accountId
			? acc.id === pin.accountId
			: (pin.providers ?? []).includes(acc.provider);
	// Operator-readable description of what this key is pinned to.
	const pinDesc = pin.accountId
		? `account ${pin.accountId}`
		: `provider class [${(pin.providers ?? []).join(", ")}]`;

	const strictFail = (code: string, message: string): Account[] => {
		meta.routing = {
			strategy: "forced",
			decision: "pinned_rejected",
			selectedAccountId: null,
			candidatesCount: 0,
			affinityScope: affinity.scope,
			affinityKey: affinity.key,
			previousAccountId: null,
			failoverReason: null,
		};
		meta.pinFailure = { code, message };
		log.warn(`Pin strict-fail (${code}): ${message}`);
		return [];
	};

	let allAccounts: Account[];
	try {
		allAccounts = await ctx.dbOps.getAllAccounts();
	} catch (error) {
		log.error("Failed to load accounts for pin resolution:", error);
		return strictFail(
			"pinned_resolution_error",
			`Could not resolve the routing pin (${pinDesc}) due to a database error.`,
		);
	}

	// Header may narrow WITHIN the pin: honor it only when the target exists, is
	// allowed by the pin, AND is available. Otherwise strict-fail (never fall
	// back to a non-header account).
	if (headerForcedId) {
		const headerAccount = allAccounts.find((acc) => acc.id === headerForcedId);
		if (
			headerAccount &&
			isAllowed(headerAccount) &&
			isAccountAvailable(headerAccount)
		) {
			meta.routing = {
				strategy: "forced",
				decision: "pinned_header_narrowed",
				selectedAccountId: headerAccount.id,
				candidatesCount: 1,
				affinityScope: affinity.scope,
				affinityKey: affinity.key,
				previousAccountId: null,
				failoverReason: null,
			};
			return [headerAccount];
		}
		const reason = !headerAccount
			? "does not exist"
			: !isAllowed(headerAccount)
				? "is not allowed by the key pin"
				: "is currently unavailable";
		return strictFail(
			"pinned_header_rejected",
			`Forced account (${headerForcedId}) ${reason}; this key is pinned to ${pinDesc}.`,
		);
	}

	// Specific-account pin, no header.
	if (pin.accountId) {
		const target = allAccounts.find((acc) => acc.id === pin.accountId);
		if (!target) {
			return strictFail(
				"pinned_account_missing",
				`Pinned account (${pin.accountId}) no longer exists.`,
			);
		}
		if (!isAccountAvailable(target)) {
			return strictFail(
				"pinned_account_unavailable",
				`Pinned account (${pin.accountId}) is currently unavailable (paused or rate-limited).`,
			);
		}
		meta.routing = {
			strategy: "forced",
			decision: "pinned_account",
			selectedAccountId: target.id,
			candidatesCount: 1,
			affinityScope: affinity.scope,
			affinityKey: affinity.key,
			previousAccountId: null,
			failoverReason: null,
		};
		return [target];
	}

	// Class pin, no header: run normal combo+strategy selection, then filter the
	// ordered result to allowed providers.
	const ordered = await selectByStrategy(meta, ctx, model);
	const filtered = ordered.filter(isAllowed);
	if (filtered.length === 0) {
		return strictFail(
			"pinned_no_available_account",
			`No available account matches this key's pinned ${pinDesc}.`,
		);
	}
	// selectByStrategy set meta.routing for its head/count; narrow those two
	// fields to the filtered result while keeping its strategy/decision/affinity.
	// If the strategy left routing unset, synthesize it so the recorder and
	// decision-point logging reflect the pinned (narrowed) selection.
	if (meta.routing) {
		meta.routing.selectedAccountId = filtered[0].id;
		meta.routing.candidatesCount = filtered.length;
	} else {
		const affinity = getRoutingAffinity(meta);
		meta.routing = {
			strategy: "forced",
			decision: "pinned_class",
			selectedAccountId: filtered[0].id,
			candidatesCount: filtered.length,
			affinityScope: affinity.scope,
			affinityKey: affinity.key,
			previousAccountId: null,
			failoverReason: null,
		};
	}
	return filtered;
}

/**
 * Selects accounts for a request based on the load balancing strategy.
 *
 * Precedence: a per-key routing pin (Feature: API-key→account/class pin) is
 * enforced FIRST when active — a pinned key routes only to allowed accounts and
 * never silently falls back. Otherwise the legacy force-route header is honored,
 * then normal combo+strategy selection runs.
 *
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @param model - Optional model string for combo family detection
 * @returns Array of selected accounts
 */
/**
 * Public selection entry point. Runs normal selection, then applies the
 * codex-CLI "no official Anthropic account" floor (see `excludeOfficialAnthropic`)
 * as a final, cross-cutting filter that composes with the pin. Filtering the
 * RETURNED candidates (plus nulling `burstHeldId` in handleProxy) guarantees no
 * official Claude account is ever served for a floored request, regardless of
 * how it was selected.
 */
export async function selectAccountsForRequest(
	meta: RequestMeta,
	ctx: ProxyContext,
	model?: string,
): Promise<Account[]> {
	const selected = await selectCandidates(meta, ctx, model);

	if (meta.excludeOfficialAnthropic && selected.length > 0) {
		const filtered = selected.filter(
			(account) => !isOfficialAnthropicProvider(account.provider),
		);
		if (filtered.length === 0) {
			// Every candidate was an official Claude account. Fail closed rather
			// than route Codex CLI traffic to Claude (ban risk + wrong model).
			meta.pinFailure = {
				code: "anthropic_excluded_no_account",
				message:
					"Codex CLI traffic may not be routed to a Claude/Anthropic account, and no eligible account is available.",
			};
			return [];
		}
		// Keep routing telemetry consistent with the filtered head/count. The
		// count must be re-synced even when the head account is unchanged —
		// excluded official-Anthropic accounts may sit later in the list, so
		// `candidatesCount` would otherwise over-report the pre-filter size.
		if (meta.routing) {
			meta.routing.selectedAccountId = filtered[0].id;
			meta.routing.candidatesCount = filtered.length;
		}
		return filtered;
	}

	return selected;
}

async function selectCandidates(
	meta: RequestMeta,
	ctx: ProxyContext,
	model?: string,
): Promise<Account[]> {
	// A pin failure set before selection (e.g. the pin couldn't be resolved in
	// handleProxy) fails closed: return no candidates so handleProxy emits the
	// terminal pinned_target_unavailable error instead of selecting normally.
	if (meta.pinFailure) {
		return [];
	}

	const headerForcedId = getHeaderForcedId(meta);
	const pin = meta.pin ?? null;

	// A pin is active when it names a specific account OR a non-empty provider
	// allow-list. When active, enforce it strictly (header may narrow within).
	if (pin && (pin.accountId || (pin.providers && pin.providers.length > 0))) {
		return selectWithPin(meta, ctx, model, pin, headerForcedId);
	}

	// Check if a specific account is requested via special header.
	// Accept the legacy x-better-ccflare-account-id name too — this is the
	// hand-typed force-route testing header, so old scripts keep working.
	if (meta.headers) {
		const forcedAccountId = headerForcedId;
		if (forcedAccountId) {
			try {
				const allAccounts = await ctx.dbOps.getAllAccounts();
				const forcedAccount = allAccounts.find(
					(acc) => acc.id === forcedAccountId,
				);
				if (forcedAccount) {
					// The auto-refresh scheduler sends dummy messages with x-clankermux-bypass-session
					// to intentionally refresh accounts that are paused due to auto_pause_on_overage,
					// or to probe accounts that are rate-limited (to detect when the window has reset).
					// For those requests we must allow through an overage-paused or rate-limited account
					// so the scheduler can hit the real endpoint and trigger the window-reset + auto-resume logic.
					// Only an overage pause qualifies: a manual pause (pause_reason='manual') or a
					// failure-threshold / peak_hours pause must still win even when the overage feature
					// flag is enabled, because the auto-resume guard would never un-pause those accounts.
					// This mirrors the scheduler eligibility query and the sendDummyMessage resume guard
					// (auto_pause_on_overage_enabled=1 AND pause_reason IN (NULL,'overage')).
					const isAutoRefreshBypass =
						meta.internal === true &&
						meta.headers.get("x-clankermux-bypass-session") === "true";
					const available = isAccountAvailable(forcedAccount);
					const isOveragePaused =
						forcedAccount.paused &&
						forcedAccount.auto_pause_on_overage_enabled &&
						(!forcedAccount.pause_reason ||
							forcedAccount.pause_reason === "overage");
					const isRateLimited =
						!available &&
						!forcedAccount.paused &&
						!!forcedAccount.rate_limited_until;
					const allowThrough =
						available ||
						(isAutoRefreshBypass && (isOveragePaused || isRateLimited));
					if (allowThrough) {
						const affinity = getRoutingAffinity(meta);
						meta.routing = {
							strategy: "forced",
							decision: "forced_account",
							selectedAccountId: forcedAccount.id,
							candidatesCount: 1,
							affinityScope: affinity.scope,
							affinityKey: affinity.key,
							previousAccountId: null,
							failoverReason: null,
						};
						return [forcedAccount];
					}
				}
				// If forced account not found or unavailable (paused/rate-limited), fall back to normal selection
			} catch (error) {
				log.error(
					"Failed to get accounts from database for forced account lookup:",
					error,
				);
				console.error("\n❌ DATABASE ERROR DETECTED");
				console.error("═".repeat(50));
				console.error(
					"The database encountered an error while looking up the requested account.",
				);
				console.error(
					"This may indicate database corruption or integrity issues.\n",
				);
				console.error(
					"There is no built-in repair command. Inspect and repair the database manually with sqlite3, and review the server logs.\n",
				);
				console.error("Falling back to normal account selection.");
				console.error(`${"═".repeat(50)}\n`);
				// Fall through to normal selection
			}
		}
	}

	return selectByStrategy(meta, ctx, model);
}
