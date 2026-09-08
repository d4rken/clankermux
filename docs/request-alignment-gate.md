# ClankerMux request-alignment gate

Generated: 2026-09-08T06:59:50.044Z

Reproduce with:

```
bun scripts/alignment-study.ts --db=/home/darken/.config/clankermux/clankermux.db --claim=5h --from=2026-08-24T00:00:00.000Z --to=2026-09-08T00:00:00.000Z --seed=20260908 --out=docs/request-alignment-gate.md
```

This is the GATE, not an estimator. It answers whether the recorded requests line up with the quota readings well enough to be worth building a capacity model on. No number here is a capacity, no fitted weight is used anywhere, and no server code imports the module.

## Dataset

| field | value |
|---|---|
| claim | `5h` |
| claim observations | 184782 |
| requests with a finalized token vector | 210802 |
| accounts | 5 |
| observation range | 2026-08-24T16:58:24.809Z .. 2026-09-07T23:00:09.879Z |
| train / evaluate split | 2026-08-31T18:55:00.000Z |
| requests carrying `usage_finalized_at` | 96.8% of rows, 97.2% of token mass |
| intervals | 10 min |

Units built: 1730. Dropped: 408 with a single reading (no change to state), 0 whose reading fell (a refund, an applied credit, or a reset this grouping did not see — none of them is consumption), 20 whose slot held two window instances (both would have read the same ten minutes of requests), 0 readings with no window instance.

## The rule

```
REQUEST-LAG ALIGNMENT GATE. Declared 2026-09-08, before the run.

UNIT. A fixed 10-minute wall-clock interval inside one (account, claim,
   window instance), chosen without reference to where the 1 % crossings
   fall, and KEPT when the reading did not move. The target is the change
   between the interval's first and last reading, in percentage points.

FEATURES, frozen. The summed input / output / cache-read / cache-creation
   tokens of the requests whose `usage_finalized_at` falls in the source
   interval. Weights are fitted non-negative on the FIRST chronological
   half and every number below is scored on the second.

COHORT. Every alignment answers the SAME units: a unit enters only when
   every scored alignment's source interval carries at least one request.
   Without that the shifted and donor controls are handed idle stretches —
   traffic arrives in bursts — and beating them would test whether anyone
   was working rather than which requests belong to which interval.

1. ALIGNMENT. Real must beat `permuted-within-account` — the same account's
   own intervals, deterministically re-paired — on BOTH median absolute
   error and in-band share, and the paired median difference must have its
   95 % cluster-bootstrap interval entirely below zero. Clusters are
   (account, calendar day).
2. COMPOSITION. Real must beat `count-only` on both statistics: token
   composition has to add something over merely counting requests.
3. VALID. The synthetic positive must be detected and the synthetic null
   must not. A statistic that cannot find an alignment that is there, or
   finds one that is not, invalidates the experiment whatever it says
   about the real data.

REPORTED, NOT GATED. The shifted-source controls, the saturation cohort,
   coverage by token mass, and the donor-account control wherever it is
   measurable at all.

DECISION. 1, 2 and 3 hold: `pass` — alignment is identifiable, which is
   permission to build a capacity estimator and nothing more. A measured
   failure of 1 or 2: `fail`. 3 failing: `invalid`. Too few evaluation
   units, or a statistic that cannot be computed: `insufficient-evidence`.

WHAT A PASS IS NOT. It does not validate the fitted token prices, it does
   not establish a capacity number, and it does not survive the timestamp
   caveats: `observed_at` is header arrival, `usage_finalized_at` is when
   a token vector first became known, and concurrent requests mean neither
   identifies a causal instant.
```

## Primary cohort

Every interval whose source carries traffic under every scored alignment. This is the cohort the verdict is taken on.

315 training units, 397 evaluation units.

