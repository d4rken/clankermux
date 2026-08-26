# ClankerMux usage-prediction backtest

Generated: 2026-08-26T09:29:04.889Z

Reproduce with:

```
bun scripts/prediction-backtest.ts --from=2026-06-02T00:00:00Z --split=2026-08-01T00:00:00Z --to=2026-08-26T00:00:00Z --window=seven_day --estimators=ols,lifetime,naive,trailing-3d,trailing-7d,dow-seasonal,trailing-7d-else-lifetime --out=docs/prediction-backtest-composite.md
```

| config | value |
|---|---|
| bootstrapIterations | 1000 |
| estimators | ols,lifetime,naive,trailing-3d,trailing-7d,dow-seasonal,trailing-7d-else-lifetime |
| from | 2026-06-02T00:00:00.000Z |
| loadPadBeforeHours | 672 |
| seed | 20260823 |
| split | 2026-08-01T00:00:00Z |
| stepMinutes | 10 |
| to | 2026-08-26T00:00:00.000Z |
| windows | seven_day |

## Dataset

| field | value |
|---|---|
| usage_snapshots rows | 162910 |
| accounts | 6 |
| providers | anthropic, codex |
| first sample | 2026-06-02T12:48:00.294Z |
| last sample | 2026-08-26T09:24:17.304Z |

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
- **Deployment cohort.** Selection and the held-out gate score only instants
  where the window's reset was known and still ahead, because that is the only
  case in which production renders a projection at all. "Known" is
  POINT-IN-TIME: the `resets_at` the newest sample at or before `T` carried,
  never the one the finished window turned out to have. The cohort is a
  property of the DATA, so every estimator is judged on the same instants.
- **Abstentions are negatives for selection.** On the deployment cohort an
  unusable estimate is scored as "no exhaustion predicted", which is what the
  screen would show. Scoring each estimator only on the instants it chose to
  answer rewards refusing the hard ones. Coverage is still reported separately.
- **Display red rule.** The red/amber threshold the dashboard applies
  (projected exhaustion clearing the reset by more than a tenth of the window)
  is scored separately, because that rule, not the estimator's own boolean, is
  what a user experiences as a false alarm.

## Tuning range

Scoring interval: `[2026-06-02T00:00:00.000Z, 2026-08-01T00:00:00.000Z)`

### Tuning range — seven_day

Selection scoring (deployment cohort; an abstention counts as a
silent screen, i.e. a predicted NON-exhaustion):

| estimator | instants | TP | FP | TN | FN | selection F1 | median abs err (min) | macro F1 | usable coverage |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 17977 | 4035 | 3777 | 8501 | 1664 | 0.597 | 1476.3 | 0.613 | 100.0% |
| lifetime | 17977 | 3803 | 3085 | 9193 | 1896 | 0.604 | 1865.6 | 0.544 | 100.0% |
| naive | 17977 | 2270 | 2724 | 9554 | 3429 | 0.425 | 1126.0 | 0.436 | 99.8% |
| trailing-3d | 17977 | 3496 | 3434 | 8844 | 2203 | 0.554 | 1024.7 | 0.543 | 89.0% |
| trailing-7d | 17977 | 2478 | 3093 | 9185 | 3221 | 0.440 | 2378.9 | 0.347 | 79.9% |
| dow-seasonal | 17977 | 2966 | 3106 | 9172 | 2733 | 0.504 | 1688.9 | 0.449 | 73.4% |
| trailing-7d-else-lifetime | 17977 | 3531 | 3275 | 9003 | 2168 | 0.565 | 2367.1 | 0.518 | 100.0% |

Winner: **lifetime** (locked on Tuning range)

Balance warning: pooled F1 favours lifetime but per-account macro F1 favours ols; the pooled number is account-weighted

Held-out gate:

