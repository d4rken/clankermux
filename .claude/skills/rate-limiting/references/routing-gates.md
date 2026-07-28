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

## The pool-liveness reserve

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

## The 5h window is a throttle NESTED inside the weekly budget

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
NEAR_LIMIT bucket gate, and in the NEAR_LIMIT recovery ordering
(`usage-windows.md`) — never in HARVEST ranking.
