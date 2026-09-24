---
name: rate-limiting
description: Rate limiting, usage windows, cooldowns and recovery in ClankerMux. Read this before touching 429/529 handling, cooldowns, account selection or routing, usage polling, the usage cache, rate-limit display in the dashboard, or the accounts.rate_limit_* columns.
---

# Rate Limiting, Usage & Recovery

Most of what follows was expensive to derive — some of it from production log
forensics — and is not obvious from the code, which contains at least one comment
that is provably wrong (see `references/429-signals.md` § Disproven comments).

## The mental model in one paragraph

Anthropic reports account usage as a set of **windows** (5h, weekly, …) via a
state endpoint we **poll**. It separately rejects individual requests with 429s
carrying headers that describe *why*. When a 429 means the account itself is
spent, the proxy writes a **cooldown** (`rate_limited_until`) that removes the
account from routing until a deadline. Everything the dashboard shows is a
**projection** of that state — it never feeds routing. An account comes back
either when its cooldown expires, or when polling observes the quota recovered.

## The 429 decision ladder

`proxy-operations.ts`, in order:

```
reprobe (transient only; live quota/credit depletion falls through)
  → out_of_credits            (long floor, no burst-retry)
  → live account-wide claims (trusted 5h/7d rejection; own claim resets)
  → cached account-wide exhausted    (weekly OR 5h session spent; no burst-retry)
  → family-weekly safety net  (fails over WITHOUT an account-wide cooldown;
                               cache evidence first — with the cache UNAVAILABLE
                               it can read the 429's own scoped unified headers,
                               e.g. `7d_oi` rejected while 5h/7d show headroom)
  → transparent burst-retry   (classify429Transient → hold & re-probe)
  → residual 429 cooldown / account failover
  → response-processor generic path
```

Earlier rungs are more specific and win. **Order is load-bearing** — the
account-wide and family rungs sit before burst-retry precisely so a spent window
is never misread as a transient burst. Explicit trusted 5h/7d rejections outrank
a lagging usage cache and use the latest valid reset of the rejecting account-wide
claims, never the scoped summary retry-after. Invalid claim resets use adaptive
backoff (30s up to 5min) under the same quota reason, not a synthetic
server-directed deadline. Auto-refresh primes use the same live evidence while
keeping their request-history suppression; keepalive cooldown exemptions remain. Cache-only exhaustion retains its
existing `extractCooldownUntil` deadline. Residual 429 handling and generic response
processing use the same live-claim resolver; mixed rejection does not memoize a
model family from an ambiguous scoped claim.

Explicit model aliases can advance to their next configured target after the
current target exhausts its eligible accounts. That decision belongs to request
orchestration; `proxyWithAccount` sends one resolved model and does not cycle
legacy account-level model lists. Concrete model IDs retain strict selection.

`classify429Transient`:

1. non-OAuth-Anthropic → not retryable
2. account-wide hard status → not retryable *(dead in practice — see references)*
3. **fresh capacity, `minHeadroom > 0` → retryable** ← the real burst signal
4. stale/absent/zero headroom: a REJECTING status → not retryable; else
   `x-should-retry: true` → retryable

## Two views of the usage cache

Routing reads the poll reading with its 5h/7d windows updated from later
responses' `anthropic-ratelimit-unified-{5h,7d}-*` headers
(`getFreshRoutingUsage`/`getFreshRoutingCapacity`, `usage-header-view.ts`).
The family-weekly gate, the reactive family rung, predictions and every poll
side effect read the poll alone (`getFreshPollCapacity`), because they read the
poll's `limits[]` beside its account-wide windows and the two must come from
one reading. A new consumer picks one of the two on purpose.

- A header reading counts only with status `allowed`/`allowed_warning`,
  utilization in 0..1 and a reset after the response arrived; right after a 5h
  roll responses still report the OLD window, reset already passed.
- Same window (resets within 2 s): the HIGHER utilization wins. Headers
  saturate at 0.99 while the poll reads 100; taking the header would
  un-exhaust a spent window.
- Header readings are bound to the poller: the attempt captures
  `usageHeaderEpoch` before sending, and stop/restart/`delete`/
  `fenceAndRefetch` reissue it, so a response sent under old credentials never
  lands. An account-wide quota cooldown (`weekly_exhausted_429`,
  `session_exhausted_429`) reissues it too and re-arms the active poll, so the
  cooled 429's own headers never re-feed the view.
