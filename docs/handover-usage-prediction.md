# Handover: improving ClankerMux usage prediction

**Status:** the shared estimator landed in v2026.8.64 (`dd646df8`), deployed and
running. This document describes the seven follow-on work items, in the order
they should be done. Item 0 (the backtest harness) comes first and is a hard
prerequisite for judging any of the others.

**Audience:** an agent picking this up cold. Read `.claude/skills/rate-limiting/`
before touching any of it — especially `references/usage-windows.md` and
`references/routing-gates.md`. Several of the invariants below were expensive to
derive and have been re-broken more than once.

---

## 1. Where prediction lives today

| Concern | File |
|---|---|
| The regression itself | `packages/core/src/usage-prediction.ts` |
| Prediction types + usability gate | `packages/types/src/usage-prediction.ts` |
| **The shared exhaustion estimator + pool runway** | `packages/core/src/capacity-runway.ts` |
| Server-side assembly of prediction inputs | `packages/http-api/src/services/build-account-predictions.ts` |
| Snapshot sampler + routing burn slope | `apps/server/src/usage-snapshot-sampler.ts` |
| Routing-side slope store | `packages/proxy/src/weekly-burn-slope.ts` |
| Per-key runway adaptation | `packages/dashboard-web/src/lib/api-key-runway.ts` |
| Presentation rules | `packages/dashboard-web/src/lib/runway-display.ts` |

`capacity-runway.ts` is the single module the last change created so that
improvements propagate. Its `estimateWindowExhaustion()` is now the only
implementation of "when does this window hit 100%", consumed by the accounts
progress bars (`RateLimitProgress.tsx`), the pool at-risk list (`pool-usage.ts`),
the dashed forecast lines (`usage-forecast.ts`) and the runway. **Keep it that
way** — the whole point of the previous change was deleting three verbatim
copies of `((100 - pct) / pct) * elapsed`.

### The current algorithm, precisely

`computeUsagePrediction()` is an **unweighted ordinary least-squares fit** of a
straight line to (time, utilization) pairs, time rescaled to hours and centred on
the segment's first point:

```
slope      = (n·Σxu − Σx·Σu) / (n·Σxx − (Σx)²)      x = (t − t₀)/3.6e6,  u = percent
etaExhaust = lastSample.t + (100 − currentPct)/slope hours
```

Everything else in that file is preprocessing:

- **Segmentation** at the last boundary — `resets_at` changing by more than
  `RESET_JITTER_TOLERANCE_MS` (60 s), **or** a drop greater than
  `RESET_DROP_THRESHOLD` (5 points).
- **Idle filtering** — when a current reset is known, points with
  `resetsAt == null` are dropped (including them flattened the slope ~10×).
- **Confidence gate** — `MIN_POINTS` 3, `MIN_SPAN_MS` 5 min, else
  `insufficient_data` / `lowConfidence`.

There is no weighting, no smoothing, no seasonality, and no uncertainty
estimate. The only fallback — used by every non-Anthropic/Codex provider and
every scoped-weekly window — is a **lifetime average**:
`(100 − pct)/pct × elapsed`.

### Two anchoring conventions that must not be conflated

This bit is load-bearing and was a review finding:

- `prediction.etaExhaustMs` is **sample-anchored** — computed inside
  `computeUsagePrediction` from the newest sample's timestamp. The progress-bar
  message consumes it **verbatim**. Recomputing it as `now + headroom/slope`
  makes the projected exhaustion drift 30 s further out on every UI tick between
  refetches.
- The forecast chart is deliberately **now-anchored** via a virtual window origin
  (`startMs = now - pct/slope`) so the dashed line meets the solid one. That
  anchoring stays in `usage-forecast.ts`; it is rendering, not estimation.

`estimateWindowExhaustion()` returns the sample-anchored ETA plus the raw slope,
so each consumer can pick. Do not "unify" them.

---

## 2. The data

### `usage_snapshots` — what prediction currently reads

