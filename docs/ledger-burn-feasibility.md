# ClankerMux request-ledger burn-model feasibility

Study range: `[2026-06-02T12:48:00.294Z, 2026-08-23T00:00:00.000Z)`. This report carries no generation timestamp and no run durations: it is a pure function of that frozen range, the seed and the recorded history, so an unchanged history reproduces it byte for byte.

Reproduce with:

```
bun scripts/ledger-feasibility.ts --out=docs/ledger-burn-feasibility.md
```

| config | value |
|---|---|
| anchors | terminal,start |
| candidateLagsMinutes | 0,2,4,6 |
| cells | 36 |
| controlFutureOffsetsMinutes | 2,4 |
| from | 2026-06-02T12:48:00.294Z |
| seed | 20260823 |
| selectionBlockEnd | 2026-07-15T00:00:00.000Z |
| to | 2026-08-23T00:00:00.000Z |
| widthsMinutes | 2,5,10 |

## Dataset

Every figure below counts only rows inside the study range. The database is live and keeps growing past the range's end; whole-table bounds would describe history this study never read and would change the artifact on every run.

| field (within the study range) | value |
|---|---|
| usage_snapshots rows | 153,086 |
| requests rows | 483,453 |
| accounts | 6 |
| providers | anthropic, codex |
| first snapshot | 2026-06-02T12:48:00.294Z |
| last snapshot | 2026-08-22T23:59:31.793Z |
| first request | 2026-06-02T12:48:01.384Z |
| last request | 2026-08-22T21:43:04.113Z |
| keepalive-active periods | 0 |

Selection block: `[2026-06-02T12:48:00.294Z, 2026-07-15T00:00:00.000Z)`  
Evaluation block: `[2026-07-15T00:00:00.000Z, 2026-08-23T00:00:00.000Z)`

## Methodology

- **This is a feasibility study, not an estimator.** Nothing here is wired into
  the server, no coefficient produced here is used to predict anything, and the
  fitted slopes exist only so a ratio can be compared with the same ratio in
  another era.
- **Bins live inside one reset lifecycle.** The snapshot series is split at
  `isResetBoundary` before anything is measured. A bin touched by two
  lifecycles straddles a reset and is DISCARDED, never averaged across.
- **Percent mass and token mass come from the same interval.** The accepted
  deltas of `withinWindowDeltas` (no gap wider than 15 minutes, positive
  elapsed time) define the observed sub-intervals. A request counts only if
  BOTH its unshifted anchor time and its lag-shifted time fall in accepted
  sub-intervals of the same lifecycle segment, so a sampling outage can never
  become a bin with tokens and no rise, and a lag can never import tokens that
  were physically spent inside a rejected gap.
- **Straddling deltas are pro-rated.** A delta overlapping two bins contributes
  its percent and its milliseconds to each in proportion to the overlap. At a
  2-minute width a whole sampler tick is a whole bin, so assigning it to the bin
  it happened to end in would be a systematic misattribution.
- **Half-open, upper-closed.** Both the observed intervals and the bins are
  `(from, to]`. A request stamped exactly on a delta's closing endpoint
  therefore lands in the bin that delta's percent went to.
- **Clean cohort.** A bin counts toward the primary metrics only with at least
  50% observed coverage AND no contamination flag: a refund (a negative delta),
  saturation (an endpoint at or above 100%, where the meter stops moving), or an
  `overage`-billed request (which spends purchased credit, not window quota).
  Contaminated and low-coverage bins are COUNTED and reported, never silently
  dropped, and they do not count toward the group's exposure floor either — the
  floor is clean-cohort milliseconds only.
- **Blocked selection.** The (lag, width, anchor) cell is chosen on an early
  selection block and every reported number comes from a disjoint later
  evaluation block. A sweep scored and reported on the same data finds its best
  cell whether or not a relation exists. A bin belongs to a block only when the
  bin interval AND the interval its tokens were drawn from (the unshifted anchor
  times, so the bin shifted back by the lag) lie wholly inside that block —
  which also means wholly inside the study range, since no request outside the
  range was loaded. Boundary bins that would need requests from the other block,
  or from before the range's start or after its end, are dropped from both and
  COUNTED. Without the first half a positive lag would let evaluation-block bins
  ingest selection-block tokens and the split would leak; without the second a
  future-token control at the range's end would be scored on bins whose token
  mass was silently truncated to the requests that happened to exist.
- **Controls decide validity before magnitude.** Two mandatory controls, and a
  cell that does not beat BOTH by 0.15 R-squared is INVALID no matter how high
  it scores:
  - **Future tokens.** The control lag is `-(width + offset)` for offsets of 2
    and 4 minutes, so a control bin's tokens come from an interval lying WHOLLY
    after the bin, by at least the offset. A fixed small negative lag would not
    do: at a 10-minute width, a lag of -2 minutes still overlaps 8 of the bin's
    own 10 minutes, so most of that "future" is the bin's own present and the
    control scores nearly what the real cell does — a margin manufactured by
    construction rather than measured.
  - **Account permutation.** Each account's token series is fitted against a
    DIFFERENT account's percent series under a seeded derangement (no account is
    ever paired with itself), joined on IDENTICAL bin edges so both series
    describe the same wall-clock intervals. Its margin is the one it carries
    itself: the treatment is refitted over exactly the bins the join kept, so
    treatment and placebo differ only in the pairing and not in which bins each
    saw. The unit is the account because the question is whether tokens explain
    THIS account's percent; shuffling individual bins would also destroy each
    series' own autocorrelation and so test a much weaker null.
  Only controls at the SELECTED cell's width AND anchor are compared against it:
  a control at another width bins the same history at a different quantisation
  and is not the same experiment. A control that produces NO number is not a
  beaten control — it leaves ITS OWN question open, so a cell that clears
  everything else is INSUFFICIENT EVIDENCE rather than a pass.
