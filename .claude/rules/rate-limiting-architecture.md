# Rate Limiting, Usage & Recovery Architecture

## When this rule applies

Any work touching: 429/529 handling, cooldowns, account selection/routing,
usage polling, the usage cache, rate-limit display in the dashboard, or the
`accounts.rate_limit_*` columns.

Read this **before** changing any of it. Most of what follows was expensive to
derive (some of it from production log forensics) and is not obvious from the
code, which contains at least one comment that is provably wrong (§9).

## The mental model in one paragraph

Anthropic reports account usage as a set of **windows** (5h, weekly, …) via a
state endpoint we **poll**. It separately rejects individual requests with 429s
carrying headers that describe *why*. When a 429 means the account itself is
spent, the proxy writes a **cooldown** (`rate_limited_until`) that removes the
account from routing until a deadline. Everything the dashboard shows is a
**projection** of that state — it never feeds routing. An account comes back
either when its cooldown expires, or when polling observes the quota recovered.

---

## 1. Usage windows (`GET /oauth/usage`)

| Window | Meaning | Notes |
|---|---|---|
| `five_hour` | rolling 5h session | nullable: `null` = absent (Codex retired it), `{0,…}` = live at 0% |
| `seven_day` / `limits[weekly_all]` | **account-wide** weekly | the flat form wins when both exist |
| `seven_day_oauth_apps` | Claude Code's own weekly | NOT captured by the normalizer's `weeklyAll`; read separately |
| `limits[weekly_scoped]` | per model **family** | family gate + display only; never account-wide |
| `extra_usage` | overage / purchased credits | deliberately EXCLUDED from the account-wide figure |

**Representative utilization** = MAX across the account-wide windows.

> **Returns `null`, never `0`, when there is no evidence.** A `limits[]`-only
> payload once collapsed to `0` — read as "plenty of headroom" — and falsely
> cleared a cooldown. Any new consumer must preserve `null`-means-unknown.

## 2. What Anthropic actually sends on a 429

Measured over **1,145 real 429s** from the production journal (2026-05→07):

| Signal | Transient per-IP burst | Real account limit |
|---|---|---|
| `anthropic-ratelimit-unified-status` | **absent** (973×) | `rejected` (172×) |
| `anthropic-ratelimit-unified-reset` | absent | present |
| `x-should-retry` | `true` | `true` |

- **`rate_limited` never appeared. Not once.** Neither did `blocked`,
  `queueing_hard`, or `payment_required`.
- The real discriminator is **header presence + reset presence**, not the status
  *value* the code was originally written around.
- `anthropic-ratelimit-unified-overage-disabled-reason: out_of_credits` marks
  credit depletion (a billing state, not a quota one).

Evidence source: `[ProxyOperations] Account X received 429 — headers: {...}`
(DEBUG level — it disappears if the debug.conf drop-in is retired).

## 3. Cooldown reasons (`RateLimitReason`)

| Reason | Written when | Quota-derived? |
|---|---|---|
| `weekly_exhausted_429` | 429 + account-wide weekly ≥100% on fresh usage | **yes, by construction** |
| `upstream_429_with_reset` | default whenever *any* `resetTime` exists | **NO** — see the trap below |
| `model_fallback_429` | burst intercept **and** the no-fallback path | ambiguous |
| `all_models_exhausted_429` | every fallback model 429'd | ambiguous |
| `upstream_429_no_reset_probe_cooldown` | 429 with no reset | no |
| `upstream_429_no_reset_default_5h` | legacy (ccflare ≤3.5.x), never emitted now | — |
| `upstream_529_overloaded_with_reset` / `_no_reset` | provider overload | no |
| `out_of_credits` | overage header; long floor, bypasses backoff cap | billing |
| `family_weekly_exhausted_429` | one family spent, account keeps headroom | **applies NO account-wide cooldown** |

> **TRAP: `upstream_429_with_reset` does NOT mean the provider directed a reset.**
> `parseRateLimit` synthesizes `now + 60s` for a bare 429 with no reset header
> (pinned by `streaming.test.ts:202`), and `applyRateLimitCooldown` defaults to
> this reason whenever a `resetTime` is present. A transient burst therefore
> inherits it. Never treat it as quota provenance.

**Adding a reason requires three follow-through sites** or it silently breaks:
1. the `RATE_LIMIT_REASONS` runtime tuple the union derives from,
2. `errorCodeMeta.ts` (exhaustive `Record` — typecheck blocker),
3. a `/api/accounts` round-trip test.
A hand-maintained allowlist previously drifted from the union and silently
nulled `family_weekly_exhausted_429` in the API for months.

## 4. The 429 decision ladder (`proxy-operations.ts`, in order)