```sql
CREATE TABLE usage_snapshots (
  account_id TEXT NOT NULL,
  provider TEXT,
  sampled_at INTEGER NOT NULL,
  five_hour_pct REAL, five_hour_reset INTEGER,
  seven_day_pct REAL, seven_day_reset INTEGER,
  PRIMARY KEY (account_id, sampled_at)
)
```

- Written every **120 s** (`SAMPLE_INTERVAL_MS`, `usage-snapshot-sampler.ts:58`).
- **154,262 rows over ~82 days** as of 2026-08-23.
- **anthropic and codex only** — the sampler filters to those two providers
  (`usage-snapshot-sampler.ts:329`).
- Retention is `usage_snapshot_retention_days: 3650`, i.e. effectively forever.
  Good — that is what makes backtesting possible.
- Lookback fed to the fit: **6 h** for the 5-hour window, **24 h** for the weekly
  (`build-account-predictions.ts:9-10`). A live point at `t = now` is appended so
  the fit does not lag the sampler.

**The percent is integer-quantised.** Verified against the live DB: the 5-hour
column only ever holds 0, 1, 2, 3, 4, 5, … On a 5-hour window one unit is
**3 minutes of headroom**. With `MIN_POINTS = 3` over a 5-minute span, the slope
is frequently being fitted to three identical integers. This is the single
biggest source of noise in the current estimate and it motivates item 2 below.

### `requests` — the signal we already record and do not use

**581,714 rows, 2026-05-13 to 2026-08-23**, carrying `timestamp`,
`account_used`, `model`, `requested_model`, `input_tokens`, `output_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`, `total_tokens`,
`cost_usd`.

This is the *cause* of utilization, at full resolution, recorded per request.
Utilization is a lagging, quantised, 2-minute-polled *view* of it.

### Ground truth for scoring predictions

- **2,080 rows with `status_code = 429`** in `requests`.
- `accounts.rate_limit_*` columns (`rate_limited_until`, `rate_limited_at`,
  `rate_limited_reason`, `consecutive_rate_limits`) — note `rate_limited_at` is
  currently NULL for all accounts, so it is a live-state column, not a history.
  **The 429 rows in `requests` are the durable record**; treat those as truth.
- Snapshots crossing 100% are also truth for "this window actually ran out".

---

## 3. Work item 0 — the backtest harness (do this first)

**Why first:** there is currently **no accuracy metric of any kind**. Every
constant in the estimator — the 6 h/24 h lookbacks, `MIN_POINTS`, `MIN_SPAN_MS`,
`RESET_DROP_THRESHOLD`, and the UI's `CERTAIN_MARGIN_FRACTION = 0.1` — was
chosen by intuition. Without a scoring harness, items 1–7 are unfalsifiable: you
cannot tell an improvement from a regression, and neither can a reviewer.

### What to build

A **pure, offline replay harness**, not a service. Suggested home:
`packages/core/src/prediction-backtest.ts` (pure scoring functions, unit-tested)
plus a runner script under `scripts/` that reads the live DB read-only.

Design constraints:

1. **Pure core.** The scoring functions take arrays in and return metrics out,
   with no DB or clock access, exactly like `computeUsagePrediction`. The script
   does the I/O. This is what makes the harness itself testable.
2. **Read-only DB access.** Open with `{ readonly: true }`. The production DB is
   ~9.6 GB and live; never write to it from the harness.
3. **Point-in-time honesty.** For a prediction made at time `T`, feed the
   estimator only rows with `sampled_at <= T`. Leaking future rows is the classic
   backtest bug and it will make everything look excellent.

### The evaluation loop

For each account, each window (`five_hour`, `seven_day`), and each candidate
prediction instant `T` (step through history at, say, 10-minute intervals):

1. Build the input series from snapshots `<= T` using the same lookback the
   production path uses.
2. Run the estimator, get `etaExhaustMs` (or "will not exhaust").
3. Find the **actual** outcome from rows `> T` in the same window segment: the
   first `sampled_at` where `pct >= 100`, or the window reset if it never got
   there.
4. Score.

### Metrics that matter