- **A measured failure outranks an unmeasurable control.** The cell verdict is
  read in one order: no evaluation score at all is insufficient evidence; then
  any MEASURED refutation — a control that has a number and was not beaten by
  it, an evaluation R-squared below the threshold, a failed stability check —
  is a FAIL; and only if nothing measured failed does an unmeasurable mandatory
  control make the answer insufficient evidence. The other order would let a
  placebo that could not be run turn a refutation into "we do not know".
- **No intercept.** A bin with no tokens must predict no rise. An intercept
  would absorb exactly the unexplained baseline burn the study is looking for.
  The R-squared is therefore UNCENTERED and is not comparable with a centred
  one.
- **Pooling.** Bins from every account in a group are pooled into one fit,
  which assumes a single percent-per-token price across the group. The account
  concentration table shows whether one account is carrying that number;
  whether the accounts' plan tiers even agreed over the range is not recoverable
  from the recorded history at all, which is what tier provenance says.
- **`null` is not zero.** Every statistic below a minimum is `null` and
  every table renders it as an em-dash. A `null` never passes a criterion.

## Era boundaries

| boundary | at | provenance |
|---|---|---|
| 2026-07-20 boundary | 2026-07-20T00:00:00.000Z | Declared constant. |
| 2026-07-21 boundary | 2026-07-21T00:00:00.000Z | Declared constant. |
| August usage-persistence cutover | 2026-08-13T08:48:59.000Z | Commit time of merge `478440d3` (inline collector becomes the sole usage writer, v2026.8.21). COMMIT time is a proxy for DEPLOY time: this checkout is the live deployment and rebuilds from the working tree on restart, so the deploy followed the commit by an unrecorded interval. |

## Capability matrix

