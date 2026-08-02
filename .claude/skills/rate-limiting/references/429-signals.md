# What a 429 actually means

## Measured signals

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
- Real-limit 429s enumerate PER-CLAIM lines
  (`anthropic-ratelimit-unified-<claim>-status/utilization/reset`). Observed
  claims: `5h`, `7d` (account-wide), `7d_oi` (scoped —
  `seven_day_overage_included`, the shape both 2026-08-02 fable incidents
  carried: `7d_oi` rejected at 1.0 with 5h/7d headroom), plus a non-window
  `overage` axis. The family rung's header-evidence fallback keys on the
  `(5h|7d)_*` scoped-token shape and runs only when the usage cache is
  unavailable.
- `anthropic-ratelimit-unified-overage-disabled-reason: out_of_credits` marks
  credit depletion (a billing state, not a quota one).

Evidence source: `[ProxyOperations] Account X received 429 — headers: {...}`
(DEBUG level — it disappears if the debug.conf drop-in is retired).

## Cooldown reasons (`RateLimitReason`)

| Reason | Written when | Quota-derived? |
|---|---|---|
| `weekly_exhausted_429` | 429 + account-wide weekly ≥100% on fresh usage | **yes, by construction** |
| `session_exhausted_429` | 429 + 5h session ≥100% on fresh usage (weekly not spent) | **yes, by construction** |
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

**"Quota-derived by construction"** means the proxy READ the spent window itself
(fresh usage data) instead of inferring the cause from headers. The set lives in
`QUOTA_DERIVED_RATE_LIMIT_REASONS` (`packages/types/src/account.ts`) and is the
ONLY set the capacity-restored path may release early — the evidence that clears
such a cooldown is the same evidence that created it. Both members come from one
rung in the 429 ladder, classified via `accountWideExhaustion` (weekly outranks
session).

**Adding a reason requires three follow-through sites** or it silently breaks:

1. the `RATE_LIMIT_REASONS` runtime tuple the union derives from,
2. `errorCodeMeta.ts` (exhaustive `Record` — typecheck blocker),
3. a `/api/accounts` round-trip test.

A hand-maintained allowlist previously drifted from the union and silently
nulled `family_weekly_exhausted_429` in the API for months.

## Known dead code and disproven comments

- **`isAnthropicHardLimitStatus` has never returned `true` in production**
  (0/1145). Its two consumers — the family-weekly guard precondition and
  `classify429Transient` step 2 — are effectively no-ops.
- **FIXED (was dead for two months): `clearRateLimitOnCapacityRestored` never
  fired** — 0 `Cleared stale rate_limited_until` AND 0 `Skipping
  capacity-restored clear`. The second zero proved the callback was never
  invoked: it was gated on `usageRateLimitedUntil`, which tracks 429s on the
  **usage endpoint itself**, not the account's cooldown. It is now
  level-triggered off the polled utilization (see `recovery.md`).
  `usageRateLimitedUntil` still exists and still has four live consumers — it is
  simply no longer this gate.
- **`providers/anthropic/provider.ts:25-28` is WRONG.** It claims "429s do NOT
  carry this header value; a `rate_limited` unified-status means the account
  itself is rate limited". Reality: hard 429s carry `rejected` **with** a reset,
  bursts carry neither, and `rate_limited` never appears. This false model is the
  origin of a whole bug class.
- `usageCache.getRateLimitedUntil` is named for a quota window but tracks the
  **usage API's own** 429 throttle. `out_of_credits` consumes it as a quota reset.