| estimator | verdict | criterion | pass | detail |
|---|---|---|---|---|
| lifetime | FAIL | F1 at least every baseline | yes | lifetime F1 0.604; at least ols (0.597), lifetime (0.604), naive (0.425) |
| lifetime | FAIL | median absolute ETA error no worse than ols | no | lifetime 1865.6 min vs ols 1476.3 min |
| lifetime | FAIL | usable coverage within 2 points of ols | yes | lifetime 1.000 vs ols 1.000 |
| trailing-3d | FAIL | F1 at least every baseline | no | trailing-3d F1 0.554; below ols (0.597), lifetime (0.604) |
| trailing-3d | FAIL | median absolute ETA error no worse than ols | yes | trailing-3d 1024.7 min vs ols 1476.3 min |
| trailing-3d | FAIL | usable coverage within 2 points of ols | no | trailing-3d 0.890 vs ols 1.000 |
| trailing-7d | FAIL | F1 at least every baseline | no | trailing-7d F1 0.440; below ols (0.597), lifetime (0.604) |
| trailing-7d | FAIL | median absolute ETA error no worse than ols | no | trailing-7d 2378.9 min vs ols 1476.3 min |
| trailing-7d | FAIL | usable coverage within 2 points of ols | no | trailing-7d 0.799 vs ols 1.000 |
| dow-seasonal | FAIL | F1 at least every baseline | no | dow-seasonal F1 0.504; below ols (0.597), lifetime (0.604) |
| dow-seasonal | FAIL | median absolute ETA error no worse than ols | no | dow-seasonal 1688.9 min vs ols 1476.3 min |
| dow-seasonal | FAIL | usable coverage within 2 points of ols | no | dow-seasonal 0.734 vs ols 1.000 |
| trailing-7d-else-lifetime | FAIL | F1 at least every baseline | no | trailing-7d-else-lifetime F1 0.565; below ols (0.597), lifetime (0.604) |
| trailing-7d-else-lifetime | FAIL | median absolute ETA error no worse than ols | no | trailing-7d-else-lifetime 2367.1 min vs ols 1476.3 min |
| trailing-7d-else-lifetime | FAIL | usable coverage within 2 points of ols | yes | trailing-7d-else-lifetime 1.000 vs ols 1.000 |

Display red rule (what a user would actually see as an alarm):

| estimator | margin fraction | scored | TP | FP | TN | FN | precision |
|---|---:|---:|---:|---:|---:|---:|---:|
| lifetime | 0.1 | 17977 | 3350 | 2621 | 9657 | 2349 | 0.561 |
| trailing-3d | 0.1 | 17977 | 3349 | 2607 | 9671 | 2350 | 0.562 |
| trailing-7d | 0.1 | 17977 | 2280 | 2546 | 9732 | 3419 | 0.472 |
| dow-seasonal | 0.1 | 17977 | 2892 | 2372 | 9906 | 2807 | 0.549 |
| trailing-7d-else-lifetime | 0.1 | 17977 | 3011 | 2697 | 9581 | 2688 | 0.528 |
| ols | 0.1 | 17977 | 3694 | 3162 | 9116 | 2005 | 0.539 |

Selection bootstrap (accounts resampled with replacement):

| comparison | statistic | p2.5 | median | p97.5 | resamples |
|---|---|---:|---:|---:|---:|
| lifetime minus ols (selection) | f1 | -0.088 | 0.007 | 0.139 | 1000 |
| lifetime minus ols (selection) | medianAbsErrorMinutes | -762.793 | 389.280 | 1122.529 | 1000 |

Conditional (each estimator on the instants it can answer):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 19378 | 99.8% | 18003 | 1351 | 4035 | 3777 | 8528 | 1663 | 0.517 | 0.708 | 0.597 | 411.2 | 1476.3 | 0.146 |
| lifetime | 19378 | 99.7% | 17977 | 1351 | 3803 | 3085 | 9193 | 1896 | 0.552 | 0.667 | 0.604 | 780.3 | 1865.6 | 0.185 |
| naive | 19378 | 99.2% | 17989 | 1351 | 2270 | 2724 | 9597 | 3398 | 0.455 | 0.400 | 0.426 | -702.0 | 1126.0 | 0.112 |
| trailing-3d | 19378 | 86.7% | 16008 | 1351 | 3496 | 3434 | 7833 | 1245 | 0.504 | 0.737 | 0.599 | 188.4 | 1024.7 | 0.102 |
| trailing-7d | 19378 | 77.6% | 14356 | 1351 | 2478 | 3093 | 7249 | 1536 | 0.445 | 0.617 | 0.517 | 1272.0 | 2378.9 | 0.236 |
| dow-seasonal | 19378 | 71.4% | 13199 | 1351 | 2966 | 3106 | 5851 | 1276 | 0.488 | 0.699 | 0.575 | 61.7 | 1688.9 | 0.168 |
| trailing-7d-else-lifetime | 19378 | 99.7% | 17977 | 1351 | 3531 | 3275 | 9003 | 2168 | 0.519 | 0.620 | 0.565 | 1330.4 | 2367.1 | 0.235 |