| group | verdict | criterion | result | numbers |
|---|---|---|---|---|
| anthropic / five_hour | FAIL | group eligibility | PASS | 162863 equivalent 2-minute bins of CLEAN-cohort exposure (floor 1000); 20064 usable bins of 20421 at the selected cell on the evaluation block. |
| anthropic / five_hour | FAIL | aggregate relation | FAIL | evaluation R2 0.522 (threshold 0.5) over 20064 clean bins, 3267 of them positive-signal; cell selection fail: The selected cell scored 0.522 on the evaluation block and was refuted by 2 measured checks: a control that WAS measured was not beaten by 0.15, so the signal is INVALID regardless of magnitude; the cell did not hold across both anchors and a contiguous run of lags. |
| anthropic / five_hour | FAIL | family resolution | PASS | 100.0% of clean-bin token mass resolves to a Claude family (floor 90%); 0 tokens are unresolved. `getModelFamily` recognises Claude slugs only. |
| anthropic / five_hour | FAIL | class identifiability | PASS | rank 16 of 16 active columns, condition number 7.989 (maximum 10000); 0 column pairs have an uncentered correlation above 0.9. |
| anthropic / five_hour | FAIL | completeness bound | PASS | 1.0% of positive percent mass sits in clean bins with NO ledger tokens (ceiling 10%). This is a LOWER BOUND on the ledger's incompleteness: a bin whose ledger explains part of its burn counts as matched. |
| anthropic / five_hour | FAIL | account concentration | PASS | 4.459 effective accounts by inverse HHI (floor 2), largest token share 26.1% (ceiling 60%) over 5 accounts. |
| anthropic / five_hour | FAIL | era stability | INSUFFICIENT EVIDENCE | No boundary had a matched stratum with enough pure bins on both sides. |
| anthropic / five_hour | FAIL | tier provenance (informational) | INSUFFICIENT EVIDENCE | No account has in-range tier provenance: nothing the study read records a plan tier, because neither `usage_snapshots` nor `requests` carries a tier column and the only tier the schema has is a live, mutable `accounts` value with no history. Informational: the pooled fit assumes one price across the group, and a tier difference would break that assumption. |
| anthropic / seven_day | FAIL | group eligibility | PASS | 148842 equivalent 2-minute bins of CLEAN-cohort exposure (floor 1000); 18006 usable bins of 20572 at the selected cell on the evaluation block. |
| anthropic / seven_day | FAIL | aggregate relation | FAIL | evaluation R2 0.236 (threshold 0.5) over 18006 clean bins, 1973 of them positive-signal; cell selection fail: The selected cell scored 0.236 on the evaluation block and was refuted by 3 measured checks: a control that WAS measured was not beaten by 0.15, so the signal is INVALID regardless of magnitude; the evaluation R-squared 0.236 is below the threshold 0.5; the cell did not hold across both anchors and a contiguous run of lags. |
| anthropic / seven_day | FAIL | family resolution | PASS | 100.0% of clean-bin token mass resolves to a Claude family (floor 90%); 0 tokens are unresolved. `getModelFamily` recognises Claude slugs only. |
| anthropic / seven_day | FAIL | class identifiability | PASS | rank 16 of 16 active columns, condition number 7.979 (maximum 10000); 0 column pairs have an uncentered correlation above 0.9. |
| anthropic / seven_day | FAIL | completeness bound | PASS | 3.2% of positive percent mass sits in clean bins with NO ledger tokens (ceiling 10%). This is a LOWER BOUND on the ledger's incompleteness: a bin whose ledger explains part of its burn counts as matched. |
| anthropic / seven_day | FAIL | account concentration | PASS | 4.457 effective accounts by inverse HHI (floor 2), largest token share 26.1% (ceiling 60%) over 5 accounts. |
| anthropic / seven_day | FAIL | era stability | INSUFFICIENT EVIDENCE | No boundary had a matched stratum with enough pure bins on both sides. |
| anthropic / seven_day | FAIL | tier provenance (informational) | INSUFFICIENT EVIDENCE | No account has in-range tier provenance: nothing the study read records a plan tier, because neither `usage_snapshots` nor `requests` carries a tier column and the only tier the schema has is a live, mutable `accounts` value with no history. Informational: the pooled fit assumes one price across the group, and a tier difference would break that assumption. |
| codex / five_hour | INSUFFICIENT EVIDENCE | group eligibility | INSUFFICIENT EVIDENCE | OpenAI retired the Codex 5-hour window on 2026-07-12; the stored `five_hour_reset` advances on every poll while the percent stays 0, so each poll forms its own one-sample window (data-quality note, docs/prediction-backtest-baseline.md). There is no consumed quota to correlate tokens against. |
| codex / seven_day | FAIL | group eligibility | PASS | 34390 equivalent 2-minute bins of CLEAN-cohort exposure (floor 1000); 5264 usable bins of 5318 at the selected cell on the evaluation block. |
| codex / seven_day | FAIL | aggregate relation | INSUFFICIENT EVIDENCE | evaluation R2 0.550 (threshold 0.5) over 5264 clean bins, 655 of them positive-signal; cell selection insufficient-evidence: The selected cell scored 0.550 on the evaluation block and every measured check held, but at least one mandatory control produced no number at all. An unmeasurable control is not a beaten control, so the cell is neither valid nor refuted. |
| codex / seven_day | FAIL | family resolution | FAIL | 0.0% of clean-bin token mass resolves to a Claude family (floor 90%); 3132528922 tokens are unresolved. `getModelFamily` recognises Claude slugs only. |
| codex / seven_day | FAIL | class identifiability | PASS | rank 3 of 3 active columns, condition number 2.078 (maximum 10000); 0 column pairs have an uncentered correlation above 0.9. |
| codex / seven_day | FAIL | completeness bound | PASS | 6.1% of positive percent mass sits in clean bins with NO ledger tokens (ceiling 10%). This is a LOWER BOUND on the ledger's incompleteness: a bin whose ledger explains part of its burn counts as matched. |
| codex / seven_day | FAIL | account concentration | FAIL | 1.000 effective accounts by inverse HHI (floor 2), largest token share 100.0% (ceiling 60%) over 1 accounts. |
| codex / seven_day | FAIL | era stability | INSUFFICIENT EVIDENCE | No boundary had a matched stratum with enough pure bins on both sides. |
| codex / seven_day | FAIL | tier provenance (informational) | INSUFFICIENT EVIDENCE | No account has in-range tier provenance: nothing the study read records a plan tier, because neither `usage_snapshots` nor `requests` carries a tier column and the only tier the schema has is a live, mutable `accounts` value with no history. Informational: the pooled fit assumes one price across the group, and a tier difference would break that assumption. |

## anthropic / five_hour

Bin census at the selected cell (evaluation block):

| bins | usable | low coverage | refund | saturated | overage | keepalive-active | positive signal | equivalent 2-min bins | clean equivalent 2-min bins |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 20421 | 20064 | 163 | 4 | 196 | 0 | 0 | 3267 | 100,936 | 99,701 |

Cell sweep (selection block chooses; evaluation block reports):