| alignment | what it reads | units | median &#124;err&#124; (pp) | in band | median &#124;err&#124;, moved only | fit converged (iterations) | weights |
|---|---|---:|---:|---:|---:|---:|---|
| `real` | the interval's own requests | 397 | 1.412 | 39.0% | 1.718 | 703 | input 0.00e+0, output 1.29e-5, cache_read 0.00e+0, cache_creation 1.75e-6 |
| `count-only` | the interval's own requests, counted rather than weighed by token class | 397 | 2.022 | 32.2% | 2.258 | 1 | per request 0.0239 |
| `earlier-1` | the same account 10 min earlier | 397 | 1.753 | 33.2% | 2.050 | 1327 | input 0.00e+0, output 1.03e-5, cache_read 1.48e-8, cache_creation 1.17e-6 |
| `later-1` | the same account 10 min later | 397 | 1.776 | 35.0% | 2.166 | 1308 | input 0.00e+0, output 2.24e-5, cache_read 3.58e-8, cache_creation 0.00e+0 |
| `earlier-3` | the same account 30 min earlier | 397 | 2.115 | 29.2% | 2.307 | 1324 | input 0.00e+0, output 8.59e-6, cache_read 2.11e-8, cache_creation 9.43e-7 |
| `later-3` | the same account 30 min later | 397 | 2.426 | 29.0% | 2.607 | 762 | input 0.00e+0, output 1.89e-5, cache_read 0.00e+0, cache_creation 7.91e-7 |
| `permuted-within-account` (mandatory control) | another interval of the SAME account and the SAME half of the split, drawn from the units this cohort kept; same account, same slot length, same eligibility, only the pairing is wrong | 397 | 2.648 | 22.7% | 2.755 | 1277 | input 0.00e+0, output 7.00e-6, cache_read 2.84e-8, cache_creation 5.81e-7 |

## Saturation cohort

Intervals whose reading reached 90 % or more. Reported only: near the cap the provider's behaviour changes, and pooling it with ordinary burn would hide that either way.

2 training units, 0 evaluation units.

Fewer than 100 evaluation units, so this cohort states nothing and its scores are not printed. It is reported so the gap is visible rather than absent.

## Paired differences against the real alignment

Negative favours the real alignment. An interval is stated only above 5 clusters: fewer than that resample to nearly the same draw every time and would print a decisive-looking interval carrying no independent evidence. The interval is a cluster bootstrap over (account, calendar day): units inside one account's working day share a workload, a cache state and a model mix, so resampling them independently would state an interval far narrower than the evidence. Its coverage still rests on account-days being independent of each other, which this study assumes rather than establishes.

| control | paired units | clusters | median difference (pp) | 2.5 % | 97.5 % |
|---|---:|---:|---:|---:|---:|
| `count-only` | 397 | 36 | -0.439 | -0.546 | -0.272 |
| `earlier-1` | 397 | 36 | -0.401 | -0.615 | -0.302 |
| `later-1` | 397 | 36 | -0.340 | -0.504 | -0.183 |
| `earlier-3` | 397 | 36 | -0.530 | -0.846 | -0.285 |
| `later-3` | 397 | 36 | -0.615 | -0.953 | -0.424 |
| `permuted-within-account` | 397 | 36 | -0.916 | -1.399 | -0.545 |

## Synthetic validation

Before any real number is worth reading, the statistic has to find an alignment that was planted and fail to find one that was not.

| check | expectation | paired median (pp) | result |
|---|---|---:|---|
| synthetic positive | percentages generated FROM the tokens: the statistic must find the alignment | -0.962 | as required |
| synthetic null | percentages drawn from the same distribution but a different interval: the statistic must NOT find one | 0.018 | as required |

## Verdict

- 1. ALIGNMENT — real beats the within-account permutation: PASS
  - median |err| 1.412 vs 2.648 pp; in band 39.0% vs 22.7%; paired median -0.916 pp, 95 % CI [-1.399, -0.545] over 36 account-day clusters
- 2. COMPOSITION — real beats counting requests: PASS
  - median |err| 1.412 vs 2.022 pp; in band 39.0% vs 32.2%
- 3. VALID — the statistic finds a planted alignment and no absent one: PASS
  - synthetic positive: paired median -0.962 pp, as required; synthetic null: paired median 0.018 pp, as required

**Verdict: `pass`**

## Notes

- The donor-account control is NOT CONSTRUCTED by this study, so no row below reports on it and this run measured nothing about it. It was dropped as the mandatory control on 2026-09-08 after a separate read-only check found no ten-minute interval in which two accounts were both busy — the proxy spreads load — and that finding is about that data, not a property this run re-established. The within-account permutation is the mandatory control in its place: same account, same intervals, same token distribution, only the pairing broken.
- `usage_finalized_at` keeps the instant a token vector FIRST became known, so a later revision of that vector is placed at the earlier instant. Requests are also concurrent and provider accounting is delayed, so no timestamp here identifies a causal instant.
- Weights are reported so the fit can be inspected, not because any of them is a price. A class fitted to zero means the fit could not separate it from the others on this data, which is not the same as it being free.