Coverage:

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| ols | 19341 | 37 | 0 | 0 | 0 | 19378 |
| lifetime | 19328 | 0 | 0 | 0 | 50 | 19378 |
| naive | 19227 | 150 | 1 | 0 | 0 | 19378 |
| trailing-3d | 16801 | 2527 | 0 | 0 | 50 | 19378 |
| trailing-7d | 15033 | 4295 | 0 | 0 | 50 | 19378 |
| dow-seasonal | 13838 | 5490 | 0 | 0 | 50 | 19378 |
| trailing-7d-else-lifetime | 19328 | 0 | 0 | 0 | 50 | 19378 |

Common cohort (instants every estimator answered):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 12151 | 100.0% | 12151 | 0 | 2582 | 2814 | 5485 | 1270 | 0.479 | 0.670 | 0.558 | 396.5 | 1545.3 | 0.153 |
| lifetime | 12151 | 100.0% | 12151 | 0 | 2589 | 2758 | 5541 | 1263 | 0.484 | 0.672 | 0.563 | 431.4 | 1581.8 | 0.157 |
| naive | 12151 | 100.0% | 12151 | 0 | 1436 | 1668 | 6631 | 2416 | 0.463 | 0.373 | 0.413 | -766.1 | 1218.1 | 0.121 |
| trailing-3d | 12151 | 100.0% | 12151 | 0 | 2607 | 2789 | 5510 | 1245 | 0.483 | 0.677 | 0.564 | 178.4 | 1152.2 | 0.114 |
| trailing-7d | 12151 | 100.0% | 12151 | 0 | 2316 | 2849 | 5450 | 1536 | 0.448 | 0.601 | 0.514 | 1545.7 | 2487.4 | 0.247 |
| dow-seasonal | 12151 | 100.0% | 12151 | 0 | 2576 | 2896 | 5403 | 1276 | 0.471 | 0.669 | 0.553 | 123.3 | 1908.6 | 0.189 |
| trailing-7d-else-lifetime | 12151 | 100.0% | 12151 | 0 | 2316 | 2849 | 5450 | 1536 | 0.448 | 0.601 | 0.514 | 1545.7 | 2487.4 | 0.247 |

Lead time (common cohort):

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| ols | <30m | 21 | 0 | 1.000 | 62.4 | 18 |
| ols | 30m-2h | 59 | 3 | 0.952 | 316.1 | 50 |
| ols | 2h-12h | 287 | 125 | 0.697 | 2508.8 | 189 |
| ols | 12h-48h | 1187 | 226 | 0.840 | 264.3 | 1658 |
| ols | >48h | 1028 | 916 | 0.529 | 460.9 | 899 |
| lifetime | <30m | 21 | 0 | 1.000 | 64.4 | 0 |
| lifetime | 30m-2h | 62 | 0 | 1.000 | 158.4 | 63 |
| lifetime | 2h-12h | 411 | 1 | 0.998 | 1027.9 | 197 |
| lifetime | 12h-48h | 1098 | 315 | 0.777 | 515.8 | 1622 |
| lifetime | >48h | 997 | 947 | 0.513 | -455.2 | 876 |
| naive | <30m | 21 | 0 | 1.000 | 25.0 | 7 |
| naive | 30m-2h | 58 | 4 | 0.935 | 28.0 | 34 |
| naive | 2h-12h | 236 | 176 | 0.573 | 48.7 | 499 |
| naive | 12h-48h | 463 | 950 | 0.328 | -703.3 | 866 |
| naive | >48h | 658 | 1286 | 0.338 | -2245.2 | 262 |
| trailing-3d | <30m | 21 | 0 | 1.000 | 74.0 | 0 |
| trailing-3d | 30m-2h | 62 | 0 | 1.000 | 197.4 | 63 |
| trailing-3d | 2h-12h | 410 | 2 | 0.995 | 957.0 | 106 |
| trailing-3d | 12h-48h | 1165 | 248 | 0.824 | 229.9 | 1308 |
| trailing-3d | >48h | 949 | 995 | 0.488 | -663.7 | 1312 |
| trailing-7d | <30m | 21 | 0 | 1.000 | 75.5 | 0 |
| trailing-7d | 30m-2h | 62 | 0 | 1.000 | 186.3 | 63 |
| trailing-7d | 2h-12h | 328 | 84 | 0.796 | 1161.3 | 92 |
| trailing-7d | 12h-48h | 1017 | 396 | 0.720 | 1054.0 | 1346 |
| trailing-7d | >48h | 888 | 1056 | 0.457 | 3377.4 | 1348 |
| dow-seasonal | <30m | 21 | 0 | 1.000 | 76.5 | 0 |
| dow-seasonal | 30m-2h | 60 | 2 | 0.968 | 181.5 | 62 |
| dow-seasonal | 2h-12h | 352 | 60 | 0.854 | 1295.7 | 102 |
| dow-seasonal | 12h-48h | 1076 | 337 | 0.762 | 338.2 | 1201 |
| dow-seasonal | >48h | 1067 | 877 | 0.549 | -1124.2 | 1531 |
| trailing-7d-else-lifetime | <30m | 21 | 0 | 1.000 | 75.5 | 0 |
| trailing-7d-else-lifetime | 30m-2h | 62 | 0 | 1.000 | 186.3 | 63 |
| trailing-7d-else-lifetime | 2h-12h | 328 | 84 | 0.796 | 1161.3 | 92 |
| trailing-7d-else-lifetime | 12h-48h | 1017 | 396 | 0.720 | 1054.0 | 1346 |
| trailing-7d-else-lifetime | >48h | 888 | 1056 | 0.457 | 3377.4 | 1348 |