Report all of these; a single number will hide the interesting failures.

- **Directional accuracy** — did we correctly predict exhaust-before-reset vs
  not? This is what the UI's red/amber and the runway's `beyond-horizon` actually
  turn on. Report as a confusion matrix, not an accuracy percentage: the classes
  are heavily imbalanced and 95% accuracy is achievable by always saying "safe".
- **Signed error on the ETA**, in minutes and as a fraction of the window length,
  for the cases that did exhaust. Report the *distribution* (median, p10, p90),
  not the mean — a few wild extrapolations will dominate a mean.
- **Bias** — is the estimator systematically early or late? Expect "late" after
  idle and "early" after a burst, given the lifetime-average fallback.
- **Error vs lead time** — accuracy 20 minutes out is meaningless if the number
  is shown 3 days out. Bucket by how far ahead the prediction reached.
- **Coverage** — what fraction of instants produced any usable prediction at all
  (`insufficient_data` / `lowConfidence` rate). An estimator that refuses to
  answer is not accurate, it is absent.

### Baselines to beat

Score these alongside any new estimator, or improvements will look better than
they are:

1. **Lifetime average** — `(100 − pct)/pct × elapsed`, the current fallback.
2. **Current OLS** — the shipped estimator, unchanged.
3. **Naive persistence** — "the next hour looks like the last hour".

A change is only an improvement if it beats all three on the metrics above, on
held-out data.

### Deliverable

- The harness plus unit tests for the scoring functions.
- A committed **baseline report** (markdown or JSON under `docs/` — not the DB)
  recording current accuracy for all three baselines. That report is the
  reference every subsequent item is measured against.
- Do **not** wire the harness into the running service. It is a development
  tool; it must never run on the request path.

---

## 4. Work items 1–7

Numbered as in the original analysis. Item 0 above is the prerequisite for all
of them.

### Item 1 — model load redistribution (largest runway error)

`computeCapacityRunway` treats each account's slope as **fixed and independent**,
then asks when all the countdowns overlap. But when account A runs dry, its
traffic fails over to B, so B's burn *accelerates*. Independent countdowns
therefore **systematically overestimate** pool runway — the metric is
optimistic exactly when it matters.

The correct model: total pool demand is roughly invariant and drains whichever
accounts are alive. Solve for when cumulative demand exceeds total remaining
headroom, respecting each window's reset schedule.

Notes:

- Demand should come from the request ledger (item 2), not from summing per
  account slopes — the whole point is that the per-account split changes.
- Interacts with routing: `packages/proxy/src/handlers/pool-liveness-gate.ts`
  deliberately reserves a tail so an account survives as failover. A redistribution
  model must not assume traffic moves purely by FEFO.
- The existing dead-interval/event-scan structure in `capacity-runway.ts` can
  stay; what changes is how each account's burn rate is derived and that it
  becomes state-dependent rather than constant.
- Validate with the harness at the *pool* level: predict when the pool had no
  live account, compare against history.

### Item 2 — predict from the request ledger, not the polled percent

We do not know Anthropic's token→percent weighting, but it can be **learned**:
regress Δ`five_hour_pct` / Δ`seven_day_pct` between consecutive snapshots against
tokens consumed by that account in that interval, split by model family. There
are ~154k snapshot pairs and ~581k requests to fit on.

Output: per-model percent-per-token coefficients. Then
`burn = Σ(tokens_per_hour_by_model × coefficient_by_model)`, which:

- updates per request instead of per 120 s,
- is immune to the 1% quantisation,
- keeps working when the usage endpoint is unreachable,
- makes burn attributable by model and by client API key.

Cautions:

- Cache reads/writes are priced differently from fresh input tokens — keep
  `cache_read_input_tokens` and `cache_creation_input_tokens` as separate
  regressors, do not fold them into `input_tokens`.
- The coefficient is not stable across plan tiers; `accounts.identity_rate_limit_tier`
  (e.g. `20x`, `5x`) is likely a needed feature.
