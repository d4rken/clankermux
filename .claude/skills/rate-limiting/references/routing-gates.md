# Routing gates, soft demotions and display

## Display is a projection — the cause-before-mechanism law

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

## Soft demotions, and why POSITION is the only correct test

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

## The family (shared-window) reservation

`packages/proxy/src/handlers/family-reservation-gate.ts`. Demotes a NON-protected
request off an Anthropic account whose shared window is near its limit, so the
tail stays available for the protected family (Fable). The two axes are gated
differently because they behave differently near their reset.

| Parameter | Value | Why |
|---|---|---|
| `SESSION_RESERVE_HEADROOM_PCT` | 25 | 5h axis: unconditional and self-healing — the window rolls in hours, so reserving costs almost nothing and needs no demand signal |
| `WEEKLY_RESERVE_HEADROOM_PCT` | 40 | 7d axis: DEEPER on purpose — a spent weekly window is a multi-day wall, and the soft demotion erodes under fail-open pool pressure. ~3–4× Fable's observed ~11% weekly demand share |
| `PROTECTED_FAMILY_DEMAND_LOOKBACK_MS` | 12 h | 7d axis is demand-targeted; Fable use is bursty and human-shaped, so an overnight gap must not disarm the reservation. Restart loses the in-memory map — accepted fail-open (no demand ⇒ no reservation) |
| `WEEKLY_HARVEST_YIELD_HORIZON_MS` | 2 h | inside this much of the BINDING weekly reset the reservation yields: Fable's own weekly window resets at the same wall-clock, so held quota would expire unused |

Both axes are strictly-less-than (exactly the threshold still serves), and every
branch of missing evidence keeps the account.

## The pool-liveness reserve

`packages/proxy/src/handlers/pool-liveness-gate.ts`. FEFO on the weekly reset
deliberately drains the soonest-expiring account first, which drives accounts to
weekly 100% one after another — and weekly 100% is dead for up to seven days.
The reserve holds back the tail so an account survives as failover while a peer's
(short, self-healing) 5h window cools.

The reserve is TWO-TIER: the band depends on whose traffic is asking, not on the
account. `resolveLivenessReserveThreshold(protectedRequest)` is the single source
of the threshold, and the SAME value feeds both the demotion decision and the
absorbable-peer count so they cannot drift.

| Parameter | Value | Why |
|---|---|---|
| `LIVENESS_RESERVE_HEADROOM_PCT` | 20 | ordinary traffic stops here — below this weekly headroom quota is held, not harvested |
| `LIVENESS_RESERVE_PROTECTED_HEADROOM_PCT` | 10 | requests the account would serve as the protected family (Fable) may spend deeper; the 10–20% band is Fable-plus-emergencies-only |
| `LIVENESS_RELEASE_HORIZON_MIN_MS` / `_MAX_MS` | 12 h / 36 h | clamps on the burn-aware release horizon |
| `LIVENESS_DESIGN_SLOPE_PCT_PER_HOUR` | 0.66 %/h | the documented ~15.8%/day observed burn, used for the static fallback |
| static fallback horizon | `threshold / 0.66` | ≈15.2 h protected, ≈30.3 h non-protected — the time that tier's tail actually needs |
| absorbable peer test | `minHeadroom >= threshold` | **not** `weeklyHeadroom`: a peer with a spent 5h session is the very failover case the reserve covers, so it must not count |

Within a tier the `>= threshold` (absorb) / `< threshold` (reserve) split is
exactly complementary — no account falls in a dead zone at the threshold.

**Tiering follows the LOGICAL request family.** `modelForAccount` falls back to
the logical Claude model when the mapped model has no recognized family, so a
Codex account serving a fable-logical request (explicit or default `fable →
gpt-*` mapping) classifies as protected. That is intended: the tier privileges
the user's protected-family traffic pool-wide, so an Anthropic outage that fails
Fable over to Codex may spend deeper there too. The dashboard Primary badge
models a generic fresh request and therefore always uses the NON-protected tier.

### The release horizon is burn-aware

Rule 6 asks "how long would this tail actually take to drain?". With a usable
weekly burn slope (see below) the horizon is `weeklyHeadroom / slope`, clamped to
[12 h, 36 h]; without one it is the tier-scaled static fallback above.