Macro F1 (per-account, equal weight; common cohort):

| estimator | macro F1 |
|---|---:|
| ols | 0.451 |
| lifetime | 0.481 |
| naive | 0.319 |
| trailing-3d | 0.491 |
| trailing-7d | 0.472 |
| dow-seasonal | 0.483 |
| trailing-7d-else-lifetime | 0.472 |

By provider (common cohort):

| provider | estimator | scored | TP | FP | TN | FN | F1 | median abs err (min) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic | ols | 10392 | 2307 | 1914 | 5071 | 1100 | 0.605 | 1577.4 |
| anthropic | lifetime | 10392 | 2280 | 1829 | 5156 | 1127 | 0.607 | 1601.0 |
| anthropic | naive | 10392 | 1302 | 1152 | 5833 | 2105 | 0.444 | 1213.2 |
| anthropic | trailing-3d | 10392 | 2217 | 1877 | 5108 | 1190 | 0.591 | 1461.3 |
| anthropic | trailing-7d | 10392 | 1926 | 1937 | 5048 | 1481 | 0.530 | 2749.1 |
| anthropic | dow-seasonal | 10392 | 2186 | 1904 | 5081 | 1221 | 0.583 | 1605.6 |
| anthropic | trailing-7d-else-lifetime | 10392 | 1926 | 1937 | 5048 | 1481 | 0.530 | 2749.1 |
| codex | ols | 1759 | 275 | 900 | 414 | 170 | 0.340 | 899.2 |
| codex | lifetime | 1759 | 309 | 929 | 385 | 136 | 0.367 | 1511.3 |
| codex | naive | 1759 | 134 | 516 | 798 | 311 | 0.245 | 1238.6 |
| codex | trailing-3d | 1759 | 390 | 912 | 402 | 55 | 0.446 | 531.7 |
| codex | trailing-7d | 1759 | 390 | 912 | 402 | 55 | 0.446 | 885.7 |
| codex | dow-seasonal | 1759 | 390 | 992 | 322 | 55 | 0.427 | 2169.2 |
| codex | trailing-7d-else-lifetime | 1759 | 390 | 912 | 402 | 55 | 0.446 | 885.7 |

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
| lifetime minus ols | f1 | -0.009 | 0.004 | 0.057 | 1000 |
| lifetime minus ols | medianAbsErrorMinutes | -319.426 | 87.000 | 525.657 | 998 |
| naive minus ols | f1 | -0.187 | -0.146 | -0.105 | 1000 |
| naive minus ols | medianAbsErrorMinutes | -687.702 | -327.217 | 404.609 | 998 |
| trailing-3d minus ols | f1 | -0.025 | 0.005 | 0.113 | 1000 |
| trailing-3d minus ols | medianAbsErrorMinutes | -549.547 | -286.685 | 442.963 | 998 |
| trailing-7d minus ols | f1 | -0.101 | -0.045 | 0.115 | 1000 |
| trailing-7d minus ols | medianAbsErrorMinutes | -454.740 | 816.394 | 1414.759 | 998 |
| dow-seasonal minus ols | f1 | -0.038 | -0.005 | 0.096 | 1000 |
| dow-seasonal minus ols | medianAbsErrorMinutes | -749.253 | 363.239 | 1991.371 | 998 |
| trailing-7d-else-lifetime minus ols | f1 | -0.101 | -0.045 | 0.115 | 1000 |
| trailing-7d-else-lifetime minus ols | medianAbsErrorMinutes | -454.740 | 816.394 | 1414.759 | 998 |