```
reprobe
  → out_of_credits            (long floor, no burst-retry)
  → weekly-exhausted          (account-wide weekly spent; no burst-retry)
  → family-weekly safety net  (fails over WITHOUT an account-wide cooldown)
  → transparent burst-retry   (classify429Transient → hold & re-probe)
  → model fallback / no-fallback / all-models-exhausted
  → response-processor generic path
```

Earlier rungs are more specific and win. **Order is load-bearing** — the
weekly and family rungs sit before burst-retry precisely so a spent window is
never misread as a transient burst.

`classify429Transient`:
1. non-OAuth-Anthropic → not retryable
2. account-wide hard status → not retryable *(dead in practice — see §9)*
3. **fresh capacity, `minHeadroom > 0` → retryable** ← the real burst signal
4. stale/absent/zero headroom: a REJECTING status → not retryable; else
   `x-should-retry: true` → retryable

## 5. Background loops

| Loop | Cadence | Behaviour with a LOCKED account |
|---|---|---|
| Usage poller | 90s active / ~10min idle (demand-aware) | **keeps polling** — the only observation channel |
| Auto-refresh scheduler | scheduled | **skips locked accounts** by SQL |
| Usage snapshots | 2 min | Limits-tab history |
| Integrity | quick 6h / full 24h | — |
| Codex spend coordinator | on traffic | Codex windows/credits |

## 6. What actually blocks routing

```ts
isAccountAvailable = !paused && (!rate_limited_until || rate_limited_until < now)
```

That is the whole routing contract. Independently, an account can still be
excluded per-request by: the family-weekly gate, the 529 provider-overload
breaker, context-window fit, and API-key account/class pinning.

## 7. Display is a projection — the cause-before-mechanism law

The presented `rateLimitStatus` / `rateLimitCause` **never** feeds routing.

> **Report the CAUSE, not the MECHANISM.** A cooldown existing is a mechanism;
> the spent weekly window is the cause. Reporting the mechanism made three
> identically-exhausted accounts display differently depending on whether a
> cooldown happened to still be ticking.

Precedence: administrative/billing blocks (`payment_required`, `blocked`,
`out_of_credits`) → weekly exhaustion → generic throttles (`rate_limited`,
`queueing_hard`, `rejected`) → OK. An unrecognized provider status maps to cause
`unknown`, which is in neither the "not limited" nor the "hard" set, so it keeps
its warning without being treated as blocking.

## 8. How an account comes back

| Path | Trigger | Works today? |
|---|---|---|
| Natural expiry | `rate_limited_until < now` | yes |
| Successful response | a 200 clears the lock | yes, but unreachable while locked (router skips it) |
| Auto-refresh success | token refresh clears the lock | no — the scheduler skips locked accounts |
| **Capacity restored** | polling observes the quota recovered | **NO — dead code (§9)** |

**There is no reset notification.** Early recovery can only ever be detected by
observing the polled number drop — which is why the poller keeps running against
locked accounts.

## 9. Known dead code and disproven comments

- **`isAnthropicHardLimitStatus` has never returned `true` in production**
  (0/1145). Its two consumers — the family-weekly guard precondition and
  `classify429Transient` step 2 — are effectively no-ops.
- **`clearRateLimitOnCapacityRestored` has never fired** — 0 `Cleared stale
  rate_limited_until` AND 0 `Skipping capacity-restored clear` in two months.
  The second zero proves the callback is never invoked: it is gated on
  `usageRateLimitedUntil`, which tracks 429s on the **usage endpoint itself**,
  not the account's cooldown.
- **`providers/anthropic/provider.ts:25-28` is WRONG.** It claims "429s do NOT
  carry this header value; a `rate_limited` unified-status means the account
  itself is rate limited". Reality: hard 429s carry `rejected` **with** a reset,
  bursts carry neither, and `rate_limited` never appears. This false model is the
  origin of a whole bug class.
- `usageCache.getRateLimitedUntil` is named for a quota window but tracks the
  **usage API's own** 429 throttle. `out_of_credits` consumes it as a quota reset.

## 10. Invariants — do not break these

1. Representative utilization returns `null`, never `0`, on no evidence.
2. The presented status never influences routing.
3. `family_weekly_exhausted_429` must never apply an account-wide cooldown.
4. `out_of_credits` floors must expire or clear on a real successful request —
   never be wiped by polling.
5. A new `RateLimitReason` needs all three follow-through sites (§3).
6. Per-IP burst cooldowns must never be released on account-quota evidence —
   they are unrelated limits, and clearing one re-storms it.
7. Status vocabulary lives ONCE in `packages/core/src/rate-limit-status.ts`.
   It was duplicated in four places, which is exactly why `rejected` — the value
   Anthropic actually sends — was recognized by none of them.

## Related

- `CLAUDE.md` — repo rules, DB migration rules, testing restrictions
- `.claude/rules/main-checkout-safety.md`, `.claude/rules/fork-workflow.md`