- **This must not silently become the routing input.** Routing reads
  `CapacitySignal` from the provider's own numbers. A learned model is a
  projection; per `references/routing-gates.md`, display is a projection and must
  never feed routing. If you ever want it in routing, that is a separate,
  explicitly-gated decision.
- Preserve the null-means-unknown invariant: no evidence ⇒ `null`, never `0`.

#### Measured outcome (2026-08-24)

**Not feasible with the currently recorded data.** A dedicated feasibility study
— committed at `docs/ledger-burn-feasibility.md`, reproducible read-only with
`bun scripts/ledger-feasibility.ts` — asked the prior question this item skips:
can snapshot percent-deltas be *causally attributed* to ledger tokens at all?
**Every evaluated group failed its capability matrix**, so no coefficient fit
was attempted and nothing landed in the estimator.

- **`anthropic` / `five_hour` — FAIL on the aggregate relation.** The selected
  cell (lag 0, 10-minute bins) scored an evaluation R-squared of **0.522**,
  which does clear the 0.5 threshold, and was then refuted by two measured
  checks. The future-token placebo — tokens drawn from an interval lying wholly
  *after* the bin — scored **0.388**, a margin of **0.134** against the
  pre-declared **0.15**; and the R-squared did not plateau across a contiguous
  run of adjacent lags (1 lag cleared the threshold, 2 were needed). A relation
  a placebo nearly reproduces is not attribution.
- **`anthropic` / `seven_day` — FAIL, and by more.** Evaluation R-squared
  **0.236**, below the threshold outright, with the future-token control beaten
  by only **0.058** and **zero** contiguous lags clearing.
- **`codex` / `seven_day` — FAIL on structure rather than on fit.** **0.0%** of
  its clean-bin token mass resolves to any model family (**3.13 billion** tokens
  unresolved — `getModelFamily` recognises Claude slugs only), and it is a
  **single account**, so the account-permutation placebo cannot even be run.
  Its aggregate relation is therefore *insufficient evidence*, never a pass,
  whatever the 0.550 R-squared looks like.
- **`codex` / `five_hour` — excluded.** OpenAI retired that window on
  2026-07-12; there is no consumed quota to correlate tokens against.

**Why the recorded data cannot answer it**, in the order the limits bite:

- The utilization percent is **integer-quantised and polled every 120 s**, so it
  cannot resolve short-horizon burn. On the weekly window **49.7%** of clean
  10-minute bins that carry tokens show **no percent movement at all** (codex:
  50.2%). Roughly half the evidence is a zero that means "less than one point",
  not "no burn".
- **Snapshot sample times lag their cache reads**, and **request timestamps are
  terminal-persist times** — when the row was written, not when the tokens were
  charged. That is why lag was swept at all; at every group the best cell was
  still lag 0, with R-squared decaying monotonically as lag grew.
- **Keepalive and auto-refresh burn is deliberately unrecorded**, so the ledger
  is known to be incomplete by construction. Separately, the study bounds how
  much percent movement the ledger fails to explain at all: **1.0–6.1%** of
  positive percent mass per group sits in clean bins with no ledger tokens
  whatsoever. That is a *lower* bound on all ledger-unexplained positive percent
  mass whatever its cause — timing misalignment and other omissions are
  indistinguishable from unrecorded spend here — and a lower bound because a bin
  whose ledger explains part of its rise counts as matched.

**What IS in place.** The study tool is the durable deliverable:
`packages/core/src/ledger-feasibility.ts` holds the pure analyses (no DB, no
clock, unit-tested), `scripts/ledger-feasibility.ts` is the read-only runner,
and the report is byte-deterministic for a frozen range — no generation
timestamp, no run durations, and no live account values in the artifact (the
runner still reads them and prints them to stderr). Byte-identity holds for
unchanged in-range history *and* identical CLI flags: the reproduce command is
embedded in the report, so a different `--out` changes the bytes. It carries
blocked cell selection (the (lag, width, anchor) cell is chosen on an early
selection block, and the metrics that drive the verdict come from a disjoint
later evaluation block, with the selection-block scores and range diagnostics
still disclosed in the report), both mandatory
placebo controls (future tokens, seeded account permutation), clean-cohort
construction (reset-lifecycle splitting, pro-rated straddling deltas,
refund / saturation / overage exclusion) and a per-group capability matrix whose
thresholds are declared ahead of the numbers.

