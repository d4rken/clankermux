# Handover: demand-conserving roster scenarios for the pool runway

Status (2026-09-05): **not started.** Written against `main` at `13f5ea3d`
(v2026.9.9), the commit that landed the "learning accounts" batch this document
builds on. It supersedes **Item 1** of `docs/handover-usage-prediction.md`
("model load redistribution"), whose prerequisite, a token-ledger demand model,
was measured as not feasible (`docs/ledger-burn-feasibility.md`). The plan
below works from per-account percent slopes plus tier capacities instead.

Read `CLAUDE.md`, then this file, then the code it points at. Section 7 lists
decisions that were already made and are not yours to reopen.

---

## 1. The problem in one picture

The pool runway answers "when is every account dead at once". Each account's
windows get projected dead spans from the account's **own** measured burn, and
the runway is the first instant the dead spans of all pooled accounts overlap.

```
day:        now   1d    2d    3d    4d    5d    6d    7d
B · 7-day   ░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░      B dies 2d, back at reset 6d
A · 7-day   ░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓      A dies 4d
                                    ^ runway 4d
```

That picture is wrong in one specific way: when B dies on day 2, B's traffic
does not vanish, it fails over to A. A's burn roughly doubles from day 2, so A
dies well before day 4. The model keeps A's slope fixed, so the runway is
**optimistic exactly when it matters**. The same defect appears at every roster
change:

| event | what the model does today | what is true |
|---|---|---|
| account removed or paused | its demand disappears with it | survivors absorb it, burn rises ~N/(N−1) |
| account added (0% or under an hour of evidence) | excluded, disclosed as "learning" (v2026.9.9) | it will absorb a share of existing demand |
| account upgraded in place | reset drives a fresh window; pct slopes restart | its capacity per percent changed (Plus→Pro is 4×) |
| an account dies mid-horizon | others' slopes unchanged | others speed up |

Codex's design review on 2026-09-05 called this "the highest-value substantive
model change, with medium-to-high implementation risk", and both reviewers
agreed on the direction: **conserve demand across the roster; never invent it**
(assigning a newcomer a peer-average slope while leaving everyone else's slope
unchanged adds demand that does not exist).

## 2. What exists today

All pointers verified at `13f5ea3d`. Line numbers drift; symbols do not.

### 2.1 The model (`packages/core/src/capacity-runway.ts`)

- `RunwayAccountInput` (~L566): `accountId`, `unmetered`, `windows:
  RunwayWindowInput[]`, `codexResetCredits?`. **No tier, no demand share, no
  weight.** `RunwayWindowInput` (~L515): `windowKind`, `utilizationPct`,
  `resetsAtMs`, `windowStartMs`, `prediction`, `lifetimeConfidence?`,
  `observedAtMs?`, `anchor?`. Duration is derived as `resetsAtMs − windowStartMs`.
- `estimateWindowExhaustion` (~L228): one window in, `{source,
  slopePctPerHour, exhaustsAtMs, lowConfidence, evidenceSpanMs}` out. Branch
  order: non-finite → none; `pct >= 100` → already-exhausted; structural
  guards; usable regression; `pct <= 0` → unstarted / no-usage;
  lifetime-primary (observation-anchored, full confidence); lifetime-average.
- `buildPool` (~L1247): per account, per window, calls the estimator, applies
  `scaleEstimatePace` for the probes, drops **learning** windows
  (`isLearningEstimate`, ~L456: pct ≤ 0, or no-usage/unstarted, or
  `evidenceSpanMs < 1h`), and **one learning window makes the whole account
  unprojectable** (strict rule, user decision). Weekly intervals go through the
  Codex reset-credit bank. Returns `{pooled, unprojectableAccountIds,
  learningAccountIds, assumedCredits}`.
- `windowDeadIntervals` (~L606): dead `[exhaustsAt, reset)`, then repeated
  cycles only when `timeToFull < duration`. This knife-edge is why the runway
  flips between a date and ∞ and why the pace probes exist.
- `firstAllOut` (~L1398): intersection over pooled unions.
- `computeCapacityRunway` (~L932): outcome kinds `no-accounts | unknown |
  out-now | runway | beyond-horizon`, with `paceMargin` (beyond-horizon) or
  `paceDeficit` (runway) from `probePaceMargin` / `probePaceDeficit`, both a
  **1% grid walk, never a bisection** (non-monotone once credits are modelled).
  `pacedWindowKinds` lets a caller pace only some windows (used by the family
  headroom bound).