| lag (min) | width (min) | anchor | role | selection R2 | selection bins | evaluation R2 | evaluation bins | positive-signal bins |
|---:|---:|---|---|---:|---:|---:|---:|---:|
| 0 | 2 | terminal | candidate | 0.392 | 63541 | 0.343 | 100441 | 9494 |
| 0 | 2 | start | candidate | 0.396 | 63541 | 0.343 | 100441 | 9495 |
| 2 | 2 | terminal | candidate | 0.305 | 63538 | 0.263 | 100439 | 9030 |
| 2 | 2 | start | candidate | 0.328 | 63538 | 0.275 | 100439 | 9200 |
| 4 | 2 | terminal | candidate | 0.238 | 63535 | 0.205 | 100437 | 8255 |
| 4 | 2 | start | candidate | 0.247 | 63535 | 0.210 | 100437 | 8371 |
| 6 | 2 | terminal | candidate | 0.212 | 63532 | 0.190 | 100435 | 7913 |
| 6 | 2 | start | candidate | 0.217 | 63532 | 0.191 | 100435 | 7967 |
| -4 | 2 | terminal | control | 0.332 | 63537 | 0.265 | 100435 | 8738 |
| -4 | 2 | start | control | 0.328 | 63537 | 0.263 | 100435 | 8701 |
| -6 | 2 | terminal | control | 0.295 | 63535 | 0.239 | 100431 | 8390 |
| -6 | 2 | start | control | 0.294 | 63535 | 0.238 | 100431 | 8382 |
| 0 | 5 | terminal | candidate | 0.519 | 25441 | 0.452 | 40179 | 5215 |
| 0 | 5 | start | candidate | 0.526 | 25441 | 0.453 | 40179 | 5207 |
| 2 | 5 | terminal | candidate | 0.447 | 25438 | 0.398 | 40177 | 5051 |
| 2 | 5 | start | candidate | 0.463 | 25438 | 0.406 | 40177 | 5098 |
| 4 | 5 | terminal | candidate | 0.374 | 25438 | 0.334 | 40177 | 4772 |
| 4 | 5 | start | candidate | 0.389 | 25438 | 0.340 | 40177 | 4841 |
| 6 | 5 | terminal | candidate | 0.321 | 25438 | 0.293 | 40175 | 4526 |
| 6 | 5 | start | candidate | 0.328 | 25438 | 0.297 | 40175 | 4572 |
| -7 | 5 | terminal | control | 0.417 | 25437 | 0.349 | 40170 | 4648 |
| -7 | 5 | start | control | 0.411 | 25437 | 0.347 | 40170 | 4622 |
| -9 | 5 | terminal | control | 0.377 | 25437 | 0.327 | 40170 | 4459 |
| -9 | 5 | start | control | 0.374 | 25437 | 0.325 | 40170 | 4448 |
| 0 | 10 | terminal | candidate | 0.623 | 12718 | 0.521 | 20064 | 3272 |
| 0 | 10 | start | candidate | 0.628 | 12718 | 0.522 | 20064 | 3267 |
| 2 | 10 | terminal | candidate | 0.582 | 12715 | 0.490 | 20062 | 3222 |
| 2 | 10 | start | candidate | 0.590 | 12715 | 0.494 | 20062 | 3235 |
| 4 | 10 | terminal | candidate | 0.527 | 12715 | 0.452 | 20062 | 3129 |
| 4 | 10 | start | candidate | 0.537 | 12715 | 0.456 | 20062 | 3148 |
| 6 | 10 | terminal | candidate | 0.468 | 12715 | 0.411 | 20062 | 3021 |
| 6 | 10 | start | candidate | 0.477 | 12715 | 0.415 | 20062 | 3042 |
| -12 | 10 | terminal | control | 0.470 | 12714 | 0.391 | 20055 | 2770 |
| -12 | 10 | start | control | 0.466 | 12714 | 0.388 | 20055 | 2762 |
| -14 | 10 | terminal | control | 0.443 | 12714 | 0.367 | 20055 | 2718 |
| -14 | 10 | start | control | 0.440 | 12714 | 0.365 | 20055 | 2716 |

Selected cell: **L=0min W=10min start** (highest selection R-squared, then widest width, then smallest |lag|, then the terminal anchor)

Selection-block R2 0.628; evaluation-block R2 0.522. Verdict: **FAIL** — The selected cell scored 0.522 on the evaluation block and was refuted by 2 measured checks: a control that WAS measured was not beaten by 0.15, so the signal is INVALID regardless of magnitude; the cell did not hold across both anchors and a contiguous run of lags.

Stability: FAIL

- evaluation R2 terminal 0.521 / start 0.522 against threshold 0.5
- anchor gap 0.001 against maximum 0.1
- contiguous lags at W=10min clearing the threshold: 1 (need 2)

Controls: FAIL

- future-token control L=-12min W=10min start: evaluation R2 0.388; margin 0.134 (need 0.15)
- future-token control L=-14min W=10min start: evaluation R2 0.365; margin 0.157 (need 0.15)
- account-permutation control (seed 20260823): matched-cohort treatment R2 0.518 against placebo R2 0.010; margin 0.508 (need 0.15) — 5 accounts deranged onto each other over 13116 bins matched on identical edges (2044 positive-signal for the treatment, 698 for the placebo); treatment and placebo are fitted over that same cohort, and no account kept its own percent series

Conditional observability (clean cohort):

| quantity | value | numerator | denominator |
|---|---:|---:|---:|
| P(dPct = 0 given tokens > 0) | 15.4% | 596 | 3863 |
| P(tokens = 0 given dPct > 0) | 3.3% | 111 | 3378 |

Design-matrix identifiability (clean cohort):

| column | L2 norm | nonzero bins | token share |
|---|---:|---:|---:|
| fable/input | 494890.5 | 1478 | 0.0% |
| fable/output | 1182455.9 | 1478 | 0.1% |
| fable/cache_read | 389000599.8 | 1354 | 17.4% |
| fable/cache_creation | 25868241.1 | 1475 | 1.3% |
| opus/input | 1283424.8 | 2697 | 0.0% |
| opus/output | 3156582.4 | 2697 | 0.2% |
| opus/cache_read | 1065443599.2 | 2449 | 63.7% |
| opus/cache_creation | 50214196.3 | 2691 | 3.2% |
| sonnet/input | 2139375.3 | 920 | 0.0% |
| sonnet/output | 2825665.2 | 920 | 0.1% |
| sonnet/cache_read | 379497403.1 | 872 | 11.9% |
| sonnet/cache_creation | 25075685.4 | 919 | 0.8% |
| haiku/input | 112339.5 | 1688 | 0.0% |
| haiku/output | 1389458.0 | 1688 | 0.0% |
| haiku/cache_read | 23144205.7 | 1544 | 1.0% |
| haiku/cache_creation | 6231399.0 | 1688 | 0.3% |

Active columns 16; rank 16 at relative tolerance 1e-8; condition number 8.0 against a maximum of 10000.

