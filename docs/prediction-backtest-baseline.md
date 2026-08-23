# ClankerMux usage-prediction backtest

Generated: 2026-08-23T15:15:54.715Z

Reproduce with:

```
bun scripts/prediction-backtest.ts --from=2026-06-02T00:00:00Z --split=2026-08-01T00:00:00Z --to=2026-08-23T00:00:00Z --out=docs/prediction-backtest-baseline.md
```

| config | value |
|---|---|
| bootstrapIterations | 1000 |
| estimators | ols,lifetime,naive |
| from | 2026-06-02T00:00:00.000Z |
| seed | 20260823 |
| split | 2026-08-01T00:00:00Z |
| stepMinutes | 10 |
| to | 2026-08-23T00:00:00.000Z |
| windows | five_hour,seven_day |

## Dataset

| field | value |
|---|---|
| usage_snapshots rows | 154868 |
| accounts | 6 |
| providers | anthropic, codex |
| first sample | 2026-06-02T12:48:00.294Z |
| last sample | 2026-08-23T15:12:02.510Z |

## Methodology

- **Point-in-time replay.** For a prediction at instant `T` an estimator sees
  only stored snapshots with `sampled_at <= T`, then applies the production
  lookback itself (6 h for the 5-hour window, 24 h for the weekly one).
- **No fabricated live point.** The production path appends the live usage
  reading stamped `now`; replay has no such reading, so nothing is appended.
  Candidate instants are ACTUAL snapshot timestamps, so the newest input point
  is at most one sampler tick (120 s) old, which is what production sees.
- **Window-scoped ground truth.** Raw per-account series are split on the
  WINDOW-lifecycle boundary (`resets_at` changed beyond the 60 s jitter
  tolerance), not on the estimator's fit boundary. A refund drops utilization
  by more than the fit threshold without ending the quota window, and such a
  window can still exhaust later.
- **Censoring.** `survived` is asserted only from positive evidence: the next
  window was observed to start AND this window's last sample is within 10
  minutes of the window end. Otherwise the instant is CENSORED and excluded
  from the confusion matrix and the error distributions, because an exhaustion
  could hide in the gap. Censored counts are reported.
- **Label horizon.** Candidate instants whose outcome region would extend past
  the scoring range's end are dropped, so no label peeks across a
  tuning/held-out boundary.
- **Positive class** = the window reaches 100% before its reset. Class balance
  is heavily skewed, so accuracy is not reported: the confusion matrix, F1 and
  the per-lead-time recall are.
- **Signed vs absolute error.** Both are reported: the absolute median is not
  the magnitude of the signed median, and only the signed one shows the
  early/late bias.
- **Integer quantisation caveat.** `five_hour_pct` and `seven_day_pct` are
  stored as integers. One point of a 5-hour window is ~3 minutes of headroom,
  so a fit over three identical integers cannot resolve a slope finer than
  that. Sub-quantum ETA differences between estimators are noise.
- **429 diagnostic.** 429 responses inside windows labelled `survived` are
  counted as a label-quality signal only. They are never an input to a label:
  a 429 can come from a different (family-scoped) limit than the window being
  scored.
- **Bootstrap.** Confidence intervals resample ACCOUNTS with replacement, not
  instants: samples minutes apart within one account are correlated.

## Tuning range

Scoring interval: `[2026-06-02T00:00:00.000Z, 2026-08-01T00:00:00.000Z)`

### Tuning range — five_hour

Conditional (each estimator on the instants it can answer):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 33052 | 61.0% | 19547 | 839 | 275 | 660 | 18375 | 237 | 0.294 | 0.537 | 0.380 | 21.1 | 48.9 | 0.163 |
| lifetime | 33052 | 26.6% | 8553 | 839 | 276 | 661 | 7440 | 176 | 0.295 | 0.611 | 0.397 | 23.2 | 49.5 | 0.165 |
| naive | 33052 | 99.4% | 32120 | 839 | 252 | 429 | 31154 | 285 | 0.370 | 0.469 | 0.414 | 12.9 | 35.6 | 0.119 |

Coverage:

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| ols | 20163 | 12889 | 0 | 0 | 0 | 33052 |
| lifetime | 8807 | 0 | 0 | 19582 | 4663 | 33052 |
| naive | 32838 | 182 | 32 | 0 | 0 | 33052 |