- `computeCapacityRunwayBand` (~L1147): ±0.5 pp on the weekly reading; excludes
  the baseline's learning accounts from both probes.

**Isolation, verified:** no account's estimate reads another account's data.
The only cross-account coupling is `firstAllOut`'s intersection and the probes'
single uniform multiplier. There is no path by which A's death changes B's slope.

### 2.2 How accounts reach the model

- `packages/http-api/src/services/runway-scan.ts` `computeRunwayScan`
  (~L496): pure; builds `RunwayAccountSource[]` from `getAllAccounts()` with
  `paused` carried, not filtered; `windowObservations` from the freshest
  cache/snapshot candidate; burn anchors; the Codex credit bank.
- `packages/core/src/api-key-runway.ts` `runwayFor` (~L479) is **the** roster
  filter: `!a.paused && isAccountAllowedByPin(pin, a)`. One row per active API
  key (pins define servable sub-pools), or one synthetic unpinned row.
  `toRunwayAccountInput` (~L390) maps observations to windows;
  `summarizeKeyRunways` (~L768) builds the headline and the deduped
  `learningAccountIds`.
- Other consumers of the same core: `packages/core/src/workload-headroom.ts`
  (class rows and family rows, the latter via `familyHeadroomBound` with
  `pacedWindowKinds`), `packages/http-api/src/services/public-runway.ts`
  (`/public/v1/runway`, counts only, never ids). `pacing-scan.ts` does **not**
  call the runway model; it uses `computePoolUsage`.

### 2.3 Data you can use

- **Tier on the account row**: `accounts.identity_plan_tier`,
  `accounts.identity_rate_limit_tier` (`packages/database/src/migrations.ts`
  ~L74-75; repository `account.repository.ts` ~L88). Anthropic values are
  normalised by `packages/providers/src/providers/anthropic/identity.ts`
  (`claude_max → "max"`, rate-limit tier token `"20x"`, `"5x"`); Codex values are
  the ChatGPT `planType` (`plus`, `pro`, `prolite`, …). **There is no
  tier→capacity multiplier anywhere in the code today.** `formatPlanTierLabel`
  in `packages/core/src/tier-label.ts` is display only.
- **Tier history**: every `usage_snapshots` row carries `plan_tier` and
  `rate_limit_tier` (sampler stamps them, `apps/server/src/usage-snapshot-
  sampler.ts` ~L228). Rows before 2026-08-25 have null tiers.
- **Snapshots survive pause and removal**: the sampler does not skip paused
  accounts, and a removed account's rows stay in `usage_snapshots` (only the
  retention job deletes, by age). So a removed account's last measured slope is
  recoverable from history. Its `accounts` row is gone, so its tier must come
  from its snapshot rows.
- **Routing signals** (for choosing a demand-share rule, not for feeding the
  model): session affinity (`packages/load-balancer/src/strategies/index.ts`
  `SessionStrategy`), least-used with a 500 ms recency penalty
  (`least-used.ts`), and the soft-demotion reorder in
  `packages/proxy/src/admission-gates.ts` (family reservation + pool liveness:
  reorders, never drops).
- **Per-account request accounting**: `requests` has `account_used`,
  `timestamp`, the four token columns and `total_tokens`
  (`migrations.ts` ~L85-116, index `idx_requests_timestamp_account`). No
  repository method aggregates tokens per account per time bucket yet;
  `StatsRepository.getSessionStats` is per session start, not per interval.
- **Backtest harness**: `packages/core/src/prediction-backtest.ts` (estimator
  registry, scoring, bootstrap) and `scripts/prediction-backtest.ts` (read-only
  DB run). **The core file contains two literal NUL bytes** (`cohortKey`,
  ~L663); plain `grep` treats it as binary and prints nothing. Use `grep -a`.
  Reports: `docs/prediction-backtest-{baseline,composite,resplit}.md`.

## 3. What you are building

A **demand-conserving scenario** for the pool runway: the same event-scan
structure, but each account's burn becomes state-dependent. Total pool demand
is measured once, in capacity units, and drains whichever accounts are alive.
When an account dies, is paused, or is removed, its share moves to the
survivors; when an account is added or is still learning, it takes a share
from the others. Nothing is added or dropped.