Singular values (unit-scaled columns): 2.2837, 1.5877, 1.4965, 1.1275, 0.9671, 0.9278, 0.8797, 0.6941, 0.6458, 0.5891, 0.5149, 0.4682, 0.3747, 0.3675, 0.3098, 0.2859

Account concentration (clean cohort):

| account | usable bins | positive-signal bins | token mass | share | leave-one-out R2 |
|---|---:|---:|---:|---:|---:|
| 1135d045-b26c-4118-8db2-00f0f0ecdf9b | 5472 | 932 | 14,359,517,768 | 26.1% | 0.528 |
| 2acdf5e9-8298-42d5-816b-baecdb4498ca | 4736 | 689 | 12,749,165,989 | 23.1% | 0.523 |
| 4b3a18eb-5acb-4e1d-bb48-b3b36e29437a | 4139 | 661 | 12,473,855,880 | 22.6% | 0.512 |
| ae9e13bd-0a0d-4044-addb-5920075cd70f | 5497 | 871 | 12,029,022,358 | 21.8% | 0.523 |
| fb5944a3-df9e-49cd-b1d6-294988cd0fc4 | 220 | 114 | 3,507,145,259 | 6.4% | 0.528 |

Effective accounts (inverse HHI) 4.46 against a floor of 2; pooled R2 0.522.

Era stability (matched account x family x class strata):

| boundary | qualifying strata | pooled ratio before | pooled ratio after | relative change | before CI | after CI | verdict |
|---|---:|---:|---:|---:|---|---|---|
| 2026-07-20 boundary | 0 | — | — | — | — .. — | — .. — | INSUFFICIENT EVIDENCE |
| 2026-07-21 boundary | 0 | — | — | — | — .. — | — .. — | INSUFFICIENT EVIDENCE |
| August usage-persistence cutover | 0 | — | — | — | — .. — | — .. — | INSUFFICIENT EVIDENCE |

- 2026-07-20 boundary: No (account, family, class) stratum had 30 pure clean bins on both sides of this boundary.
- 2026-07-21 boundary: No (account, family, class) stratum had 30 pure clean bins on both sides of this boundary.
- August usage-persistence cutover: No (account, family, class) stratum had 30 pure clean bins on both sides of this boundary.

Tier provenance (informational):

The schema records no historical tier: neither `usage_snapshots` nor `requests` carries a tier column, so no account has tier provenance inside the study range. The live `accounts` tier is deliberately absent from this report, being mutable and unversioned: reading it would rewrite a frozen artifact on the next identity refresh. Any future fit must therefore either assume the current tiers held across the range, or wait for schema work that records tier history.

## anthropic / seven_day

Bin census at the selected cell (evaluation block):

| bins | usable | low coverage | refund | saturated | overage | keepalive-active | positive signal | equivalent 2-min bins | clean equivalent 2-min bins |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 20572 | 18006 | 22 | 0 | 2546 | 0 | 0 | 1973 | 102,729 | 89,990 |

Cell sweep (selection block chooses; evaluation block reports):

| lag (min) | width (min) | anchor | role | selection R2 | selection bins | evaluation R2 | evaluation bins | positive-signal bins |
|---:|---:|---|---|---:|---:|---:|---:|---:|
| 0 | 2 | terminal | candidate | 0.187 | 58917 | 0.071 | 90057 | 3767 |
| 0 | 2 | start | candidate | 0.189 | 58917 | 0.071 | 90057 | 3771 |
| 2 | 2 | terminal | candidate | 0.142 | 58914 | 0.056 | 90055 | 3531 |
| 2 | 2 | start | candidate | 0.153 | 58914 | 0.058 | 90055 | 3621 |
| 4 | 2 | terminal | candidate | 0.115 | 58911 | 0.043 | 90053 | 3204 |
| 4 | 2 | start | candidate | 0.120 | 58911 | 0.045 | 90053 | 3267 |
| 6 | 2 | terminal | candidate | 0.104 | 58908 | 0.041 | 90051 | 3123 |
| 6 | 2 | start | candidate | 0.106 | 58908 | 0.041 | 90051 | 3135 |
| -4 | 2 | terminal | control | 0.156 | 58913 | 0.054 | 90051 | 3541 |
| -4 | 2 | start | control | 0.154 | 58913 | 0.054 | 90051 | 3531 |
| -6 | 2 | terminal | control | 0.140 | 58911 | 0.049 | 90047 | 3432 |
| -6 | 2 | start | control | 0.139 | 58911 | 0.049 | 90047 | 3428 |
| 0 | 5 | terminal | candidate | 0.317 | 23570 | 0.144 | 36016 | 2559 |
| 0 | 5 | start | candidate | 0.321 | 23570 | 0.145 | 36016 | 2563 |
| 2 | 5 | terminal | candidate | 0.275 | 23567 | 0.129 | 36014 | 2480 |
| 2 | 5 | start | candidate | 0.285 | 23567 | 0.131 | 36014 | 2500 |
| 4 | 5 | terminal | candidate | 0.232 | 23567 | 0.109 | 36014 | 2367 |
| 4 | 5 | start | candidate | 0.241 | 23567 | 0.111 | 36014 | 2397 |
| 6 | 5 | terminal | candidate | 0.200 | 23567 | 0.096 | 36012 | 2243 |
| 6 | 5 | start | candidate | 0.204 | 23567 | 0.097 | 36012 | 2276 |
| -7 | 5 | terminal | control | 0.252 | 23566 | 0.113 | 36007 | 2376 |
| -7 | 5 | start | control | 0.248 | 23566 | 0.112 | 36007 | 2365 |
| -9 | 5 | terminal | control | 0.229 | 23566 | 0.106 | 36007 | 2310 |
| -9 | 5 | start | control | 0.227 | 23566 | 0.105 | 36007 | 2304 |
| 0 | 10 | terminal | candidate | 0.474 | 11775 | 0.235 | 18006 | 1969 |
| 0 | 10 | start | candidate | 0.478 | 11775 | 0.236 | 18006 | 1973 |
| 2 | 10 | terminal | candidate | 0.442 | 11772 | 0.224 | 18004 | 1957 |
| 2 | 10 | start | candidate | 0.449 | 11772 | 0.226 | 18004 | 1962 |
| 4 | 10 | terminal | candidate | 0.404 | 11772 | 0.209 | 18004 | 1912 |
| 4 | 10 | start | candidate | 0.412 | 11772 | 0.211 | 18004 | 1921 |
| 6 | 10 | terminal | candidate | 0.362 | 11772 | 0.191 | 18004 | 1863 |
| 6 | 10 | start | candidate | 0.369 | 11772 | 0.193 | 18004 | 1878 |
| -12 | 10 | terminal | control | 0.360 | 11771 | 0.179 | 17997 | 1808 |
| -12 | 10 | start | control | 0.357 | 11771 | 0.178 | 17997 | 1800 |
| -14 | 10 | terminal | control | 0.343 | 11771 | 0.170 | 17997 | 1764 |
| -14 | 10 | start | control | 0.340 | 11771 | 0.169 | 17997 | 1769 |