One result is genuinely positive: **the family-by-token-class design matrix is
fully identifiable on anthropic data** — rank **16 of 16** active columns,
condition number **~8** against a 10,000 ceiling, no column pair correlated
above 0.9. Keeping `input` / `output` / `cache_read` / `cache_creation` separate
per family is not the problem. If attribution were ever solved, the coefficient
fit itself would be well-posed.

**What would change the answer** — entry requirements for any retry, in priority
order:

1. **Higher-resolution or fractional utilization sampling**, or provider-side
   token accounting. This is the leading observability prerequisite for the
   weekly windows, where half the token-bearing bins read zero. It is not the
   only one: the `anthropic` / `five_hour` group fails on the placebo margin and
   the missing lag plateau even at **15.4%** silent bins. The requirements
   below are independent capability gates, not consequences of this one.
2. **Request start or charge timestamps** rather than terminal-persist times, so
   a lag sweep measures a physical delay instead of a persistence artefact.
3. **Recording synthetic keepalive/refresh spend**, so completeness becomes a
   measured quantity instead of a bound.
4. **A non-Claude model-family resolver**, without which codex token mass has no
   *family-resolved* design matrix suitable for the per-family coefficients this
   item proposes — its tokens all land in the unresolved-family columns, which
   measured rank **3 of 3** at condition **2.078**.
5. **Tier history.** The schema records no historical tier, so the pooled
   single-price assumption is unverifiable (schema work — item 7 territory).
6. **More than one Codex account**, so the account-permutation control can run.

Re-run the committed study after any of these. Its thresholds are pre-declared
and its report is frozen per range, so a later run is a comparison rather than a
fresh hunt for a cell that scores well.

**Progress on requirements 1–3 (2026-08-24).** The proxy now captures the
request-aligned utilization series into `unified_claim_observations`: one row
per claim (`5h`, `7d`, scoped windows such as `7d_oi`) per Anthropic response,
carrying the reported utilization, the claim status, the claim's own reset, the
HTTP status, the request start time and the headers-arrival time. Keepalive and
auto-refresh dispatches are captured too, tagged by `source`, so synthetic spend
is visible where the ledger has it excluded. Capture only — nothing reads the
table yet.

What it does and does not change for a re-run:

- Utilization arrives at the provider's own precision on the response rather
  than through a 120 s poll, and it arrives once per request instead of once per
  tick. Whether that resolves the silent-bin problem is a measurement, not an
  assumption: the header may be quantised at the source too.
- `request_started_at` is stored per observation, so a lag sweep can be run
  against request start instead of terminal-persist time.
- Retention is a FIXED 90 days
  (`UNIFIED_CLAIM_OBSERVATION_RETENTION_MS`), independent of the request and
  usage-snapshot controls. Observations and `requests` rows therefore age out on
  different clocks, so any analysis joining them must MEASURE its join coverage
  over the range it uses rather than assume the two tables span it equally.
- The feasibility re-run waits on data accumulating — the table starts empty at
  the deploy that lands it.

**Consequence for item 1.** Item 1 (pool load redistribution) was planned to
take its demand figure from this model, and that prerequisite is gone for now.
Re-plan it against per-account slopes — the ones `estimateWindowExhaustion`
already produces — or defer it until one of the entry requirements above is met.
Do not build it on a ledger-derived demand model the data cannot support.

### Item 3 — weight recent evidence

The fit is unweighted, so a reading from 6 hours ago counts as much as one from
30 seconds ago. Replace with **exponentially-weighted least squares** (weight
`exp(-(t_now - t)/τ)`, τ ≈ 30–60 min for the 5-hour window), or **Theil–Sen** if
outlier robustness matters more than smoothness.