Common cohort (instants every estimator answered):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 8445 | 100.0% | 8445 | 0 | 275 | 660 | 7344 | 166 | 0.294 | 0.624 | 0.400 | 21.1 | 48.9 | 0.163 |
| lifetime | 8445 | 100.0% | 8445 | 0 | 268 | 627 | 7377 | 173 | 0.299 | 0.608 | 0.401 | 24.4 | 48.6 | 0.162 |
| naive | 8445 | 100.0% | 8445 | 0 | 252 | 428 | 7576 | 189 | 0.371 | 0.571 | 0.450 | 11.9 | 35.3 | 0.118 |

Lead time (common cohort):

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| ols | <30m | 73 | 4 | 0.948 | 2.8 | 53 |
| ols | 30m-2h | 140 | 89 | 0.611 | 43.3 | 271 |
| ols | 2h-12h | 62 | 73 | 0.459 | 82.3 | 336 |
| ols | 12h-48h | 0 | 0 | — | — | 0 |
| ols | >48h | 0 | 0 | — | — | 0 |
| lifetime | <30m | 71 | 6 | 0.922 | 3.1 | 45 |
| lifetime | 30m-2h | 140 | 89 | 0.611 | 37.8 | 257 |
| lifetime | 2h-12h | 57 | 78 | 0.422 | 95.3 | 325 |
| lifetime | 12h-48h | 0 | 0 | — | — | 0 |
| lifetime | >48h | 0 | 0 | — | — | 0 |
| naive | <30m | 73 | 4 | 0.948 | -0.4 | 35 |
| naive | 30m-2h | 152 | 77 | 0.664 | 14.9 | 229 |
| naive | 2h-12h | 27 | 108 | 0.200 | 123.3 | 164 |
| naive | 12h-48h | 0 | 0 | — | — | 0 |
| naive | >48h | 0 | 0 | — | — | 0 |

Macro F1 (per-account, equal weight; common cohort):

| estimator | macro F1 |
|---|---:|
| ols | 0.451 |
| lifetime | 0.445 |
| naive | 0.479 |

By provider (common cohort):

| provider | estimator | scored | TP | FP | TN | FN | F1 | median abs err (min) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic | ols | 7780 | 214 | 611 | 6798 | 157 | 0.358 | 56.0 |
| anthropic | lifetime | 7780 | 213 | 577 | 6832 | 158 | 0.367 | 52.7 |
| anthropic | naive | 7780 | 207 | 391 | 7018 | 164 | 0.427 | 31.0 |
| codex | ols | 665 | 61 | 49 | 546 | 9 | 0.678 | 40.9 |
| codex | lifetime | 665 | 55 | 50 | 545 | 15 | 0.629 | 31.7 |
| codex | naive | 665 | 45 | 37 | 558 | 25 | 0.592 | 50.0 |

Per-account contribution:

| account | provider | instants | scored | actual positives |
|---|---|---:|---:|---:|
| 1135d045-b26c-4118-8db2-00f0f0ecdf9b | anthropic | 7355 | 7311 | 147 |
| 1cae47ec-5813-41bc-837d-4f209e2ae1e7 | codex | 13718 | 12987 | 74 |
| 2acdf5e9-8298-42d5-816b-baecdb4498ca | anthropic | 2970 | 2927 | 82 |
| 4b3a18eb-5acb-4e1d-bb48-b3b36e29437a | anthropic | 893 | 893 | 68 |
| ae9e13bd-0a0d-4044-addb-5920075cd70f | anthropic | 8116 | 8095 | 168 |

Bootstrap (accounts resampled with replacement):

| comparison | statistic | p2.5 | median | p97.5 | resamples |
|---|---|---:|---:|---:|---:|
| lifetime minus ols | f1 | -0.028 | 0.002 | 0.017 | 1000 |
| lifetime minus ols | medianAbsErrorMinutes | -12.090 | -3.495 | 4.769 | 1000 |
| naive minus ols | f1 | -0.030 | 0.050 | 0.092 | 1000 |
| naive minus ols | medianAbsErrorMinutes | -48.019 | -13.565 | 1.994 | 1000 |

### Tuning range — seven_day

Conditional (each estimator on the instants it can answer):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 19378 | 99.5% | 17964 | 1351 | 4035 | 3777 | 8501 | 1651 | 0.517 | 0.710 | 0.598 | 411.2 | 1476.3 | 0.146 |
| lifetime | 19378 | 85.3% | 15381 | 1351 | 3803 | 3085 | 7065 | 1428 | 0.552 | 0.727 | 0.628 | 780.3 | 1865.6 | 0.185 |
| naive | 19378 | 99.1% | 17977 | 1351 | 2270 | 2724 | 9592 | 3391 | 0.455 | 0.401 | 0.426 | -702.0 | 1126.0 | 0.112 |

