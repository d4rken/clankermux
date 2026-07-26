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

## 4. The 429 decision ladder (`proxy-operations.ts`, in order)

```
reprobe
  → out_of_credits            (long floor, no burst-retry)
  → account-wide exhausted    (weekly OR 5h session spent; no burst-retry)
  → family-weekly safety net  (fails over WITHOUT an account-wide cooldown)
  → transparent burst-retry   (classify429Transient → hold & re-probe)
  → model fallback / no-fallback / all-models-exhausted
  → response-processor generic path
```

Earlier rungs are more specific and win. **Order is load-bearing** — the
account-wide and family rungs sit before burst-retry precisely so a spent window
is never misread as a transient burst. The account-wide rung's DEADLINE is still
`extractCooldownUntil`, never the window's `resets_at`: a stale-cache false
positive must not be able to create a multi-day lock.

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
| **Capacity restored** | polling observes the quota recovered | **yes — live since the early-reset-recovery fix** |

**There is no reset notification.** Early recovery can only ever be detected by
observing the polled number drop — which is why the poller keeps running against
locked accounts.

The capacity-restored path (formerly dead, see §9) works like this:

1. The poller REPORTS, level-triggered, on **every** successful poll where the
   representative utilization is a number **below 100**: `{ accountId,
   utilization, extraUsageUtilization, fetchStartedAt }`. Level, not edge —
   an account locked while its windows sat at 40% never produces a `100 → <100`
   crossing. `null` never reports (§1).
2. `apps/server/src/capacity-restored.ts` decides. It refuses, with a distinct
   greppable token, when: the reason is not quota-derived (`ineligible_reason`),
   `rate_limited_at` is absent (`missing_rate_limited_at`, fails CLOSED), the
   cooldown is not strictly older than `fetchStartedAt`
   (`cooldown_newer_than_evidence`), or the atomic UPDATE matched no row
   (`cas_mismatch`). Success logs `capacity_restored_clear`.
3. The DB compare-and-clear re-asserts deadline + write instant + exact reason +
   the causal boundary in ONE `UPDATE`.
4. A released account is selectable again with streak 0 and no deadline, so a
   dedicated **capacity-restored marker** admits exactly one probe. It is never
   time-expired and is retained on `cooldown_reapplied` / `abandoned`. The
   global force-account override in `proxy.ts` bypasses account selection
   entirely, so the one-probe guarantee explicitly excludes it.

Level-triggering heals a REFUSED or MISSED clear — not an incorrect one.
Correlating `capacity_restored_clear` with a subsequent 429 on the same account
is the signal that an early release was wrong.

## 8b. Soft demotions, and why POSITION is the only correct test

Two gates in `proxy.ts` **reorder** candidates instead of excluding them
(`applySoftDemotionReorder`): the family-reservation gate and the pool-liveness
reserve. Both are fail-open soft preferences — they never drop an account, so
they can never empty the pool.

> **They MUST be one partition, not two sequential ones.** Two stable partitions
> do not compose: family produces `[kept, reserved]`, and a later liveness
> partition over that result can produce `[reserved, kept]` — promoting an
> account the family gate had just reserved. There is exactly ONE partition, over
> the UNION of both demotion reasons.

### Affinity and the burst preflight both bypass capacity gating

Cache affinity pins a request to its warmed account, and the transparent
burst-retry **preflight** attempts the affinity-held account before the ordinary
attempt loop. Neither consults capacity. That is deliberate for affinity (the
warm prompt cache is worth more than a marginally better-ranked sibling), but it
means a soft-demotion reorder is only real if the preflight respects it.

> **Test POSITION, not membership.** The preflight used
> `accounts.some(a => a.id === heldId)` — list membership — which is still `true`
> after a reorder moved the held account to the BACK. That silently bypassed
> every soft demotion on `affinity_hit` traffic, i.e. the dominant path.
> `routing.primaryAttemptAccountId` (set after every gate and reorder) is the
> post-gate first attempt; the preflight now compares against it.

Two membership tests are correct and stay as they are:
- `heldInGatedAccounts` → feeds `isBurstHoldEligible`, which asks "was this
  account *excluded* by a gate", for which membership is the right semantic.
- the marker-active path → a provider-family-wide per-IP burst where switching
  accounts does not help; it has its own weekly-exhaustion guard.

`SessionStrategy.logSelection()` runs BEFORE these gates, so it does NOT show the
order clients follow. The DEBUG line `Final candidate order: … — first admitted
attempt: … (gated primary by position: …)` in `proxy.ts` is the one that does.
It is emitted once per request from the attempt-ADMISSION points (every
`attemptThroughProbeGate` callback), never from the `count_tokens` local
synthesis, which makes no upstream call. "Admitted" is deliberate and is NOT
"reached the network": request preparation and the authoritative overload
admission in `proxy-operations.ts` both sit after admission and can still fail
over. The question this line answers is which account ROUTING attempted first —
a soft-demoted account being attempted first is the defect either way.

### The pool-liveness reserve

`packages/proxy/src/handlers/pool-liveness-gate.ts`. FEFO on the weekly reset
deliberately drains the soonest-expiring account first, which drives accounts to
weekly 100% one after another — and weekly 100% is dead for up to seven days.
The reserve holds back the tail so an account survives as failover while a peer's
(short, self-healing) 5h window cools.