## Held-out range

Scoring interval: `[2026-08-01T00:00:00.000Z, 2026-08-26T00:00:00.000Z)`

### Held-out range — seven_day

Selection scoring (deployment cohort; an abstention counts as a
silent screen, i.e. a predicted NON-exhaustion):

| estimator | instants | TP | FP | TN | FN | selection F1 | median abs err (min) | macro F1 | usable coverage |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 13279 | 1664 | 3860 | 6958 | 797 | 0.417 | 1507.7 | 0.338 | 100.0% |
| lifetime | 13279 | 2164 | 4972 | 5846 | 297 | 0.451 | 1176.0 | 0.418 | 100.0% |
| naive | 13279 | 909 | 2076 | 8742 | 1552 | 0.334 | 1222.0 | 0.258 | 100.0% |
| trailing-3d | 13279 | 1484 | 3847 | 6971 | 977 | 0.381 | 1262.4 | 0.348 | 97.7% |
| trailing-7d | 13279 | 2193 | 4644 | 6174 | 268 | 0.472 | 960.9 | 0.431 | 97.7% |
| dow-seasonal | 13279 | 2232 | 5287 | 5531 | 229 | 0.447 | 673.5 | 0.401 | 95.0% |
| trailing-7d-else-lifetime | 13279 | 2193 | 4644 | 6174 | 268 | 0.472 | 960.9 | 0.431 | 100.0% |

Winner: **lifetime** (locked on Tuning range)

Held-out gate:

| estimator | verdict | criterion | pass | detail |
|---|---|---|---|---|
| lifetime | PASS | F1 at least every baseline | yes | lifetime F1 0.451; at least ols (0.417), lifetime (0.451), naive (0.334) |
| lifetime | PASS | median absolute ETA error no worse than ols | yes | lifetime 1176.0 min vs ols 1507.7 min |
| lifetime | PASS | usable coverage within 2 points of ols | yes | lifetime 1.000 vs ols 1.000 |
| trailing-3d | FAIL | F1 at least every baseline | no | trailing-3d F1 0.381; below ols (0.417), lifetime (0.451) |
| trailing-3d | FAIL | median absolute ETA error no worse than ols | yes | trailing-3d 1262.4 min vs ols 1507.7 min |
| trailing-3d | FAIL | usable coverage within 2 points of ols | no | trailing-3d 0.977 vs ols 1.000 |
| trailing-7d | FAIL | F1 at least every baseline | yes | trailing-7d F1 0.472; at least ols (0.417), lifetime (0.451), naive (0.334) |
| trailing-7d | FAIL | median absolute ETA error no worse than ols | yes | trailing-7d 960.9 min vs ols 1507.7 min |
| trailing-7d | FAIL | usable coverage within 2 points of ols | no | trailing-7d 0.977 vs ols 1.000 |
| dow-seasonal | FAIL | F1 at least every baseline | no | dow-seasonal F1 0.447; below lifetime (0.451) |
| dow-seasonal | FAIL | median absolute ETA error no worse than ols | yes | dow-seasonal 673.5 min vs ols 1507.7 min |
| dow-seasonal | FAIL | usable coverage within 2 points of ols | no | dow-seasonal 0.950 vs ols 1.000 |
| trailing-7d-else-lifetime | PASS | F1 at least every baseline | yes | trailing-7d-else-lifetime F1 0.472; at least ols (0.417), lifetime (0.451), naive (0.334) |
| trailing-7d-else-lifetime | PASS | median absolute ETA error no worse than ols | yes | trailing-7d-else-lifetime 960.9 min vs ols 1507.7 min |
| trailing-7d-else-lifetime | PASS | usable coverage within 2 points of ols | yes | trailing-7d-else-lifetime 1.000 vs ols 1.000 |

Display red rule (what a user would actually see as an alarm):

| estimator | margin fraction | scored | TP | FP | TN | FN | precision |
|---|---:|---:|---:|---:|---:|---:|---:|
| lifetime | 0.1 | 13279 | 1964 | 3681 | 7137 | 497 | 0.348 |
| trailing-3d | 0.1 | 13279 | 1461 | 3018 | 7800 | 1000 | 0.326 |
| trailing-7d | 0.1 | 13279 | 1786 | 3417 | 7401 | 675 | 0.343 |
| dow-seasonal | 0.1 | 13279 | 1942 | 4218 | 6600 | 519 | 0.315 |
| trailing-7d-else-lifetime | 0.1 | 13279 | 1786 | 3417 | 7401 | 675 | 0.343 |
| ols | 0.1 | 13279 | 1615 | 2943 | 7875 | 846 | 0.354 |