Coverage:

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| ols | 19286 | 91 | 1 | 0 | 0 | 19378 |
| lifetime | 16531 | 0 | 0 | 2797 | 50 | 19378 |
| naive | 19199 | 177 | 2 | 0 | 0 | 19378 |

Common cohort (instants every estimator answered):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 15341 | 100.0% | 15341 | 0 | 4015 | 3775 | 6366 | 1185 | 0.515 | 0.772 | 0.618 | 412.8 | 1476.3 | 0.146 |
| lifetime | 15341 | 100.0% | 15341 | 0 | 3781 | 3082 | 7059 | 1419 | 0.551 | 0.727 | 0.627 | 781.5 | 1872.2 | 0.186 |
| naive | 15341 | 100.0% | 15341 | 0 | 2270 | 2723 | 7418 | 2930 | 0.455 | 0.437 | 0.445 | -702.0 | 1126.0 | 0.112 |

Lead time (common cohort):

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| ols | <30m | 31 | 0 | 1.000 | 59.0 | 18 |
| ols | 30m-2h | 90 | 3 | 0.968 | 159.8 | 50 |
| ols | 2h-12h | 469 | 125 | 0.790 | 1179.5 | 264 |
| ols | 12h-48h | 1709 | 351 | 0.830 | 443.0 | 2212 |
| ols | >48h | 1716 | 706 | 0.709 | 77.0 | 1231 |
| lifetime | <30m | 31 | 0 | 1.000 | 65.6 | 0 |
| lifetime | 30m-2h | 93 | 0 | 1.000 | 141.2 | 63 |
| lifetime | 2h-12h | 562 | 32 | 0.946 | 966.4 | 200 |
| lifetime | 12h-48h | 1446 | 614 | 0.702 | 1113.7 | 1774 |
| lifetime | >48h | 1649 | 773 | 0.681 | 102.8 | 1045 |
| naive | <30m | 28 | 3 | 0.903 | 20.0 | 7 |
| naive | 30m-2h | 84 | 9 | 0.903 | 22.0 | 39 |
| naive | 2h-12h | 357 | 237 | 0.601 | 26.0 | 697 |
| naive | 12h-48h | 785 | 1275 | 0.381 | -554.0 | 1349 |
| naive | >48h | 1016 | 1406 | 0.419 | -2300.0 | 631 |

Macro F1 (per-account, equal weight; common cohort):

| estimator | macro F1 |
|---|---:|
| ols | 0.626 |
| lifetime | 0.559 |
| naive | 0.450 |

By provider (common cohort):

| provider | estimator | scored | TP | FP | TN | FN | F1 | median abs err (min) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic | ols | 12729 | 3102 | 2620 | 6096 | 911 | 0.637 | 1619.8 |
| anthropic | lifetime | 12729 | 2839 | 1973 | 6743 | 1174 | 0.643 | 2106.1 |
| anthropic | naive | 12729 | 1821 | 2022 | 6694 | 2192 | 0.464 | 1069.0 |
| codex | ols | 2612 | 913 | 1155 | 270 | 274 | 0.561 | 1205.2 |
| codex | lifetime | 2612 | 942 | 1109 | 316 | 245 | 0.582 | 1559.0 |
| codex | naive | 2612 | 449 | 701 | 724 | 738 | 0.384 | 1386.1 |

Per-account contribution:

| account | provider | instants | scored | actual positives |
|---|---|---:|---:|---:|
| 1135d045-b26c-4118-8db2-00f0f0ecdf9b | anthropic | 6617 | 6129 | 499 |
| 1cae47ec-5813-41bc-837d-4f209e2ae1e7 | codex | 3814 | 3024 | 1271 |
| 2acdf5e9-8298-42d5-816b-baecdb4498ca | anthropic | 2314 | 2241 | 637 |
| 4b3a18eb-5acb-4e1d-bb48-b3b36e29437a | anthropic | 298 | 298 | 297 |
| ae9e13bd-0a0d-4044-addb-5920075cd70f | anthropic | 6335 | 6335 | 2995 |

Bootstrap (accounts resampled with replacement):