Smallest, most contained change of the seven — it lives entirely inside
`computeUsagePrediction`. Tune τ with the harness rather than by taste.

#### Measured outcome (2026-08-23)

**Tried and rejected.** Item 3 was implemented behind the item-0 harness,
tuned on the tuning range and scored on the held-out range. It **failed the
pre-declared acceptance gate**, so no estimator change landed:
`computeUsagePrediction` is still unweighted OLS.

τ was locked on the tuning range at **15 min** for `five_hour` and **24 h** for
`seven_day`. On the held-out common cohort:

- **`five_hour`** — EWLS-15m scored F1 **0.186**, against **0.202** for naive
  persistence and **0.195** for the lifetime average. Median absolute ETA error
  was **32.8 min**, against **20.0 min** for unweighted OLS.
- **`seven_day`** — EWLS-24h scored F1 **0.625**, against **0.715** for the
  lifetime average. Median absolute ETA error was **1515.8 min**, against
  **1507.7 min** for OLS.
- Account-grouped bootstrap CIs on the F1 delta **straddle zero** against OLS on
  both windows, and point **negative** against the best baseline on both. So the
  weighting is not merely unproven, the point estimate is the wrong sign.

The EWLS code itself was **not kept** — the committed harness CLI has no τ
flags. A re-attempt should start from the committed harness plus these numbers,
not from scratch and not from the assumption that recency weighting helps.

Note what the same run says about item 4: on held-out data the **lifetime
average was the strongest weekly estimator** and **naive persistence the
strongest 5-hour one**. Two different estimators won the two horizons, which is
direct evidence for splitting them.

### Item 4 — a different estimator per horizon

The 5-hour and weekly windows currently get the same regression with only the
lookback changed (6 h vs 24 h). They answer different questions:

- **5-hour** = "will this burst hit the rate limit" → recent slope is right.
- **Weekly** = "will the budget last" → the right estimator is average daily
  consumption with day-of-week seasonality, **not** an instantaneous slope.
  Extrapolating a burst slope across seven days is why weekly projections swing.

There are 82 days of history to fit a weekly profile on. Read
`references/routing-gates.md` § "The 5h window is a throttle NESTED inside the
weekly budget" before designing this — the distinction between a *rate* limit and
a *budget* is the whole reason the two need different estimators, and misreading
it has caused two reverted features already.

#### Measured outcome (2026-08-23)

**Half landed.** The premise held: the two horizons do want different
estimators, and the winners on them differ. What did not hold is that a
purpose-built estimator would be either winner. Six candidates were added to
the item-0 harness — endpoint-segmented lifetime averages at 30 min / 1 h / 2 h,
OLS over a 1-hour lookback, trailing 3-day and 7-day daily-consumption
averages, and a day-of-week seasonal profile — and on the tuning range **all six
lost to a baseline on their own horizon**:

- **`five_hour`** — naive persistence won at selection F1 **0.413**, against
  **0.412** for `endpoint-seg-1h`, **0.411** for `endpoint-seg-30m`, **0.409**
  for `ols-1h` and **0.395** for `endpoint-seg-2h`. The first three sit inside
  0.004 of the winner, i.e. inside the noise of a metric whose account-grouped
  CI is roughly ±0.05 wide. Segmenting on the endpoint changes almost nothing
  because on this horizon there is rarely more than one segment to segment.
- **`seven_day`** — the lifetime average won at selection F1 **0.604**, against
  **0.554** for `trailing-3d`, **0.504** for `dow-seasonal` and **0.440** for
  `trailing-7d`. The last two also failed the error and coverage criteria, not
  just F1: fitting a daily profile needs days of history inside the current
  window, so they abstain on 20–27% of instants, and a "how much does this
  account usually burn on a Tuesday" answer is not the same answer as "how far
  into THIS window is it".

Both winners were therefore **baselines**, and each went to its own held-out
gate:

- **`five_hour` naive — FAILED.** F1 **0.200** against **0.180** for OLS, but
  median absolute ETA error **43.1 min** against **20.0 min**. Naive persistence
  buys a slightly better run-out/no-run-out call by more than doubling the error
  on the number the UI actually prints. The 5-hour display path **keeps OLS**,
  unchanged.
- **`seven_day` lifetime — PASSED.** F1 **0.691** against **0.600** for OLS,
  median absolute ETA error **1176 min** against **1508 min**, coverage equal,
  and — the criterion that decides what a user actually sees — precision of the
  display's own red rule **0.674** against **0.632**. It won on every axis at
  once.

The weekly result **landed** (see `capacity-runway.ts` and
`build-account-predictions.ts`): the server no longer fits a weekly regression
at all, and the weekly display path reads the lifetime average as its PRIMARY
estimator rather than as a fallback. That took a second change, because the
lifetime average is capped at amber everywhere it appears: `estimateWindowExhaustion`
gained a caller-supplied per-window `lifetimeConfidence` policy, and the
account-wide weekly window is the only window declared `"full"`. Red on that
window now comes from the ordinary `CERTAIN_MARGIN_FRACTION` rule, the same one
the 5-hour regression goes through.

Read the win with its uncertainty: the **account-grouped bootstrap CI on the F1
delta straddles zero** — `[-0.048, +0.089, +0.247]` over 6 accounts. The point
estimate has the right sign and every secondary criterion agrees with it, which
is why it was accepted, but 6 accounts cannot make that interval narrow. This is
a display change only; the **routing-side weekly burn slope is untouched**, and
a re-measurement on more accounts is free to reverse it.