Selection bootstrap (accounts resampled with replacement):

| comparison | statistic | p2.5 | median | p97.5 | resamples |
|---|---|---:|---:|---:|---:|
| lifetime minus ols (selection) | f1 | -0.054 | 0.034 | 0.143 | 1000 |
| lifetime minus ols (selection) | medianAbsErrorMinutes | -694.618 | -344.905 | 461.352 | 998 |

- The in-range ranking would have picked trailing-7d; the winner stays locked to lifetime from Tuning range.

Conditional (each estimator on the instants it can answer):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 13615 | 99.9% | 13277 | 324 | 1664 | 3860 | 6956 | 797 | 0.301 | 0.676 | 0.417 | 14.4 | 1507.7 | 0.150 |
| lifetime | 13615 | 99.9% | 13279 | 324 | 2164 | 4972 | 5846 | 297 | 0.303 | 0.879 | 0.451 | -594.3 | 1176.0 | 0.117 |
| naive | 13615 | 99.9% | 13284 | 324 | 909 | 2076 | 8747 | 1552 | 0.305 | 0.369 | 0.334 | -1014.1 | 1222.0 | 0.121 |
| trailing-3d | 13615 | 97.7% | 12972 | 324 | 1484 | 3847 | 6664 | 977 | 0.278 | 0.603 | 0.381 | 536.9 | 1262.4 | 0.125 |
| trailing-7d | 13615 | 97.6% | 12968 | 324 | 2193 | 4644 | 5863 | 268 | 0.321 | 0.891 | 0.472 | 746.9 | 960.9 | 0.095 |
| dow-seasonal | 13615 | 95.0% | 12609 | 324 | 2232 | 5287 | 4861 | 229 | 0.297 | 0.907 | 0.447 | 20.3 | 673.5 | 0.067 |
| trailing-7d-else-lifetime | 13615 | 99.9% | 13279 | 324 | 2193 | 4644 | 6174 | 268 | 0.321 | 0.891 | 0.472 | 746.9 | 960.9 | 0.095 |

Coverage:

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| ols | 13601 | 13 | 0 | 0 | 1 | 13615 |
| lifetime | 13603 | 0 | 0 | 0 | 12 | 13615 |
| naive | 13604 | 10 | 0 | 0 | 1 | 13615 |
| trailing-3d | 13296 | 307 | 0 | 0 | 12 | 13615 |
| trailing-7d | 13292 | 311 | 0 | 0 | 12 | 13615 |
| dow-seasonal | 12933 | 670 | 0 | 0 | 12 | 13615 |
| trailing-7d-else-lifetime | 13603 | 0 | 0 | 0 | 12 | 13615 |

Common cohort (instants every estimator answered):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 12493 | 100.0% | 12493 | 0 | 1664 | 3488 | 6544 | 797 | 0.323 | 0.676 | 0.437 | 14.4 | 1507.7 | 0.150 |
| lifetime | 12493 | 100.0% | 12493 | 0 | 2164 | 4605 | 5427 | 297 | 0.320 | 0.879 | 0.469 | -594.3 | 1176.0 | 0.117 |
| naive | 12493 | 100.0% | 12493 | 0 | 909 | 1809 | 8223 | 1552 | 0.334 | 0.369 | 0.351 | -1014.1 | 1222.0 | 0.121 |
| trailing-3d | 12493 | 100.0% | 12493 | 0 | 1484 | 3691 | 6341 | 977 | 0.287 | 0.603 | 0.389 | 536.9 | 1262.4 | 0.125 |
| trailing-7d | 12493 | 100.0% | 12493 | 0 | 2193 | 4232 | 5800 | 268 | 0.341 | 0.891 | 0.494 | 746.9 | 960.9 | 0.095 |
| dow-seasonal | 12493 | 100.0% | 12493 | 0 | 2232 | 5172 | 4860 | 229 | 0.301 | 0.907 | 0.453 | 20.3 | 673.5 | 0.067 |
| trailing-7d-else-lifetime | 12493 | 100.0% | 12493 | 0 | 2193 | 4232 | 5800 | 268 | 0.341 | 0.891 | 0.494 | 746.9 | 960.9 | 0.095 |