| comparison | statistic | p2.5 | median | p97.5 | resamples |
|---|---|---:|---:|---:|---:|
| lifetime minus ols | f1 | -0.091 | 0.009 | 0.142 | 1000 |
| lifetime minus ols | medianAbsErrorMinutes | -753.704 | 395.848 | 1121.097 | 1000 |
| naive minus ols | f1 | -0.190 | -0.173 | -0.162 | 1000 |
| naive minus ols | medianAbsErrorMinutes | -1070.361 | -350.275 | 214.394 | 1000 |

## Held-out range

Scoring interval: `[2026-08-01T00:00:00.000Z, 2026-08-23T00:00:00.000Z)`

### Held-out range — five_hour

Conditional (each estimator on the instants it can answer):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 18210 | 57.2% | 10397 | 26 | 49 | 437 | 9904 | 7 | 0.101 | 0.875 | 0.181 | 5.1 | 20.0 | 0.067 |
| lifetime | 18210 | 21.9% | 3968 | 26 | 50 | 421 | 3491 | 6 | 0.106 | 0.893 | 0.190 | 0.4 | 28.8 | 0.096 |
| naive | 18210 | 100.0% | 18177 | 26 | 40 | 301 | 17817 | 19 | 0.117 | 0.678 | 0.200 | 7.3 | 43.1 | 0.144 |

Coverage:

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| ols | 10419 | 7791 | 0 | 0 | 0 | 18210 |
| lifetime | 3982 | 0 | 0 | 10966 | 3262 | 18210 |
| naive | 18203 | 5 | 2 | 0 | 0 | 18210 |

Common cohort (instants every estimator answered):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 3920 | 100.0% | 3920 | 0 | 49 | 437 | 3428 | 6 | 0.101 | 0.891 | 0.181 | 5.1 | 20.0 | 0.067 |
| lifetime | 3920 | 100.0% | 3920 | 0 | 49 | 399 | 3466 | 6 | 0.109 | 0.891 | 0.195 | 0.6 | 28.8 | 0.096 |
| naive | 3920 | 100.0% | 3920 | 0 | 40 | 301 | 3564 | 15 | 0.117 | 0.727 | 0.202 | 7.3 | 43.1 | 0.144 |

Lead time (common cohort):

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| ols | <30m | 7 | 0 | 1.000 | 5.6 | 50 |
| ols | 30m-2h | 26 | 0 | 1.000 | 4.9 | 168 |
| ols | 2h-12h | 16 | 6 | 0.727 | -9.4 | 219 |
| ols | 12h-48h | 0 | 0 | — | — | 0 |
| ols | >48h | 0 | 0 | — | — | 0 |
| lifetime | <30m | 7 | 0 | 1.000 | 1.5 | 43 |
| lifetime | 30m-2h | 26 | 0 | 1.000 | -12.3 | 160 |
| lifetime | 2h-12h | 16 | 6 | 0.727 | 16.8 | 196 |
| lifetime | 12h-48h | 0 | 0 | — | — | 0 |
| lifetime | >48h | 0 | 0 | — | — | 0 |
| naive | <30m | 5 | 2 | 0.714 | 10.7 | 44 |
| naive | 30m-2h | 22 | 4 | 0.846 | 2.7 | 142 |
| naive | 2h-12h | 13 | 9 | 0.591 | 28.3 | 115 |
| naive | 12h-48h | 0 | 0 | — | — | 0 |
| naive | >48h | 0 | 0 | — | — | 0 |

Macro F1 (per-account, equal weight; common cohort):

| estimator | macro F1 |
|---|---:|
| ols | 0.121 |
| lifetime | 0.131 |
| naive | 0.126 |

By provider (common cohort):

| provider | estimator | scored | TP | FP | TN | FN | F1 | median abs err (min) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic | ols | 3920 | 49 | 437 | 3428 | 6 | 0.181 | 20.0 |
| anthropic | lifetime | 3920 | 49 | 399 | 3466 | 6 | 0.195 | 28.8 |
| anthropic | naive | 3920 | 40 | 301 | 3564 | 15 | 0.202 | 43.1 |

Per-account contribution:

| account | provider | instants | scored | actual positives |
|---|---|---:|---:|---:|
| 1135d045-b26c-4118-8db2-00f0f0ecdf9b | anthropic | 2688 | 2677 | 0 |
| 1cae47ec-5813-41bc-837d-4f209e2ae1e7 | codex | 7351 | 7350 | 0 |
| 2acdf5e9-8298-42d5-816b-baecdb4498ca | anthropic | 2667 | 2653 | 33 |
| 4b3a18eb-5acb-4e1d-bb48-b3b36e29437a | anthropic | 2726 | 2726 | 0 |
| ae9e13bd-0a0d-4044-addb-5920075cd70f | anthropic | 2582 | 2582 | 26 |
| fb5944a3-df9e-49cd-b1d6-294988cd0fc4 | anthropic | 196 | 196 | 0 |

Bootstrap (accounts resampled with replacement):

| comparison | statistic | p2.5 | median | p97.5 | resamples |
|---|---|---:|---:|---:|---:|
| lifetime minus ols | f1 | 0.000 | 0.014 | 0.027 | 1000 |
| lifetime minus ols | medianAbsErrorMinutes | -7.237 | -0.033 | 8.875 | 932 |
| naive minus ols | f1 | -0.027 | 0.016 | 0.056 | 1000 |
| naive minus ols | medianAbsErrorMinutes | 3.030 | 3.105 | 23.692 | 932 |

### Held-out range — seven_day

Conditional (each estimator on the instants it can answer):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 9326 | 99.3% | 9234 | 28 | 1664 | 1425 | 5352 | 793 | 0.539 | 0.677 | 0.600 | 14.4 | 1507.7 | 0.150 |
| lifetime | 9326 | 88.6% | 8257 | 28 | 2164 | 1642 | 4363 | 88 | 0.569 | 0.961 | 0.714 | -594.3 | 1176.0 | 0.117 |
| naive | 9326 | 100.0% | 9295 | 28 | 909 | 971 | 5863 | 1552 | 0.484 | 0.369 | 0.419 | -1014.1 | 1222.0 | 0.121 |

Coverage:

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| ols | 9260 | 66 | 0 | 0 | 0 | 9326 |
| lifetime | 8263 | 0 | 0 | 1056 | 7 | 9326 |
| naive | 9323 | 3 | 0 | 0 | 0 | 9326 |

Common cohort (instants every estimator answered):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 8253 | 100.0% | 8253 | 0 | 1664 | 1424 | 4577 | 588 | 0.539 | 0.739 | 0.623 | 14.4 | 1507.7 | 0.150 |
| lifetime | 8253 | 100.0% | 8253 | 0 | 2164 | 1640 | 4361 | 88 | 0.569 | 0.961 | 0.715 | -594.3 | 1176.0 | 0.117 |
| naive | 8253 | 100.0% | 8253 | 0 | 909 | 971 | 5030 | 1343 | 0.484 | 0.404 | 0.440 | -1014.1 | 1222.0 | 0.121 |

Lead time (common cohort):

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| ols | <30m | 13 | 0 | 1.000 | 99.4 | 2 |
| ols | 30m-2h | 41 | 3 | 0.932 | 216.0 | 0 |
| ols | 2h-12h | 141 | 142 | 0.498 | 1281.0 | 141 |
| ols | 12h-48h | 662 | 296 | 0.691 | 323.7 | 349 |
| ols | >48h | 807 | 147 | 0.846 | -1407.2 | 932 |
| lifetime | <30m | 13 | 0 | 1.000 | 54.5 | 0 |
| lifetime | 30m-2h | 44 | 0 | 1.000 | 84.7 | 136 |
| lifetime | 2h-12h | 283 | 0 | 1.000 | 349.6 | 121 |
| lifetime | 12h-48h | 911 | 47 | 0.951 | -483.4 | 710 |
| lifetime | >48h | 913 | 41 | 0.957 | -1537.7 | 673 |
| naive | <30m | 13 | 0 | 1.000 | 36.0 | 0 |
| naive | 30m-2h | 35 | 9 | 0.795 | -1.0 | 8 |
| naive | 2h-12h | 150 | 133 | 0.530 | -8.2 | 281 |
| naive | 12h-48h | 231 | 727 | 0.241 | -843.3 | 436 |
| naive | >48h | 480 | 474 | 0.503 | -2588.0 | 246 |

Macro F1 (per-account, equal weight; common cohort):

| estimator | macro F1 |
|---|---:|
| ols | 0.564 |
| lifetime | 0.631 |
| naive | 0.390 |

By provider (common cohort):