### 3.1 Units: percent per hour is not additive across tiers

1 %/h on a Max 20x account is four times the tokens of 1 %/h on a Max 5x, and
Plus→Pro on ChatGPT is the same ratio. Redistribution therefore has to happen
in **capacity units**, never by averaging percentages:

```
demand_i  [cap-units/h] = slope_i [%/h] × cap_i [cap-units per 100 %]
D         = Σ demand_i over accounts with a confident slope
share_j   = D × w_j / Σ_k w_k           over alive, projectable-or-learning accounts k
slope'_j  [%/h] = share_j / cap_j
```

`cap_i` comes from a **small explicit table**, inline named constants (no env
gates), keyed by `(provider, plan_tier, rate_limit_tier)`:

| provider | tier | cap (relative) |
|---|---|---|
| anthropic | rate-limit token `5x` | 5 |
| anthropic | rate-limit token `20x` | 20 |
| anthropic | pro (no token) | 1 |
| codex | `plus` | 1 (5× baseline in OpenAI's own framing; use 5 if you want one scale) |
| codex | `pro` | 20 (relative to plus = 4) |
| codex | `prolite` | treat as `plus` unless evidence says otherwise |
| anything else / null | **unknown** |

The absolute values do not matter, only ratios within a servable class. An
account whose tier is unknown must not be silently weighted 1: either exclude
it from the redistribution (and disclose) or give it the class median with a
`tierProvenance: "assumed"` flag, mirroring quota-drift's
`TierProvenance = "recorded" | "assumed"`. Do not derive multipliers from
percent drops; the tier fields are the source.

Cross-check, cheap and worth doing first: quota-drift's `100/w_m` is an
implied full-window capacity in equivalent tokens per cohort
(`packages/core/src/quota-drift/types.ts`). Where it has a fit, its ratio
between two tiers of the same provider should agree with the table. If it does
not, believe the measurement and say so in the PR.

### 3.2 The share rule `w_j`

This is the real design decision. Routing is not uniform: `SessionStrategy`
pins a client to an account, least-used breaks ties, and the soft-demotion
gates push traffic off accounts near a family limit. Options, in order of
defensibility:

1. **Equal split among alive accounts of the class** (`w_j = 1`). Simple,
   wrong in detail, and the one both reviewers said to ship first **as a
   labelled scenario**, not as the headline.
2. **Proportional to remaining headroom** (`w_j = (100 − pct_j) × cap_j`).
   Approximates least-used; still ignores affinity.
3. **Observed shares from the ledger** (per-account `total_tokens` over the
   last few hours from `requests`). Truest to routing, but the ledger has
   already failed to explain percent deltas at recording resolution
   (`docs/ledger-burn-feasibility.md`), so use it for *shares* only, never to
   derive burn.

Recommendation: implement 1, make the rule an injected function so 2 and 3 can
be scored against it by the harness, and let the backtest decide. Do not argue
it from first principles.

### 3.3 Where demand comes from when the account is gone

`D` needs the burn of accounts that are no longer in the roster (removed) or
excluded from projection (paused, learning). Sources, in order:

- The scan already carries paused accounts (`paused` is a filter in
  `runwayFor`, not in `computeRunwayScan`): a paused account's slope is
  measured and available; it contributes to `D` and to nothing else.
- A removed account: its last confident slope is in `usage_snapshots` (with
  its tier). Read the last 24 h of rows for account ids that have rows but no
  `accounts` row, or that were removed since the last scan. Decay it: after
  one full window cycle without the account, drop it.
- A learning account contributes **nothing** to `D` (that is what learning
  means) and **takes** a share `w_j`. This is the item that replaces
  exclusion: the newcomer's projected slope is its share of everyone else's
  measured demand, at its own capacity.

Keep offered and served demand apart in your head: with the proactive
throttles off in production (`usage_throttling_*_enabled` absent) they are
the same today; if a throttle is ever enabled, served demand undercounts.

### 3.4 State-dependent scan

Keep `windowDeadIntervals` and `firstAllOut`. Replace the one-shot per-account
projection with an event loop over the horizon:

1. Events: an account's window hits 100 % (dead), a window resets (alive), a
   Codex reset credit is consumed, a roster change instant (now, for
   scenarios). Collect the next event across all accounts.
2. Between events, every alive account burns at `slope'_j` from 3.1; advance
   each window's pct linearly to the event instant.
3. At an account death, recompute shares over the survivors; at a revival,
   recompute again. Cap iterations like `MAX_PROJECTED_CYCLES`.
4. Pool out = first instant with no alive projectable account; causes as
   today.

Scoped family windows (`weekly_scoped:<family>`) stay **outside** v1: the
family share of account-wide burn (`f`) is not measurable, which is why the
family headroom is a bound. Redistribute account-wide windows only, and keep
`familyHeadroomBound`'s `pacedWindowKinds` semantics untouched.

Reset credits: the bank revives a dead weekly window; under redistribution the
revived account immediately takes a share again. The probes' non-monotonicity
argument (grid walk, not bisection) applies to the scenario as well.

### 3.5 Shape of the output

Do **not** replace the current outcome. Add the scenario beside it so it can be
validated live before it becomes the headline:

- Core: `computeCapacityRunwayScenario(accounts, now, {shareRule, tierTable})`
  returning the same `RunwayOutcome` shape plus `basis: "demand-conserving"`,
  `demandUnitsPerHour`, `assumedTiers: {accountId, tier, provenance}[]`, and
  the learning accounts it *included* with their assigned share. Reuse the
  outcome kinds; a new `kind` maps to `other` on the public wire and silences
  every dashboard `switch` default.
- `/api/runway`: an optional `scenario` per key. Dashboard: a second line on
  `RunwayCard` ("if demand is conserved: out in 2d 4h") while both exist.
- Public wire: **nothing** until the backtest verdict; when it lands, counts and
  instants only, extend the goldens and guards in
  `packages/http-api/src/handlers/public/__tests__/dto.test.ts` (`arrayNesting
  <= 2`, `depthOf < 8`, `assertInstantsAreIso`, the forbidden-substring list
  that already bans `unprojectableAccountIds` and `learningAccountIds`).

## 4. Validation, the part that decides whether this ships

The 2026-08 backtests scored per-window ETAs. This work needs a **pool-level**
score: at each historical instant `T`, from the readings available at `T`,
predict when the pool had no alive account; compare with what happened.

1. Extend `scripts/prediction-backtest.ts` with a pool-level mode: iterate `T`
   over the range at `--step-minutes`, build `RunwayAccountInput[]` from
   snapshots as of `T` (the harness already reconstructs per-window readings),
   run both the current model and the scenario, derive the truth from the
   later rows (an instant where every account's window was ≥ 100 % or paused).
2. Metrics: signed ETA bias (optimistic is the expensive direction; the
   current lifetime estimator's bias is −594 min early per
   `docs/prediction-backtest-composite.md`), F1 on "out within horizon" by
   lead-time bucket, and calibration of the ≥/∞ claims.
3. **Transition-specific replays**, the point of the exercise: score only the
   instants within 24 h after (a) an account add (`accounts.created_at`,
   `identity_captured_at`), (b) a pause/removal (first snapshot gap or
   `paused` flip), (c) an in-place upgrade (snapshot `rate_limit_tier` /
   `plan_tier` changes; the two Codex upgrades on 2026-09-05 ~13:55Z and
   ~13:58Z are known events), (d) a mid-window gift reset (the burn-anchor
   registry's revision events, or ≥ 5 pp drops with a stable reset).
4. Verdict rule, declared before running: the scenario replaces exclusion as
   the headline only if its pool-level bias is not more optimistic than the
   current model on the transition replays **and** its F1 is not worse
   overall. Otherwise it stays a labelled scenario. Write the report to
   `docs/prediction-backtest-redistribution.md` in the style of the existing
   three.

Known limits to state in the report: tier provenance is null in snapshots
before 2026-08-25 (assume current tiers held, flag it); with six accounts the
number of completed weekly windows is small, so score on completed windows,
not instants (the composite study's lesson).

## 5. Surfaces and tests to touch

- Core: `packages/core/src/capacity-runway.ts` (scenario beside the model),
  new `packages/core/src/tier-capacity.ts` (the table, pure), share rules as
  pure functions. Tests: `capacity-runway.test.ts` has the fixtures; add a
  scenario describe with the two-account timeline above (B dies 2d, A alone
  from then on at doubled burn ⇒ pool out ≈ 3d, not 4d), an add case (newcomer
  takes 1/N and the pool's ∞ becomes a date), a removal case (survivor speeds
  up), an upgrade case (same slope in %, 4× the cap ⇒ 4× the demand units), a
  mixed-tier case that proves percentages are not averaged, and an
  unknown-tier case that proves nothing is silently weighted 1.
- Roster: `runway-scan.ts` / `api-key-runway.ts` (paused and removed demand
  sources, tiers on `RunwayAccountInput`), tests in
  `packages/http-api/src/handlers/__tests__/runway.test.ts` (seeds via
  `codexSnapshot`) and `packages/core/src/api-key-runway.test.ts`.
- Harness: `packages/core/src/prediction-backtest.ts` (remember `grep -a`),
  `scripts/prediction-backtest.ts`.
- Dashboard: `packages/dashboard-web/src/lib/runway-display.ts`,
  `components/overview/RunwayCard.tsx`, `limits/LimitsCapacityOverview.tsx`;
  static-markup tests beside them.
- Later, behind the verdict: `public-runway.ts`, `public/dto.ts` and its
  goldens; `workload-headroom.ts` class rows.

## 6. Constraints and traps

- **The checkout is the live deployment.** Work in a worktree from
  `refs/heads/main` (there is also a `main` tag: always spell the ref). Never
  `checkout`/`reset`/`stash` in `/home/darken/clankermux`. Land with
  `merge --no-ff` after a version bump; run `bun run build` before merging,
  restart, prove the unit is active with the restart counter unchanged.
- Fresh worktree: `bun install --frozen-lockfile` and
  `bun packages/database/scripts/build-workers.ts --placeholders-only` before
  `bun test`. Expect **587 test files** at `13f5ea3d`; fewer means the inline
  workers are missing. Never read or commit
  `packages/database/src/inline-*-worker.ts`.
- `bun run lint && bun run typecheck`, in that order; lint rewrites files.
- **No env-var feature gates.** Inline named constants.
- **`null`, never `0`, for absent evidence.** A learning account has no slope;
  an unknown tier has no capacity. Disclose, do not default.
- **Never curl the Anthropic endpoint**, directly or via the proxy's `claude`
  account. Use the harness and the DB (read-only) for evidence.
- Do not touch: the burn-anchor registry's rollover rule
  (`usage-revision-anchor.ts`), `RESET_JITTER_TOLERANCE_MS`, the 1 % grid
  probes, the pacing clock (`throttle-utils.ts`), throttle code, the strict
  learning rule (user decision on 2026-09-05), the weekly lifetime estimator
  default (backtest-selected), or the family headroom bound semantics.
- Do not re-derive the token-ledger burn model; its entry requirements are in
  `docs/handover-usage-prediction.md` Item 2 and are unmet.
- Precedent to respect: **disclosure over smoothing** (the ∞ teleport was
  handled by the pace-margin probe, not by damping); **candidate-ordering
  rules run last** in routing; the pool-liveness gate reserves a failover
  tail, so traffic never moves purely first-empty-first-out.
- The dashboard must never render a fallback `0` for a failed read.

## 7. Decisions already made (do not reopen)

- Interim treatment of unknown burn is **exclude and disclose**, strict for
  mixed accounts (v2026.9.9). This work replaces exclusion with an estimate
  only after the pool-level backtest verdict in section 4.
- Imputing a peer-average slope to a newcomer without reducing the others was
  rejected by both reviewers: it invents demand.
- The pacing clock is not reset to a burn anchor; a gift reset grants room
  immediately. Unrelated to this work, stated so it is not "fixed" in passing.
- A decaying pre-gift burn prior across a gift reset was proposed by Codex and
  held pending harness evidence; it is not part of this work.
- The public runway deliberately strips assumption fields (accepted
  2026-08-24); a scenario reaching the public wire carries counts and instants
  only.

## 8. Suggested order

1. Tier capacity table + provenance, pure, with tests. Cross-check against
   quota-drift's implied capacities. Half a day.
2. Scenario computation in core beside the current model: demand memory for
   paused/removed accounts, share rule as an injected function (equal split
   first), event loop, tests from section 5. Two to three days.
3. Pool-level backtest mode and the transition replays; write the report;
   apply the verdict rule. One to two days, mostly waiting on runs.
4. Only then the surfaces: `/api/runway` scenario field, RunwayCard second
   line. Public wire after the verdict.

Steps 1 and 2 can go through the develop pipeline as one branch; step 3 is a
separate branch with the report; step 4 follows the verdict.