Lead time (common cohort):

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| ols | <30m | 13 | 0 | 1.000 | 99.4 | 5 |
| ols | 30m-2h | 41 | 3 | 0.932 | 216.0 | 4 |
| ols | 2h-12h | 141 | 142 | 0.498 | 1281.0 | 229 |
| ols | 12h-48h | 662 | 296 | 0.691 | 323.7 | 1829 |
| ols | >48h | 807 | 356 | 0.694 | -1407.2 | 1421 |
| lifetime | <30m | 13 | 0 | 1.000 | 54.5 | 0 |
| lifetime | 30m-2h | 44 | 0 | 1.000 | 84.7 | 136 |
| lifetime | 2h-12h | 283 | 0 | 1.000 | 349.6 | 1295 |
| lifetime | 12h-48h | 911 | 47 | 0.951 | -483.4 | 2182 |
| lifetime | >48h | 913 | 250 | 0.785 | -1537.7 | 992 |
| naive | <30m | 13 | 0 | 1.000 | 36.0 | 4 |
| naive | 30m-2h | 35 | 9 | 0.795 | -1.0 | 27 |
| naive | 2h-12h | 150 | 133 | 0.530 | -8.2 | 534 |
| naive | 12h-48h | 231 | 727 | 0.241 | -843.3 | 872 |
| naive | >48h | 480 | 683 | 0.413 | -2588.0 | 372 |
| trailing-3d | <30m | 13 | 0 | 1.000 | 74.0 | 0 |
| trailing-3d | 30m-2h | 37 | 7 | 0.841 | 130.0 | 2 |
| trailing-3d | 2h-12h | 225 | 58 | 0.795 | 630.9 | 702 |
| trailing-3d | 12h-48h | 683 | 275 | 0.713 | -114.6 | 1798 |
| trailing-3d | >48h | 526 | 637 | 0.452 | 2735.2 | 1189 |
| trailing-7d | <30m | 13 | 0 | 1.000 | 86.3 | 0 |
| trailing-7d | 30m-2h | 44 | 0 | 1.000 | 126.2 | 136 |
| trailing-7d | 2h-12h | 283 | 0 | 1.000 | 611.7 | 1144 |
| trailing-7d | 12h-48h | 958 | 0 | 1.000 | 443.0 | 1518 |
| trailing-7d | >48h | 895 | 268 | 0.770 | 1591.2 | 1434 |
| dow-seasonal | <30m | 13 | 0 | 1.000 | 88.6 | 0 |
| dow-seasonal | 30m-2h | 44 | 0 | 1.000 | 148.4 | 30 |
| dow-seasonal | 2h-12h | 283 | 0 | 1.000 | 367.3 | 636 |
| dow-seasonal | 12h-48h | 958 | 0 | 1.000 | -223.4 | 2043 |
| dow-seasonal | >48h | 934 | 229 | 0.803 | 194.4 | 2463 |
| trailing-7d-else-lifetime | <30m | 13 | 0 | 1.000 | 86.3 | 0 |
| trailing-7d-else-lifetime | 30m-2h | 44 | 0 | 1.000 | 126.2 | 136 |
| trailing-7d-else-lifetime | 2h-12h | 283 | 0 | 1.000 | 611.7 | 1144 |
| trailing-7d-else-lifetime | 12h-48h | 958 | 0 | 1.000 | 443.0 | 1518 |
| trailing-7d-else-lifetime | >48h | 895 | 268 | 0.770 | 1591.2 | 1434 |

Macro F1 (per-account, equal weight; common cohort):

| estimator | macro F1 |
|---|---:|
| ols | 0.413 |
| lifetime | 0.426 |
| naive | 0.317 |
| trailing-3d | 0.348 |
| trailing-7d | 0.439 |
| dow-seasonal | 0.404 |
| trailing-7d-else-lifetime | 0.439 |

By provider (common cohort):