| provider | estimator | scored | TP | FP | TN | FN | F1 | median abs err (min) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic | ols | 6316 | 1355 | 1237 | 3174 | 550 | 0.603 | 1648.1 |
| anthropic | lifetime | 6316 | 1900 | 1394 | 3017 | 5 | 0.731 | 1028.4 |
| anthropic | naive | 6316 | 690 | 755 | 3656 | 1215 | 0.412 | 1694.5 |
| codex | ols | 1937 | 309 | 187 | 1403 | 38 | 0.733 | 620.5 |
| codex | lifetime | 1937 | 264 | 246 | 1344 | 83 | 0.616 | 1693.1 |
| codex | naive | 1937 | 219 | 216 | 1374 | 128 | 0.560 | 808.4 |

Per-account contribution:

| account | provider | instants | scored | actual positives |
|---|---|---:|---:|---:|
| 1135d045-b26c-4118-8db2-00f0f0ecdf9b | anthropic | 1650 | 1623 | 805 |
| 1cae47ec-5813-41bc-837d-4f209e2ae1e7 | codex | 2418 | 2417 | 527 |
| 2acdf5e9-8298-42d5-816b-baecdb4498ca | anthropic | 1664 | 1664 | 584 |
| 4b3a18eb-5acb-4e1d-bb48-b3b36e29437a | anthropic | 2088 | 2088 | 0 |
| ae9e13bd-0a0d-4044-addb-5920075cd70f | anthropic | 1505 | 1505 | 545 |
| fb5944a3-df9e-49cd-b1d6-294988cd0fc4 | anthropic | 1 | 1 | 0 |

Bootstrap (accounts resampled with replacement):

| comparison | statistic | p2.5 | median | p97.5 | resamples |
|---|---|---:|---:|---:|---:|
| lifetime minus ols | f1 | -0.052 | 0.091 | 0.249 | 1000 |
| lifetime minus ols | medianAbsErrorMinutes | -694.618 | -331.739 | 405.869 | 998 |
| naive minus ols | f1 | -0.267 | -0.183 | -0.084 | 1000 |
| naive minus ols | medianAbsErrorMinutes | -473.439 | -178.283 | 530.178 | 998 |

## 429 diagnostic (label quality only)

Count of `requests` rows with `status_code = 429` falling inside windows this harness labelled `survived`. A high count would mean the polled percent missed real exhaustions. This is NEVER an input to a label.

| account | provider | window | survived windows | with a 429 | 429 requests |
|---|---|---|---:|---:|---:|
| 1135d045-b26c-4118-8db2-00f0f0ecdf9b | anthropic | five_hour | 404 | 14 | 37 |
| 1135d045-b26c-4118-8db2-00f0f0ecdf9b | anthropic | seven_day | 19 | 7 | 88 |
| 1cae47ec-5813-41bc-837d-4f209e2ae1e7 | codex | five_hour | 19226 | 1 | 4 |
| 1cae47ec-5813-41bc-837d-4f209e2ae1e7 | codex | seven_day | 61 | 1 | 8 |
| 2acdf5e9-8298-42d5-816b-baecdb4498ca | anthropic | five_hour | 240 | 18 | 55 |
| 2acdf5e9-8298-42d5-816b-baecdb4498ca | anthropic | seven_day | 12 | 5 | 75 |
| 4b3a18eb-5acb-4e1d-bb48-b3b36e29437a | anthropic | five_hour | 150 | 2 | 4 |
| 4b3a18eb-5acb-4e1d-bb48-b3b36e29437a | anthropic | seven_day | 6 | 1 | 2 |
| ae9e13bd-0a0d-4044-addb-5920075cd70f | anthropic | five_hour | 395 | 29 | 103 |
| ae9e13bd-0a0d-4044-addb-5920075cd70f | anthropic | seven_day | 17 | 6 | 45 |
| fb5944a3-df9e-49cd-b1d6-294988cd0fc4 | anthropic | five_hour | 12 | 0 | 0 |
| fb5944a3-df9e-49cd-b1d6-294988cd0fc4 | anthropic | seven_day | 1 | 0 | 0 |

## Notes

- Codex accounts contribute `five_hour` instants, but OpenAI retired that window: the stored `five_hour_reset` moves forward on every poll (stamped ~2 min in the PAST) while the percent stays 0. Each poll therefore forms its own one-sample window, which inflates codex's five-hour instant and survived-window counts. Those instants carry no exhaustion signal; codex drops out of the five-hour common cohort on its own because the lifetime baseline cannot answer at 0%.
- Replay took 3.7 s; scoring and bootstrap 113.1 s.