Selected cell: **L=0min W=10min start** (highest selection R-squared, then widest width, then smallest |lag|, then the terminal anchor)

Selection-block R2 0.478; evaluation-block R2 0.236. Verdict: **FAIL** — The selected cell scored 0.236 on the evaluation block and was refuted by 3 measured checks: a control that WAS measured was not beaten by 0.15, so the signal is INVALID regardless of magnitude; the evaluation R-squared 0.236 is below the threshold 0.5; the cell did not hold across both anchors and a contiguous run of lags.

Stability: FAIL

- evaluation R2 terminal 0.235 / start 0.236 against threshold 0.5
- anchor gap 0.001 against maximum 0.1
- contiguous lags at W=10min clearing the threshold: 0 (need 2)

Controls: FAIL

- future-token control L=-12min W=10min start: evaluation R2 0.178; margin 0.058 (need 0.15)
- future-token control L=-14min W=10min start: evaluation R2 0.169; margin 0.067 (need 0.15)
- account-permutation control (seed 20260823): matched-cohort treatment R2 0.182 against placebo R2 0.004; margin 0.178 (need 0.15) — 5 accounts deranged onto each other over 10970 bins matched on identical edges (1184 positive-signal for the treatment, 409 for the placebo); treatment and placebo are fitted over that same cohort, and no account kept its own percent series

Conditional observability (clean cohort):

| quantity | value | numerator | denominator |
|---|---:|---:|---:|
| P(dPct = 0 given tokens > 0) | 49.7% | 1948 | 3921 |
| P(tokens = 0 given dPct > 0) | 2.3% | 46 | 2019 |

Design-matrix identifiability (clean cohort):

| column | L2 norm | nonzero bins | token share |
|---|---:|---:|---:|
| fable/input | 512198.0 | 1515 | 0.0% |
| fable/output | 1208431.3 | 1515 | 0.1% |
| fable/cache_read | 396427392.6 | 1385 | 17.7% |
| fable/cache_creation | 26585951.9 | 1512 | 1.3% |
| opus/input | 1287633.8 | 2722 | 0.0% |
| opus/output | 3188244.0 | 2722 | 0.2% |
| opus/cache_read | 1071669878.4 | 2452 | 63.4% |
| opus/cache_creation | 51314004.4 | 2715 | 3.3% |
| sonnet/input | 2150011.9 | 926 | 0.0% |
| sonnet/output | 2841330.1 | 926 | 0.1% |
| sonnet/cache_read | 381098774.2 | 873 | 11.8% |
| sonnet/cache_creation | 25216605.2 | 925 | 0.8% |
| haiku/input | 113320.2 | 1707 | 0.0% |
| haiku/output | 1398635.6 | 1707 | 0.0% |
| haiku/cache_read | 23445733.5 | 1554 | 1.0% |
| haiku/cache_creation | 6290156.6 | 1707 | 0.3% |

Active columns 16; rank 16 at relative tolerance 1e-8; condition number 8.0 against a maximum of 10000.

Singular values (unit-scaled columns): 2.2856, 1.5873, 1.4977, 1.1249, 0.9668, 0.9274, 0.8767, 0.6921, 0.6461, 0.5881, 0.5157, 0.4678, 0.3778, 0.3693, 0.3106, 0.2865

Account concentration (clean cohort):

| account | usable bins | positive-signal bins | token mass | share | leave-one-out R2 |
|---|---:|---:|---:|---:|---:|
| 1135d045-b26c-4118-8db2-00f0f0ecdf9b | 4552 | 548 | 14,547,970,634 | 26.1% | 0.206 |
| 2acdf5e9-8298-42d5-816b-baecdb4498ca | 4231 | 449 | 12,913,238,146 | 23.2% | 0.423 |
| 4b3a18eb-5acb-4e1d-bb48-b3b36e29437a | 4018 | 400 | 12,620,652,289 | 22.6% | 0.211 |
| ae9e13bd-0a0d-4044-addb-5920075cd70f | 4982 | 509 | 12,152,161,260 | 21.8% | 0.206 |
| fb5944a3-df9e-49cd-b1d6-294988cd0fc4 | 223 | 67 | 3,538,745,107 | 6.3% | 0.237 |