| provider | estimator | scored | TP | FP | TN | FN | F1 | median abs err (min) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic | ols | 10073 | 1355 | 3301 | 4838 | 579 | 0.411 | 1648.1 |
| anthropic | lifetime | 10073 | 1900 | 4359 | 3780 | 34 | 0.464 | 1028.4 |
| anthropic | naive | 10073 | 690 | 1593 | 6546 | 1244 | 0.327 | 1694.5 |
| anthropic | trailing-3d | 10073 | 1295 | 3364 | 4775 | 639 | 0.393 | 1131.1 |
| anthropic | trailing-7d | 10073 | 1846 | 3773 | 4366 | 88 | 0.489 | 1039.1 |
| anthropic | dow-seasonal | 10073 | 1885 | 3877 | 4262 | 49 | 0.490 | 924.2 |
| anthropic | trailing-7d-else-lifetime | 10073 | 1846 | 3773 | 4366 | 88 | 0.489 | 1039.1 |
| codex | ols | 2420 | 309 | 187 | 1706 | 218 | 0.604 | 620.5 |
| codex | lifetime | 2420 | 264 | 246 | 1647 | 263 | 0.509 | 1693.1 |
| codex | naive | 2420 | 219 | 216 | 1677 | 308 | 0.455 | 808.4 |
| codex | trailing-3d | 2420 | 189 | 327 | 1566 | 338 | 0.362 | 2356.4 |
| codex | trailing-7d | 2420 | 347 | 459 | 1434 | 180 | 0.521 | 775.6 |
| codex | dow-seasonal | 2420 | 347 | 1295 | 598 | 180 | 0.320 | 313.6 |
| codex | trailing-7d-else-lifetime | 2420 | 347 | 459 | 1434 | 180 | 0.521 | 775.6 |

Per-account contribution:

| account | provider | instants | scored | actual positives |
|---|---|---:|---:|---:|
| 1135d045-b26c-4118-8db2-00f0f0ecdf9b | anthropic | 2521 | 2494 | 805 |
| 1cae47ec-5813-41bc-837d-4f209e2ae1e7 | codex | 2831 | 2534 | 527 |
| 2acdf5e9-8298-42d5-816b-baecdb4498ca | anthropic | 2552 | 2552 | 584 |
| 4b3a18eb-5acb-4e1d-bb48-b3b36e29437a | anthropic | 2996 | 2996 | 0 |
| ae9e13bd-0a0d-4044-addb-5920075cd70f | anthropic | 2401 | 2401 | 545 |
| fb5944a3-df9e-49cd-b1d6-294988cd0fc4 | anthropic | 314 | 314 | 0 |

Bootstrap (accounts resampled with replacement):

| comparison | statistic | p2.5 | median | p97.5 | resamples |
|---|---|---:|---:|---:|---:|
| lifetime minus ols | f1 | -0.063 | 0.032 | 0.143 | 1000 |
| lifetime minus ols | medianAbsErrorMinutes | -694.618 | -344.905 | 461.352 | 998 |
| naive minus ols | f1 | -0.161 | -0.084 | -0.018 | 1000 |
| naive minus ols | medianAbsErrorMinutes | -459.410 | -155.578 | 530.178 | 998 |
| trailing-3d minus ols | f1 | -0.143 | -0.047 | 0.020 | 1000 |
| trailing-3d minus ols | medianAbsErrorMinutes | -778.498 | -222.719 | 980.588 | 998 |
| trailing-7d minus ols | f1 | -0.044 | 0.056 | 0.160 | 1000 |
| trailing-7d minus ols | medianAbsErrorMinutes | -868.020 | -528.079 | -129.542 | 998 |
| dow-seasonal minus ols | f1 | -0.150 | 0.017 | 0.152 | 1000 |
| dow-seasonal minus ols | medianAbsErrorMinutes | -1344.351 | -723.922 | -70.564 | 998 |
| trailing-7d-else-lifetime minus ols | f1 | -0.044 | 0.056 | 0.160 | 1000 |
| trailing-7d-else-lifetime minus ols | medianAbsErrorMinutes | -868.020 | -528.079 | -129.542 | 998 |

## 429 diagnostic (label quality only)

Count of `requests` rows with `status_code = 429` falling inside windows this harness labelled `survived`. A high count would mean the polled percent missed real exhaustions. This is NEVER an input to a label.

| account | provider | window | survived windows | with a 429 | 429 requests |
|---|---|---|---:|---:|---:|
| 1135d045-b26c-4118-8db2-00f0f0ecdf9b | anthropic | seven_day | 20 | 7 | 88 |
| 1cae47ec-5813-41bc-837d-4f209e2ae1e7 | codex | seven_day | 62 | 1 | 8 |
| 2acdf5e9-8298-42d5-816b-baecdb4498ca | anthropic | seven_day | 14 | 6 | 83 |
| 4b3a18eb-5acb-4e1d-bb48-b3b36e29437a | anthropic | seven_day | 8 | 1 | 2 |
| ae9e13bd-0a0d-4044-addb-5920075cd70f | anthropic | seven_day | 19 | 7 | 54 |
| fb5944a3-df9e-49cd-b1d6-294988cd0fc4 | anthropic | seven_day | 3 | 0 | 0 |

## Notes

- Replay took 18.3 s; scoring and bootstrap 189.0 s.