> **Self-suppression is expected and bounded.** A well-reserved account stops
> receiving traffic, so its own slope collapses and `headroom / slope` pegs at the
> 36 h max clamp — bounded EARLY release, chosen deliberately because a complete
> drain beats quota that expires. The converse is the point: under fail-open pool
> pressure the account IS being served, its slope is high, and the horizon
> shortens toward the time really needed, holding the reserve longer exactly when
> the pool is strained.

Rule 4 (`absorbablePeerCount >= 1`) makes the reserve self-disabling on degraded
paths: with no healthy peer there is nothing to hand traffic to, so it fails
open. This is why the failover/fallback tails can omit the reorder safely.

> **Accepted: rule 4 fail-opens BEFORE any release logic.** When every backup is
> cooling, a reserved account keeps its place regardless of tier or horizon, so
> the reserve erodes exactly in the incident it was built for. That channel stays
> open BY DESIGN — serving the request now beats reserving into a 503.

### The weekly burn slope feeding it

`packages/proxy/src/weekly-burn-slope.ts` — an in-memory, per-account store of
percent-of-weekly-window-per-hour, fitted by the usage-snapshot sampler
(`refreshBurnSlopes`) with the pure estimator in `@clankermux/core`. It is a
routing HINT: an empty map (fresh restart) just means the static fallback.

| Rule | Why |
|---|---|
| `observedAt` = newest CONTRIBUTING snapshot, never the recompute time | refitting unchanged history must not make a stale slope look fresh |
| usable for `WEEKLY_SLOPE_MAX_AGE_MS` = 15 min | ≈7 sampler ticks: tolerates a couple of missed samples, stops steering within minutes of a dead poller |
| `lowConfidence` / non-finite ⇒ null | filtered on READ, so exactly one place decides usability |
| `resolveEffectiveWeeklySlope` matches the fitted window's reset against `bindingWeeklyResetMs` (±5 min) | a slope fitted on the account-wide `seven_day` series must never steer a gate bound by `seven_day_oauth_apps` or a rolled window |

The sampler refits after EVERY tick — including the no-fresh-rows and
insert-failure paths (persisted history is independent of the write) — and once
at `start()`, so a deploy restart does not blind the gates for the whole startup
deferral. Accounts whose newest sample has not advanced are skipped.

## The 5h window is a throttle NESTED inside the weekly budget

Every token spent inside a 5h window is also spent against the weekly window.
The 5h window is a **rate** limit; the weekly window is the **budget**. Unused 5h
capacity is therefore **not lost budget** — it is simply budget spent later.

This is the reasoning that rules out adding a 5h term to HARVEST ranking: FEFO
exists to stop unused *budget* expiring, and only the weekly window has a budget
that expires. It is expensive to re-derive, and it has now been got wrong and
reverted **twice**:

1. *Ranking by soonest reset overall.* The 5h window always resets sooner, so it
   won every comparison and FEFO never actually targeted the expiring weekly
   quota.
2. *Staggering the 5h window phase across idle accounts* (v2026.8.48, reverted
   v2026.8.58). The premise was that pre-opening 5h windows at spread-out offsets
   makes fresh capacity arrive steadily. It cannot: a CLOSED 5h window is already
   the best state an account can be in — full rate allowance, released the instant
   a request arrives, clock not running — so priming an idle account only starts
   the clock early and the window expires unspent. Pre-opening does not create
   capacity, it consumes window life. What priming actually buys is legibility
   (an account with no reset timestamp sits in the UNKNOWN bucket because FEFO
   needs a deadline to sort on), which argues for priming immediately, never for
   delaying it.

Both failures share one root: treating the 5h window as a budget to be harvested
or scheduled. It is a rate limit. If a design's value depends on when a 5h window
opens or closes, re-read this section before writing code.

A related trap sits one layer down. `accounts.rate_limit_reset` holds the reset
of whichever limit is BINDING (`response-processor` writes it from
`anthropic-ratelimit-unified-reset`), so on a weekly-bound pool it holds the
WEEKLY reset. The auto-refresh scheduler's prime gate reads that column; it is
named `bindingWindowResetElapsed` for this reason, and was previously misnamed
`fiveHourWindowGate`, which is part of how attempt 2 got as far as it did.

The 5h window does still matter for **liveness** (an account whose 5h is spent
cannot serve right now), which is why it appears in `minHeadroom`, in the
NEAR_LIMIT bucket gate, and in the NEAR_LIMIT recovery ordering
(`usage-windows.md`) — never in HARVEST ranking.