Effective accounts (inverse HHI) 4.46 against a floor of 2; pooled R2 0.236.

Era stability (matched account x family x class strata):

| boundary | qualifying strata | pooled ratio before | pooled ratio after | relative change | before CI | after CI | verdict |
|---|---:|---:|---:|---:|---|---|---|
| 2026-07-20 boundary | 0 | — | — | — | — .. — | — .. — | INSUFFICIENT EVIDENCE |
| 2026-07-21 boundary | 0 | — | — | — | — .. — | — .. — | INSUFFICIENT EVIDENCE |
| August usage-persistence cutover | 0 | — | — | — | — .. — | — .. — | INSUFFICIENT EVIDENCE |

- 2026-07-20 boundary: No (account, family, class) stratum had 30 pure clean bins on both sides of this boundary.
- 2026-07-21 boundary: No (account, family, class) stratum had 30 pure clean bins on both sides of this boundary.
- August usage-persistence cutover: No (account, family, class) stratum had 30 pure clean bins on both sides of this boundary.

Tier provenance (informational):

The schema records no historical tier: neither `usage_snapshots` nor `requests` carries a tier column, so no account has tier provenance inside the study range. The live `accounts` tier is deliberately absent from this report, being mutable and unversioned: reading it would rewrite a frozen artifact on the next identity refresh. Any future fit must therefore either assume the current tiers held across the range, or wait for schema work that records tier history.

## codex / five_hour

EXCLUDED. OpenAI retired the Codex 5-hour window on 2026-07-12; the stored `five_hour_reset` advances on every poll while the percent stays 0, so each poll forms its own one-sample window (data-quality note, docs/prediction-backtest-baseline.md). There is no consumed quota to correlate tokens against.

## codex / seven_day

Bin census at the selected cell (evaluation block):

| bins | usable | low coverage | refund | saturated | overage | keepalive-active | positive signal | equivalent 2-min bins | clean equivalent 2-min bins |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 5318 | 5264 | 30 | 16 | 9 | 0 | 0 | 655 | 26,455 | 26,298 |

Cell sweep (selection block chooses; evaluation block reports):

| lag (min) | width (min) | anchor | role | selection R2 | selection bins | evaluation R2 | evaluation bins | positive-signal bins |
|---:|---:|---|---|---:|---:|---:|---:|---:|
| 0 | 2 | terminal | candidate | 0.326 | 8468 | 0.270 | 26422 | 1412 |
| 0 | 2 | start | candidate | 0.329 | 8468 | 0.267 | 26422 | 1368 |
| 2 | 2 | terminal | candidate | 0.151 | 8468 | 0.209 | 26422 | 1334 |
| 2 | 2 | start | candidate | 0.161 | 8468 | 0.214 | 26422 | 1313 |
| 4 | 2 | terminal | candidate | 0.076 | 8468 | 0.138 | 26422 | 1166 |
| 4 | 2 | start | candidate | 0.076 | 8468 | 0.142 | 26422 | 1144 |
| 6 | 2 | terminal | candidate | 0.054 | 8467 | 0.091 | 26422 | 1034 |
| 6 | 2 | start | candidate | 0.055 | 8467 | 0.093 | 26422 | 1008 |
| -4 | 2 | terminal | control | 0.110 | 8468 | 0.134 | 26422 | 1190 |
| -4 | 2 | start | control | 0.095 | 8468 | 0.121 | 26422 | 1082 |
| -6 | 2 | terminal | control | 0.066 | 8468 | 0.089 | 26422 | 1030 |
| -6 | 2 | start | control | 0.062 | 8468 | 0.080 | 26422 | 924 |
| 0 | 5 | terminal | candidate | 0.488 | 3338 | 0.450 | 10559 | 886 |
| 0 | 5 | start | candidate | 0.492 | 3338 | 0.447 | 10559 | 867 |
| 2 | 5 | terminal | candidate | 0.337 | 3338 | 0.389 | 10559 | 866 |
| 2 | 5 | start | candidate | 0.354 | 3338 | 0.399 | 10559 | 869 |
| 4 | 5 | terminal | candidate | 0.190 | 3338 | 0.278 | 10559 | 819 |
| 4 | 5 | start | candidate | 0.195 | 3338 | 0.288 | 10559 | 814 |
| 6 | 5 | terminal | candidate | 0.124 | 3338 | 0.178 | 10559 | 749 |
| 6 | 5 | start | candidate | 0.126 | 3338 | 0.183 | 10559 | 735 |
| -7 | 5 | terminal | control | 0.128 | 3338 | 0.151 | 10559 | 711 |
| -7 | 5 | start | control | 0.120 | 3338 | 0.139 | 10559 | 662 |
| -9 | 5 | terminal | control | 0.116 | 3338 | 0.110 | 10559 | 667 |
| -9 | 5 | start | control | 0.112 | 3338 | 0.102 | 10559 | 613 |
| 0 | 10 | terminal | candidate | 0.617 | 1656 | 0.551 | 5264 | 661 |
| 0 | 10 | start | candidate | 0.620 | 1656 | 0.550 | 5264 | 655 |
| 2 | 10 | terminal | candidate | 0.550 | 1655 | 0.513 | 5264 | 657 |
| 2 | 10 | start | candidate | 0.560 | 1655 | 0.519 | 5264 | 658 |
| 4 | 10 | terminal | candidate | 0.436 | 1655 | 0.437 | 5264 | 634 |
| 4 | 10 | start | candidate | 0.446 | 1655 | 0.446 | 5264 | 632 |
| 6 | 10 | terminal | candidate | 0.329 | 1655 | 0.343 | 5264 | 606 |
| 6 | 10 | start | candidate | 0.340 | 1655 | 0.352 | 5264 | 602 |
| -12 | 10 | terminal | control | 0.212 | 1656 | 0.160 | 5264 | 537 |
| -12 | 10 | start | control | 0.207 | 1656 | 0.156 | 5264 | 519 |
| -14 | 10 | terminal | control | 0.193 | 1656 | 0.147 | 5264 | 521 |
| -14 | 10 | start | control | 0.193 | 1656 | 0.143 | 5264 | 498 |