- The routing view is fresh only while `seven_day_oauth_apps` (finite) and
  enabled `extra_usage` (finite) are within the bound too; headers never carry
  them.

## What actually blocks routing

```ts
isAccountAvailable = !paused && (!rate_limited_until || rate_limited_until < now)
```

That is the whole routing contract. Independently, an account can still be
excluded per-request by: the family-weekly gate, the 529 provider-overload
breaker, context-window fit, and API-key account/class pinning.

## Background loops

| Loop | Cadence | Behaviour with a LOCKED account |
|---|---|---|
| Usage poller | 90s active / ~10min idle (demand-aware; an account whose own responses keep its header 5h/7d fresh polls at the idle cadence even when busy), held to the account's 150s read gap | **keeps polling** — the only observation channel |
| Auto-refresh scheduler | scheduled | **skips locked accounts** by SQL |
| Usage snapshots | 2 min | Limits-tab history |
| Integrity | quick 6h / full 24h | — |
| Codex spend coordinator | on traffic | Codex windows/credits |
| Anthropic banked-reset applier | 60s tick | claims only with a toggle on; replays pending claims |

## Invariants — do not break these

1. Representative utilization returns `null`, never `0`, on no evidence.
2. The presented status never influences routing.
3. `family_weekly_exhausted_429` must never apply an account-wide cooldown.
4. `out_of_credits` floors must expire or clear on a real successful request —
   never be wiped by polling.
5. A new `RateLimitReason` needs all three follow-through sites
   (`references/429-signals.md` § Cooldown reasons).
6. Per-IP burst cooldowns must never be released on account-quota evidence —
   they are unrelated limits, and clearing one re-storms it. This is why the
   capacity-restored clear is gated on `QUOTA_DERIVED_RATE_LIMIT_REASONS` and
   NOT on "anything except `out_of_credits`": `upstream_429_with_reset`, which a
   burst inherits, is excluded.
7. Status vocabulary lives ONCE in `packages/core/src/rate-limit-status.ts`.
   It was duplicated in four places, which is exactly why `rejected` — the value
   Anthropic actually sends — was recognized by none of them.
8. Soft demotions are applied as ONE partition over the union of all demotion
   reasons, never as sequential partitions (`references/routing-gates.md`).
9. Anything that bypasses the ordinary attempt loop must test POSITION against
   `routing.primaryAttemptAccountId`, not membership in the candidate list
   (`references/routing-gates.md`).
10. Never add a 5h term to HARVEST ranking — unused 5h capacity is not lost
    budget (`references/routing-gates.md` § The 5h window is nested).
11. After an Anthropic banked reset lands, recover through
    `usageCache.fenceAndRefetch` and the capacity-restored path, never
    `clearRateLimitState`/`forceResetAccountRateLimit`. Those NULL
    `rate_limit_reset`, and a NULL there permanently disqualifies a paused
    account from auto-unpause. `delete()` alone is not a fence either: an
    in-flight pre-claim poll re-stores the exhausted reading.
12. Every Anthropic `/api/oauth/usage` request counts against the account's
    read gap (`ANTHROPIC_USAGE_READ_MIN_GAP_MS`, `usage-read-budget.ts`).
    Anthropic rate-limits that endpoint per account: on 2026-09-23, once reads
    carried Claude Code's own headers, 5 reads in 10 min drew 429s on 8% of
    polls and 7 on 29%, against 1–2% at 3–4. A deferrable
    read takes a slot through `usageCache.tryAcquireAnthropicUsageRead`; a
    read that must not wait (the banked-reset status read) goes out and calls
    `noteAnthropicUsageRead`. A new caller of `fetchUsageData` that does
    neither brings the 429s back. The last read and reading are persisted
    (`anthropic_usage_reads`) and restored at boot, so a restart neither
    re-reads early nor starts routing cold.

## References

| File | Covers |
|---|---|
| `references/usage-windows.md` | The window taxonomy from `GET /oauth/usage`, representative utilization, NEAR_LIMIT recovery ordering |
| `references/429-signals.md` | What Anthropic actually sends on a 429 (measured over 1,145 production 429s), the cooldown-reason taxonomy, known dead code and disproven comments |
| `references/routing-gates.md` | Soft demotions, the pool-liveness reserve, position-vs-membership, display as a projection |
| `references/recovery.md` | How a locked account comes back; the capacity-restored path |
| `references/forecasting-verdicts.md` | Forecasting approaches that were measured and rejected, and why a backtest winner is not the shipped estimator |