One thing in the regenerated report needs reading carefully before anyone cites
it. On the HELD-OUT weekly range `trailing-7d` scores F1 **0.711** and passes
all three gate criteria — better than the lifetime average's 0.691 — and the
report says so in as many words ("the in-range ranking would have picked
trailing-7d; the winner stays locked to lifetime from Tuning range"). That is
not a missed opportunity, it is the protocol working: `trailing-7d` was the
WORST weekly candidate on the tuning range (F1 0.440, coverage 79.9%), and
promoting it on a held-out score is precisely the peeking the split exists to
prevent. Its two ranges disagree by 0.27 F1, which is itself evidence that its
score is unstable rather than that it is good.

So no plumbing follow-up is warranted for the trailing and seasonal candidates
yet. They need more than 24 h of weekly history at prediction time, and the
server refresh path queries a 24 h lookback, so landing one means widening that
query first. If someone wants to reopen this, the honest route is a fresh
tuning/held-out split over a longer range where `trailing-7d` can win the
SELECTION — not a citation of the number above.

### Item 5 — emit uncertainty instead of a boolean

`lowConfidence` is just "span < 5 minutes". OLS already yields residual variance
→ standard error on the slope → a **prediction interval** on the exhaustion time.

Benefits:

- Replaces the ad-hoc `CERTAIN_MARGIN_FRACTION = 0.1` red/amber rule in
  `format-prediction.ts` with something derived.
- Lets runway render "3d 4h ± 9h" honestly instead of a false-precision figure.
- Gives the `≥` lower-bound prefix in `runway-display.ts` a principled sibling.

Keep `lowConfidence` in the type during migration so consumers can be moved one
at a time.

### Item 6 — extend snapshots beyond anthropic/codex

`usage_snapshots` covers only those two providers, so **every other provider is
stuck on the lifetime average**, which averages in idle time and is biased low
after a burst and high after idle. Widening the sampler filter at
`usage-snapshot-sampler.ts:329` upgrades the worst estimator path for everyone.

Requires care: other providers have different window shapes (`zai` has
`tokens_limit` but no weekly; `alibaba-coding-plan` has both; `ollama` has
neither). `pool-usage.ts` already encodes which providers report which window via
`FIVE_HOUR_ELIGIBLE_PROVIDERS` / `SEVEN_DAY_ELIGIBLE_PROVIDERS` — reuse those
sets rather than inventing a second list.

### Item 7 — store what is currently thrown away

`usage_snapshots` holds only the two account-wide windows. Not stored:

- **scoped per-family weekly windows** (`limits[weekly_scoped]`) — so family
  weekly runway cannot be computed historically at all, and the family
  reservation gate (`family-reservation-gate.ts`) has no trend data.
- **`extra_usage`** — overage/purchased credits, which is *resetless* and
  therefore a permanent constraint once it binds.
- the account-wide vs `seven_day_oauth_apps` distinction.

Adding columns here is a **schema change**: read `.claude/skills/db-migrations/`
first. There is a two-step requirement (`CREATE TABLE` **and** an
`ADDITIVE_COLUMNS` entry) whose omission fails silently on every existing live
database. There is a live example of exactly that bug in this repo right now —
see the known issue below.

---

## 5. Constraints and traps

- **This checkout is the live deployment.** `/home/darken/clankermux` is what
  `clankermux.service` runs, rebuilt from the working tree on every restart. Do
  non-trivial work in a worktree (`EnterWorktree`); never `git checkout` /
  `reset` / `stash` in the live checkout. See `CLAUDE.md`.
- **Never curl the Anthropic endpoint**, directly or through the proxy on the
  `claude` account. Test with a non-Anthropic account and force-route via
  `x-clankermux-account-id`.
- **No env-var feature gates.** Inline named constants only.
- **`null`, never `0`, on absent evidence** — for utilization, capacity signals
  and slopes alike. A `limits[]`-only payload once collapsed to `0`, was read as
  "plenty of headroom", and falsely cleared a live cooldown.
- **The dashboard must never render a fallback `0`** for a failed read; use the
  `unavailableReason` → em-dash path. `MetricCard`'s precedence is
  `unavailableReason` → `loading` → resolved.
- **Display never feeds routing.** Report the *cause*, not the *mechanism*.
- **Run the deploy build before landing** — `bun run build`, not just lint /
  typecheck / test. The dashboard bundle is a systemd `ExecStartPre`; a change
  can pass every test and still be unable to start.
- **`bun test` file count is the tell.** A fresh worktree needs
  `bun install --frozen-lockfile` and
  `bun packages/database/scripts/build-workers.ts --placeholders-only`, or whole
  test files fail to load silently. Expect **~442 files**; far fewer means the
  inline DB worker placeholders are missing.

### Known pre-existing failures (not yours, do not "fix" in passing)

1. `scripts/build-readme-media.test.ts` → "is referenced by the README through a
   closed `<picture>`, not a bare `<img>`" **fails on `main`**. Cause: bare
   `<a href="docs/media/…">` links in a README table. Unrelated to prediction.
2. `api_keys` has **no `ADDITIVE_COLUMNS` entries**, so a database whose
   `api_keys` table predates 2026-06-09 never gains `pinned_account_id` /
   `pinned_providers`, while every repository lookup SELECTs them — meaning
   authentication itself would fail on such a database. This deployment's DB is
   unaffected (its table already has both columns). Relevant to item 7 as a
   worked example of the migration trap.

---

## 6. Suggested order and rationale

1. **Item 0, the backtest harness.** Nothing else is verifiable without it.
   Land the baseline report before touching the estimator.
2. **Item 3, recent-evidence weighting.** Smallest change, contained in one
   function, immediately measurable against the new baseline. Use it to prove the
   harness works end to end.
3. **Item 2, the request-ledger model.** The big accuracy win, and a prerequisite
   for item 1's demand model.
4. **Item 1, load redistribution.** The big *correctness* win for runway
   specifically. Needs item 2's demand figure to be worth doing.
5. **Item 4, per-horizon estimators**, and **item 5, uncertainty** — both benefit
   from having a scoring harness and a better burn signal already in place.
6. **Items 6 and 7, data coverage.** Independent of the rest; can be done at any
   point, and item 7 is a schema change so budget time for the migration skill.

Items 3, 4 and 5 are contained in `packages/core/src/capacity-runway.ts` and
`usage-prediction.ts`. Items 1 and 2 are architectural. Items 6 and 7 touch the
sampler and the schema.