Selected cell: **L=0min W=10min start** (highest selection R-squared, then widest width, then smallest |lag|, then the terminal anchor)

Selection-block R2 0.620; evaluation-block R2 0.550. Verdict: **INSUFFICIENT EVIDENCE** — The selected cell scored 0.550 on the evaluation block and every measured check held, but at least one mandatory control produced no number at all. An unmeasurable control is not a beaten control, so the cell is neither valid nor refuted.

Stability: PASS

- evaluation R2 terminal 0.551 / start 0.550 against threshold 0.5
- anchor gap 0.001 against maximum 0.1
- contiguous lags at W=10min clearing the threshold: 2 (need 2)

Controls: UNMEASURABLE

- future-token control L=-12min W=10min start: evaluation R2 0.156; margin 0.394 (need 0.15)
- future-token control L=-14min W=10min start: evaluation R2 0.143; margin 0.407 (need 0.15)
- account-permutation control (seed 20260823): matched-cohort treatment R2 — against placebo R2 —; margin — (need 0.15) — UNMEASURABLE, so nothing was beaten — an account permutation needs at least two accounts in the clean cohort; this group has 1

Conditional observability (clean cohort):

| quantity | value | numerator | denominator |
|---|---:|---:|---:|
| P(dPct = 0 given tokens > 0) | 50.2% | 660 | 1315 |
| P(tokens = 0 given dPct > 0) | 6.8% | 48 | 703 |

Design-matrix identifiability (clean cohort):

| column | L2 norm | nonzero bins | token share |
|---|---:|---:|---:|
| unresolved/input | 26306446.1 | 1315 | 11.6% |
| unresolved/output | 1787904.0 | 1315 | 1.1% |
| unresolved/cache_read | 111222133.6 | 1309 | 87.3% |

Active columns 3; rank 3 at relative tolerance 1e-8; condition number 2.1 against a maximum of 10000.

Singular values (unit-scaled columns): 1.3528, 0.8638, 0.6510

Account concentration (clean cohort):

| account | usable bins | positive-signal bins | token mass | share | leave-one-out R2 |
|---|---:|---:|---:|---:|---:|
| 1cae47ec-5813-41bc-837d-4f209e2ae1e7 | 5264 | 655 | 3,132,528,922 | 100.0% | — |

Effective accounts (inverse HHI) 1.00 against a floor of 2; pooled R2 0.550.

Era stability (matched account x family x class strata):

| boundary | qualifying strata | pooled ratio before | pooled ratio after | relative change | before CI | after CI | verdict |
|---|---:|---:|---:|---:|---|---|---|
| 2026-07-20 boundary | 0 | — | — | — | — .. — | — .. — | INSUFFICIENT EVIDENCE |
| 2026-07-21 boundary | 0 | — | — | — | — .. — | — .. — | INSUFFICIENT EVIDENCE |
| August usage-persistence cutover | 0 | — | — | — | — .. — | — .. — | INSUFFICIENT EVIDENCE |

- 2026-07-20 boundary: No (account, family, class) stratum had 30 pure clean bins on both sides of this boundary.
- 2026-07-21 boundary: No (account, family, class) stratum had 30 pure clean bins on both sides of this boundary.
- August usage-persistence cutover: No (account, family, class) stratum had 30 pure clean bins on both sides of this boundary.

Tier provenance (informational):

The schema records no historical tier: neither `usage_snapshots` nor `requests` carries a tier column, so no account has tier provenance inside the study range. The live `accounts` tier is deliberately absent from this report, being mutable and unversioned: reading it would rewrite a frozen artifact on the next identity refresh. Any future fit must therefore either assume the current tiers held across the range, or wait for schema work that records tier history.

## Notes

- This is a data-feasibility study. It produces no estimator and nothing here is wired into the running service.
- Bins dropped at the selected cell because the bin interval or its token-source interval left the block it would otherwise belong to — by spanning the selection/evaluation split, or by reaching before the study range's start or past its end: anthropic/five_hour 3, anthropic/seven_day 3, codex/seven_day 0. A bin counts toward a block only when BOTH intervals lie wholly inside it.
- `cache_keepalive_snapshots` carries no account or token attribution, so keepalive-active marking says WHEN keepalive traffic existed, never WHOSE quota it spent. It is informational and does not exclude a bin.
- Each account is grouped by the provider its IN-RANGE snapshots recorded, not by the live `accounts` row: the table has no history, so reading it would let a provider changed after the range regroup history the study already binned.