| Parameter | Value | Why |
|---|---|---|
| `LIVENESS_RESERVE_HEADROOM_PCT` | 10 | below this weekly headroom, quota is held, not harvested |
| `LIVENESS_RESERVE_RELEASE_HORIZON_MS` | 12 h | release before the BINDING weekly reset so the tail is still spent |
| absorbable peer test | `minHeadroom >= 10` | **not** `weeklyHeadroom`: a peer with a spent 5h session is the very failover case the reserve covers, so it must not count |

The `>= 10` (absorb) / `< 10` (reserve) split is exactly complementary — no
account falls in a dead zone at exactly 10.

> **The 12h horizon deliberately may NOT fully drain a 10% tail.** At the
> observed ~15.8%/day burn a 10% tail needs ~15h. Liveness is prioritized over
> complete harvest: the failure this gate prevents is a total-pool outage, and a
> partially unspent tail is a far cheaper loss. Revisit only if waste becomes
> visible in practice.

Rule 4 (`absorbablePeerCount >= 1`) makes the reserve self-disabling on degraded
paths: with no healthy peer there is nothing to hand traffic to, so it fails
open. This is why the failover/fallback tails can omit the reorder safely.

### The 5h window is a throttle NESTED inside the weekly budget

Every token spent inside a 5h window is also spent against the weekly window.
The 5h window is a **rate** limit; the weekly window is the **budget**. Unused 5h
capacity is therefore **not lost budget** — it is simply budget spent later.

This is the reasoning that rules out adding a 5h term to HARVEST ranking: FEFO
exists to stop unused *budget* expiring, and only the weekly window has a budget
that expires. It is expensive to re-derive, and the wrong conclusion ("rank by
soonest reset overall") was already shipped and reverted once — the 5h window
always resets sooner, so it would win every comparison and FEFO would never
actually target the expiring weekly quota.

The 5h window does still matter for **liveness** (an account whose 5h is spent
cannot serve right now), which is why it appears in `minHeadroom`, in the
NEAR_LIMIT bucket gate, and in the NEAR_LIMIT recovery ordering (§8c) — never in
HARVEST ranking.

## 8c. NEAR_LIMIT recovery ordering

Within the NEAR_LIMIT bucket the primary sort key is `recoveryDeadline`: when the
account STOPS being near-limit. A 5h-bound account recovers in hours and returns
to full HARVEST capacity; a weekly-bound one is out for days.

Three properties, each a correction from review — do not "simplify" them back:

1. **`max`, not weekly-first.** When BOTH axes bind, the constraint persists
   until the LATER reset.
2. **No `weeklyResetMs` fallback.** An unknown `bindingWeeklyResetMs` ⇒
   `Infinity` (sorts last). Falling back to `weeklyResetMs` would use an
   unrelated, *healthier* weekly window's reset.
3. **`extra_usage` is RESETLESS** ⇒ `Infinity`, even when another axis is also
   bound. It is folded into `bindingUtilization` but has no reset, so an account
   it binds never self-recovers.

`CapacitySignal.sessionResetMs` and `.extraUsageUtilization` exist for exactly
this: neither is recoverable from the aggregates (`soonestResetMs` is a min()
that loses which window it came from; `bindingUtilization` is a max() likewise).

## 9. Known dead code and disproven comments

- **`isAnthropicHardLimitStatus` has never returned `true` in production**
  (0/1145). Its two consumers — the family-weekly guard precondition and
  `classify429Transient` step 2 — are effectively no-ops.
- **FIXED (was dead for two months): `clearRateLimitOnCapacityRestored` never
  fired** — 0 `Cleared stale rate_limited_until` AND 0 `Skipping
  capacity-restored clear`. The second zero proved the callback was never
  invoked: it was gated on `usageRateLimitedUntil`, which tracks 429s on the
  **usage endpoint itself**, not the account's cooldown. It is now
  level-triggered off the polled utilization (§8). `usageRateLimitedUntil` still
  exists and still has four live consumers — it is simply no longer this gate.
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
   they are unrelated limits, and clearing one re-storms it. This is why the
   capacity-restored clear is gated on `QUOTA_DERIVED_RATE_LIMIT_REASONS` and
   NOT on "anything except `out_of_credits`": `upstream_429_with_reset`, which a
   burst inherits (§3), is excluded.
7. Status vocabulary lives ONCE in `packages/core/src/rate-limit-status.ts`.
   It was duplicated in four places, which is exactly why `rejected` — the value
   Anthropic actually sends — was recognized by none of them.
8. Soft demotions are applied as ONE partition over the union of all demotion
   reasons, never as sequential partitions (§8b).
9. Anything that bypasses the ordinary attempt loop must test POSITION against
   `routing.primaryAttemptAccountId`, not membership in the candidate list (§8b).
10. Never add a 5h term to HARVEST ranking — unused 5h capacity is not lost
    budget (§8b).

## Related

- `CLAUDE.md` — repo rules, DB migration rules, testing restrictions
- `.claude/rules/main-checkout-safety.md`, `.claude/rules/fork-workflow.md`
