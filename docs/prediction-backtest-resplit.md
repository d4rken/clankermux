# ClankerMux usage-prediction backtest

Generated: 2026-08-26T10:28:35.123Z

Reproduce with:

```
bun scripts/prediction-backtest.ts --from=2026-07-01T00:00:00Z --split=2026-08-12T00:00:00Z --to=2026-08-26T00:00:00Z --window=seven_day --estimators=ols,lifetime,naive,trailing-3d,trailing-7d,dow-seasonal,trailing-7d-else-lifetime --out=docs/prediction-backtest-resplit.md
```

| config | value |
|---|---|
| bootstrapIterations | 1000 |
| estimators | ols,lifetime,naive,trailing-3d,trailing-7d,dow-seasonal,trailing-7d-else-lifetime |
| from | 2026-07-01T00:00:00.000Z |
| loadPadBeforeHours | 672 |
| seed | 20260823 |
| split | 2026-08-12T00:00:00Z |
| stepMinutes | 10 |
| to | 2026-08-26T00:00:00.000Z |
| windows | seven_day |

## Dataset

| field | value |
|---|---|
| usage_snapshots rows | 163089 |
| accounts | 6 |
| providers | anthropic, codex |
| first sample | 2026-06-02T12:48:00.294Z |
| last sample | 2026-08-26T10:24:17.447Z |

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

Scoring interval: `[2026-07-01T00:00:00.000Z, 2026-08-12T00:00:00.000Z)`

### Tuning range — seven_day

Selection scoring (deployment cohort; an abstention counts as a
silent screen, i.e. a predicted NON-exhaustion):

| estimator | instants | TP | FP | TN | FN | selection F1 | median abs err (min) | macro F1 | usable coverage |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 17100 | 4203 | 4885 | 6305 | 1707 | 0.560 | 1684.8 | 0.537 | 100.0% |
| lifetime | 17100 | 4758 | 5898 | 5292 | 1152 | 0.574 | 1567.9 | 0.504 | 100.0% |
| naive | 17100 | 2238 | 2633 | 8557 | 3672 | 0.415 | 1317.0 | 0.408 | 100.0% |
| trailing-3d | 17100 | 4208 | 5066 | 6124 | 1702 | 0.554 | 1290.1 | 0.504 | 96.3% |
| trailing-7d | 17100 | 4451 | 5694 | 5496 | 1459 | 0.554 | 1266.1 | 0.479 | 93.2% |
| dow-seasonal | 17100 | 4724 | 5603 | 5587 | 1186 | 0.582 | 1336.5 | 0.491 | 91.9% |
| trailing-7d-else-lifetime | 17100 | 4830 | 5876 | 5314 | 1080 | 0.581 | 1431.5 | 0.517 | 100.0% |

Winner: **dow-seasonal** (locked on Tuning range)

Balance warning: pooled F1 favours dow-seasonal but per-account macro F1 favours ols; the pooled number is account-weighted

Held-out gate:

| estimator | verdict | criterion | pass | detail |
|---|---|---|---|---|
| dow-seasonal | FAIL | F1 at least every baseline | yes | dow-seasonal F1 0.582; at least ols (0.560), lifetime (0.574), naive (0.415) |
| dow-seasonal | FAIL | median absolute ETA error no worse than ols | yes | dow-seasonal 1336.5 min vs ols 1684.8 min |
| dow-seasonal | FAIL | usable coverage within 2 points of ols | no | dow-seasonal 0.919 vs ols 1.000 |
| trailing-3d | FAIL | F1 at least every baseline | no | trailing-3d F1 0.554; below ols (0.560), lifetime (0.574) |
| trailing-3d | FAIL | median absolute ETA error no worse than ols | yes | trailing-3d 1290.1 min vs ols 1684.8 min |
| trailing-3d | FAIL | usable coverage within 2 points of ols | no | trailing-3d 0.963 vs ols 1.000 |
| trailing-7d | FAIL | F1 at least every baseline | no | trailing-7d F1 0.554; below ols (0.560), lifetime (0.574) |
| trailing-7d | FAIL | median absolute ETA error no worse than ols | yes | trailing-7d 1266.1 min vs ols 1684.8 min |
| trailing-7d | FAIL | usable coverage within 2 points of ols | no | trailing-7d 0.932 vs ols 1.000 |
| trailing-7d-else-lifetime | PASS | F1 at least every baseline | yes | trailing-7d-else-lifetime F1 0.581; at least ols (0.560), lifetime (0.574), naive (0.415) |
| trailing-7d-else-lifetime | PASS | median absolute ETA error no worse than ols | yes | trailing-7d-else-lifetime 1431.5 min vs ols 1684.8 min |
| trailing-7d-else-lifetime | PASS | usable coverage within 2 points of ols | yes | trailing-7d-else-lifetime 1.000 vs ols 1.000 |

Display red rule (what a user would actually see as an alarm):

| estimator | margin fraction | scored | TP | FP | TN | FN | precision |
|---|---:|---:|---:|---:|---:|---:|---:|
| dow-seasonal | 0.1 | 17100 | 4380 | 4909 | 6281 | 1530 | 0.472 |
| trailing-3d | 0.1 | 17100 | 4081 | 4560 | 6630 | 1829 | 0.472 |
| trailing-7d | 0.1 | 17100 | 3999 | 4674 | 6516 | 1911 | 0.461 |
| trailing-7d-else-lifetime | 0.1 | 17100 | 4367 | 4825 | 6365 | 1543 | 0.475 |
| ols | 0.1 | 17100 | 4033 | 4190 | 7000 | 1877 | 0.490 |

Selection bootstrap (accounts resampled with replacement):

| comparison | statistic | p2.5 | median | p97.5 | resamples |
|---|---|---:|---:|---:|---:|
| dow-seasonal minus ols (selection) | f1 | -0.064 | 0.021 | 0.109 | 1000 |
| dow-seasonal minus ols (selection) | medianAbsErrorMinutes | -1566.347 | -348.326 | 792.599 | 998 |
| dow-seasonal minus lifetime (selection) | f1 | -0.030 | 0.007 | 0.056 | 1000 |
| dow-seasonal minus lifetime (selection) | medianAbsErrorMinutes | -1207.504 | -294.016 | 757.162 | 998 |

Conditional (each estimator on the instants it can answer):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 17421 | 99.9% | 17095 | 305 | 4203 | 4885 | 6300 | 1707 | 0.462 | 0.711 | 0.560 | 119.0 | 1684.8 | 0.167 |
| lifetime | 17421 | 99.9% | 17100 | 305 | 4758 | 5898 | 5292 | 1152 | 0.447 | 0.805 | 0.574 | -278.6 | 1567.9 | 0.156 |
| naive | 17421 | 99.7% | 17107 | 305 | 2238 | 2633 | 8565 | 3671 | 0.459 | 0.379 | 0.415 | -1043.7 | 1317.0 | 0.131 |
| trailing-3d | 17421 | 95.8% | 16469 | 305 | 4208 | 5066 | 5791 | 1404 | 0.454 | 0.750 | 0.565 | -73.5 | 1290.1 | 0.128 |
| trailing-7d | 17421 | 91.6% | 15944 | 305 | 4451 | 5694 | 5023 | 776 | 0.439 | 0.852 | 0.579 | 539.5 | 1266.1 | 0.126 |
| dow-seasonal | 17421 | 90.6% | 15714 | 305 | 4724 | 5603 | 4582 | 805 | 0.457 | 0.854 | 0.596 | -109.4 | 1336.5 | 0.133 |
| trailing-7d-else-lifetime | 17421 | 99.9% | 17100 | 305 | 4830 | 5876 | 5314 | 1080 | 0.451 | 0.817 | 0.581 | 538.2 | 1431.5 | 0.142 |

Coverage:

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| ols | 17397 | 23 | 0 | 0 | 1 | 17421 |
| lifetime | 17405 | 0 | 0 | 0 | 16 | 17421 |
| naive | 17370 | 49 | 1 | 0 | 1 | 17421 |
| trailing-3d | 16690 | 715 | 0 | 0 | 16 | 17421 |
| trailing-7d | 15960 | 1445 | 0 | 0 | 16 | 17421 |
| dow-seasonal | 15789 | 1616 | 0 | 0 | 16 | 17421 |
| trailing-7d-else-lifetime | 17405 | 0 | 0 | 0 | 16 | 17421 |

Common cohort (instants every estimator answered):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 15160 | 100.0% | 15160 | 0 | 3742 | 4190 | 5744 | 1484 | 0.472 | 0.716 | 0.569 | 91.8 | 1577.4 | 0.156 |
| lifetime | 15160 | 100.0% | 15160 | 0 | 4378 | 5033 | 4901 | 848 | 0.465 | 0.838 | 0.598 | -360.0 | 1453.2 | 0.144 |
| naive | 15160 | 100.0% | 15160 | 0 | 1958 | 2238 | 7696 | 3268 | 0.467 | 0.375 | 0.416 | -1223.3 | 1359.7 | 0.135 |
| trailing-3d | 15160 | 100.0% | 15160 | 0 | 3822 | 4477 | 5457 | 1404 | 0.461 | 0.731 | 0.565 | -25.7 | 1295.8 | 0.129 |
| trailing-7d | 15160 | 100.0% | 15160 | 0 | 4450 | 4973 | 4961 | 776 | 0.472 | 0.852 | 0.608 | 541.3 | 1266.1 | 0.126 |
| dow-seasonal | 15160 | 100.0% | 15160 | 0 | 4421 | 5389 | 4545 | 805 | 0.451 | 0.846 | 0.588 | -89.1 | 1519.0 | 0.151 |
| trailing-7d-else-lifetime | 15160 | 100.0% | 15160 | 0 | 4450 | 4973 | 4961 | 776 | 0.472 | 0.852 | 0.608 | 541.3 | 1266.1 | 0.126 |

Lead time (common cohort):

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| ols | <30m | 28 | 0 | 1.000 | 93.8 | 20 |
| ols | 30m-2h | 82 | 6 | 0.932 | 306.0 | 103 |
| ols | 2h-12h | 308 | 267 | 0.536 | 2228.4 | 443 |
| ols | 12h-48h | 1534 | 405 | 0.791 | 185.7 | 2241 |
| ols | >48h | 1790 | 806 | 0.690 | -1367.3 | 1383 |
| lifetime | <30m | 28 | 0 | 1.000 | 60.5 | 0 |
| lifetime | 30m-2h | 88 | 0 | 1.000 | 124.7 | 488 |
| lifetime | 2h-12h | 573 | 2 | 0.997 | 618.0 | 446 |
| lifetime | 12h-48h | 1690 | 249 | 0.872 | 11.8 | 3059 |
| lifetime | >48h | 1999 | 597 | 0.770 | -2046.4 | 1040 |
| naive | <30m | 28 | 0 | 1.000 | 32.0 | 10 |
| naive | 30m-2h | 77 | 11 | 0.875 | 14.0 | 53 |
| naive | 2h-12h | 311 | 264 | 0.541 | 25.0 | 616 |
| naive | 12h-48h | 527 | 1412 | 0.272 | -838.8 | 1189 |
| naive | >48h | 1015 | 1581 | 0.391 | -2786.1 | 370 |
| trailing-3d | <30m | 28 | 0 | 1.000 | 74.0 | 0 |
| trailing-3d | 30m-2h | 81 | 7 | 0.920 | 187.4 | 179 |
| trailing-3d | 2h-12h | 515 | 60 | 0.896 | 882.3 | 471 |
| trailing-3d | 12h-48h | 1522 | 417 | 0.785 | 67.6 | 2465 |
| trailing-3d | >48h | 1676 | 920 | 0.646 | -882.7 | 1362 |
| trailing-7d | <30m | 28 | 0 | 1.000 | 76.3 | 0 |
| trailing-7d | 30m-2h | 88 | 0 | 1.000 | 154.0 | 454 |
| trailing-7d | 2h-12h | 539 | 36 | 0.937 | 964.9 | 322 |
| trailing-7d | 12h-48h | 1723 | 216 | 0.889 | 521.3 | 2376 |
| trailing-7d | >48h | 2072 | 524 | 0.798 | 594.0 | 1821 |
| dow-seasonal | <30m | 28 | 0 | 1.000 | 87.5 | 0 |
| dow-seasonal | 30m-2h | 85 | 3 | 0.966 | 195.0 | 341 |
| dow-seasonal | 2h-12h | 515 | 60 | 0.896 | 719.0 | 469 |
| dow-seasonal | 12h-48h | 1723 | 216 | 0.889 | -102.6 | 2429 |
| dow-seasonal | >48h | 2070 | 526 | 0.797 | -796.1 | 2150 |
| trailing-7d-else-lifetime | <30m | 28 | 0 | 1.000 | 76.3 | 0 |
| trailing-7d-else-lifetime | 30m-2h | 88 | 0 | 1.000 | 154.0 | 454 |
| trailing-7d-else-lifetime | 2h-12h | 539 | 36 | 0.937 | 964.9 | 322 |
| trailing-7d-else-lifetime | 12h-48h | 1723 | 216 | 0.889 | 521.3 | 2376 |
| trailing-7d-else-lifetime | >48h | 2072 | 524 | 0.798 | 594.0 | 1821 |

Macro F1 (per-account, equal weight; common cohort):

| estimator | macro F1 |
|---|---:|
| ols | 0.475 |
| lifetime | 0.486 |
| naive | 0.339 |
| trailing-3d | 0.465 |
| trailing-7d | 0.499 |
| dow-seasonal | 0.487 |
| trailing-7d-else-lifetime | 0.499 |

By provider (common cohort):

| provider | estimator | scored | TP | FP | TN | FN | F1 | median abs err (min) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic | ols | 11767 | 3158 | 2885 | 4609 | 1115 | 0.612 | 1705.2 |
| anthropic | lifetime | 11767 | 3805 | 3489 | 4005 | 468 | 0.658 | 1404.9 |
| anthropic | naive | 11767 | 1605 | 1456 | 6038 | 2668 | 0.438 | 1729.9 |
| anthropic | trailing-3d | 11767 | 3243 | 2856 | 4638 | 1030 | 0.625 | 1458.4 |
| anthropic | trailing-7d | 11767 | 3713 | 3220 | 4274 | 560 | 0.663 | 1573.8 |
| anthropic | dow-seasonal | 11767 | 3684 | 3461 | 4033 | 589 | 0.645 | 1512.4 |
| anthropic | trailing-7d-else-lifetime | 11767 | 3713 | 3220 | 4274 | 560 | 0.663 | 1573.8 |
| codex | ols | 3393 | 584 | 1305 | 1135 | 369 | 0.411 | 716.8 |
| codex | lifetime | 3393 | 573 | 1544 | 896 | 380 | 0.373 | 1598.1 |
| codex | naive | 3393 | 353 | 782 | 1658 | 600 | 0.338 | 919.6 |
| codex | trailing-3d | 3393 | 579 | 1621 | 819 | 374 | 0.367 | 1025.2 |
| codex | trailing-7d | 3393 | 737 | 1753 | 687 | 216 | 0.428 | 848.9 |
| codex | dow-seasonal | 3393 | 737 | 1928 | 512 | 216 | 0.407 | 1608.3 |
| codex | trailing-7d-else-lifetime | 3393 | 737 | 1753 | 687 | 216 | 0.428 | 848.9 |

Per-account contribution:

| account | provider | instants | scored | actual positives |
|---|---|---:|---:|---:|
| 1135d045-b26c-4118-8db2-00f0f0ecdf9b | anthropic | 4658 | 4658 | 1772 |
| 1cae47ec-5813-41bc-837d-4f209e2ae1e7 | codex | 4086 | 3781 | 953 |
| 2acdf5e9-8298-42d5-816b-baecdb4498ca | anthropic | 2152 | 2152 | 1221 |
| 4b3a18eb-5acb-4e1d-bb48-b3b36e29437a | anthropic | 1996 | 1996 | 297 |
| ae9e13bd-0a0d-4044-addb-5920075cd70f | anthropic | 4529 | 4529 | 1667 |

Bootstrap (accounts resampled with replacement):

| comparison | statistic | p2.5 | median | p97.5 | resamples |
|---|---|---:|---:|---:|---:|
| lifetime minus ols | f1 | -0.032 | 0.028 | 0.104 | 1000 |
| lifetime minus ols | medianAbsErrorMinutes | -750.677 | -124.175 | 713.289 | 998 |
| naive minus ols | f1 | -0.214 | -0.153 | -0.096 | 1000 |
| naive minus ols | medianAbsErrorMinutes | -521.878 | -102.852 | 195.837 | 998 |
| trailing-3d minus ols | f1 | -0.058 | -0.004 | 0.046 | 1000 |
| trailing-3d minus ols | medianAbsErrorMinutes | -653.942 | -255.944 | 445.587 | 998 |
| trailing-7d minus ols | f1 | -0.035 | 0.039 | 0.129 | 1000 |
| trailing-7d minus ols | medianAbsErrorMinutes | -845.051 | -263.205 | 344.968 | 998 |
| dow-seasonal minus ols | f1 | -0.055 | 0.019 | 0.114 | 1000 |
| dow-seasonal minus ols | medianAbsErrorMinutes | -1199.814 | -58.374 | 708.461 | 998 |
| trailing-7d-else-lifetime minus ols | f1 | -0.035 | 0.039 | 0.129 | 1000 |
| trailing-7d-else-lifetime minus ols | medianAbsErrorMinutes | -845.051 | -263.205 | 344.968 | 998 |

## Held-out range

Scoring interval: `[2026-08-12T00:00:00.000Z, 2026-08-26T00:00:00.000Z)`

### Held-out range — seven_day

Selection scoring (deployment cohort; an abstention counts as a
silent screen, i.e. a predicted NON-exhaustion):

| estimator | instants | TP | FP | TN | FN | selection F1 | median abs err (min) | macro F1 | usable coverage |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 7633 | 0 | 3003 | 4630 | 0 | 0.000 | — | 0.000 | 100.0% |
| lifetime | 7633 | 0 | 3554 | 4079 | 0 | 0.000 | — | 0.000 | 100.0% |
| naive | 7633 | 0 | 1517 | 6116 | 0 | 0.000 | — | 0.000 | 99.9% |
| trailing-3d | 7633 | 0 | 2874 | 4759 | 0 | 0.000 | — | 0.000 | 96.0% |
| trailing-7d | 7633 | 0 | 3153 | 4480 | 0 | 0.000 | — | 0.000 | 95.9% |
| dow-seasonal | 7633 | 0 | 3783 | 3850 | 0 | 0.000 | — | 0.000 | 95.9% |
| trailing-7d-else-lifetime | 7633 | 0 | 3153 | 4480 | 0 | 0.000 | — | 0.000 | 100.0% |

Winner: **dow-seasonal** (locked on Tuning range)

Held-out gate:

| estimator | verdict | criterion | pass | detail |
|---|---|---|---|---|
| dow-seasonal | FAIL | F1 at least every baseline | yes | dow-seasonal F1 0.000; at least ols (0.000), lifetime (0.000), naive (0.000) |
| dow-seasonal | FAIL | median absolute ETA error no worse than ols | no | dow-seasonal null min vs ols null min |
| dow-seasonal | FAIL | usable coverage within 2 points of ols | no | dow-seasonal 0.959 vs ols 1.000 |
| trailing-3d | FAIL | F1 at least every baseline | yes | trailing-3d F1 0.000; at least ols (0.000), lifetime (0.000), naive (0.000) |
| trailing-3d | FAIL | median absolute ETA error no worse than ols | no | trailing-3d null min vs ols null min |
| trailing-3d | FAIL | usable coverage within 2 points of ols | no | trailing-3d 0.960 vs ols 1.000 |
| trailing-7d | FAIL | F1 at least every baseline | yes | trailing-7d F1 0.000; at least ols (0.000), lifetime (0.000), naive (0.000) |
| trailing-7d | FAIL | median absolute ETA error no worse than ols | no | trailing-7d null min vs ols null min |
| trailing-7d | FAIL | usable coverage within 2 points of ols | no | trailing-7d 0.959 vs ols 1.000 |
| trailing-7d-else-lifetime | FAIL | F1 at least every baseline | yes | trailing-7d-else-lifetime F1 0.000; at least ols (0.000), lifetime (0.000), naive (0.000) |
| trailing-7d-else-lifetime | FAIL | median absolute ETA error no worse than ols | no | trailing-7d-else-lifetime null min vs ols null min |
| trailing-7d-else-lifetime | FAIL | usable coverage within 2 points of ols | yes | trailing-7d-else-lifetime 1.000 vs ols 1.000 |

Display red rule (what a user would actually see as an alarm):

| estimator | margin fraction | scored | TP | FP | TN | FN | precision |
|---|---:|---:|---:|---:|---:|---:|---:|
| dow-seasonal | 0.1 | 7633 | 0 | 3090 | 4543 | 0 | 0.000 |
| trailing-3d | 0.1 | 7633 | 0 | 2304 | 5329 | 0 | 0.000 |
| trailing-7d | 0.1 | 7633 | 0 | 2494 | 5139 | 0 | 0.000 |
| trailing-7d-else-lifetime | 0.1 | 7633 | 0 | 2494 | 5139 | 0 | 0.000 |
| ols | 0.1 | 7633 | 0 | 2404 | 5229 | 0 | 0.000 |

Selection bootstrap (accounts resampled with replacement):

| comparison | statistic | p2.5 | median | p97.5 | resamples |
|---|---|---:|---:|---:|---:|
| dow-seasonal minus ols (selection) | f1 | 0.000 | 0.000 | 0.000 | 1000 |
| dow-seasonal minus ols (selection) | medianAbsErrorMinutes | — | — | — | 0 |
| dow-seasonal minus lifetime (selection) | f1 | 0.000 | 0.000 | 0.000 | 1000 |
| dow-seasonal minus lifetime (selection) | medianAbsErrorMinutes | — | — | — | 0 |

Conditional (each estimator on the instants it can answer):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 7963 | 99.9% | 7633 | 323 | 0 | 3003 | 4630 | 0 | 0.000 | — | 0.000 | — | — | — |
| lifetime | 7963 | 99.9% | 7633 | 323 | 0 | 3554 | 4079 | 0 | 0.000 | — | 0.000 | — | — | — |
| naive | 7963 | 99.9% | 7635 | 323 | 0 | 1517 | 6118 | 0 | 0.000 | — | 0.000 | — | — | — |
| trailing-3d | 7963 | 96.1% | 7326 | 323 | 0 | 2874 | 4452 | 0 | 0.000 | — | 0.000 | — | — | — |
| trailing-7d | 7963 | 96.0% | 7322 | 323 | 0 | 3153 | 4169 | 0 | 0.000 | — | 0.000 | — | — | — |
| dow-seasonal | 7963 | 96.0% | 7322 | 323 | 0 | 3783 | 3539 | 0 | 0.000 | — | 0.000 | — | — | — |
| trailing-7d-else-lifetime | 7963 | 99.9% | 7633 | 323 | 0 | 3153 | 4480 | 0 | 0.000 | — | 0.000 | — | — | — |

Coverage:

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| ols | 7956 | 7 | 0 | 0 | 0 | 7963 |
| lifetime | 7956 | 0 | 0 | 0 | 7 | 7963 |
| naive | 7954 | 9 | 0 | 0 | 0 | 7963 |
| trailing-3d | 7649 | 307 | 0 | 0 | 7 | 7963 |
| trailing-7d | 7645 | 311 | 0 | 0 | 7 | 7963 |
| dow-seasonal | 7645 | 311 | 0 | 0 | 7 | 7963 |
| trailing-7d-else-lifetime | 7956 | 0 | 0 | 0 | 7 | 7963 |

Common cohort (instants every estimator answered):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 7209 | 100.0% | 7209 | 0 | 0 | 2780 | 4429 | 0 | 0.000 | — | 0.000 | — | — | — |
| lifetime | 7209 | 100.0% | 7209 | 0 | 0 | 3461 | 3748 | 0 | 0.000 | — | 0.000 | — | — | — |
| naive | 7209 | 100.0% | 7209 | 0 | 0 | 1333 | 5876 | 0 | 0.000 | — | 0.000 | — | — | — |
| trailing-3d | 7209 | 100.0% | 7209 | 0 | 0 | 2874 | 4335 | 0 | 0.000 | — | 0.000 | — | — | — |
| trailing-7d | 7209 | 100.0% | 7209 | 0 | 0 | 3042 | 4167 | 0 | 0.000 | — | 0.000 | — | — | — |
| dow-seasonal | 7209 | 100.0% | 7209 | 0 | 0 | 3671 | 3538 | 0 | 0.000 | — | 0.000 | — | — | — |
| trailing-7d-else-lifetime | 7209 | 100.0% | 7209 | 0 | 0 | 3042 | 4167 | 0 | 0.000 | — | 0.000 | — | — | — |

Lead time (common cohort):

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| ols | <30m | 0 | 0 | — | — | 3 |
| ols | 30m-2h | 0 | 0 | — | — | 4 |
| ols | 2h-12h | 0 | 0 | — | — | 202 |
| ols | 12h-48h | 0 | 0 | — | — | 1663 |
| ols | >48h | 0 | 0 | — | — | 908 |
| lifetime | <30m | 0 | 0 | — | — | 0 |
| lifetime | 30m-2h | 0 | 0 | — | — | 0 |
| lifetime | 2h-12h | 0 | 0 | — | — | 1229 |
| lifetime | 12h-48h | 0 | 0 | — | — | 1602 |
| lifetime | >48h | 0 | 0 | — | — | 630 |
| naive | <30m | 0 | 0 | — | — | 4 |
| naive | 30m-2h | 0 | 0 | — | — | 25 |
| naive | 2h-12h | 0 | 0 | — | — | 451 |
| naive | 12h-48h | 0 | 0 | — | — | 656 |
| naive | >48h | 0 | 0 | — | — | 197 |
| trailing-3d | <30m | 0 | 0 | — | — | 0 |
| trailing-3d | 30m-2h | 0 | 0 | — | — | 0 |
| trailing-3d | 2h-12h | 0 | 0 | — | — | 690 |
| trailing-3d | 12h-48h | 0 | 0 | — | — | 1417 |
| trailing-3d | >48h | 0 | 0 | — | — | 767 |
| trailing-7d | <30m | 0 | 0 | — | — | 0 |
| trailing-7d | 30m-2h | 0 | 0 | — | — | 0 |
| trailing-7d | 2h-12h | 0 | 0 | — | — | 1082 |
| trailing-7d | 12h-48h | 0 | 0 | — | — | 1189 |
| trailing-7d | >48h | 0 | 0 | — | — | 771 |
| dow-seasonal | <30m | 0 | 0 | — | — | 0 |
| dow-seasonal | 30m-2h | 0 | 0 | — | — | 0 |
| dow-seasonal | 2h-12h | 0 | 0 | — | — | 522 |
| dow-seasonal | 12h-48h | 0 | 0 | — | — | 1423 |
| dow-seasonal | >48h | 0 | 0 | — | — | 1726 |
| trailing-7d-else-lifetime | <30m | 0 | 0 | — | — | 0 |
| trailing-7d-else-lifetime | 30m-2h | 0 | 0 | — | — | 0 |
| trailing-7d-else-lifetime | 2h-12h | 0 | 0 | — | — | 1082 |
| trailing-7d-else-lifetime | 12h-48h | 0 | 0 | — | — | 1189 |
| trailing-7d-else-lifetime | >48h | 0 | 0 | — | — | 771 |

Macro F1 (per-account, equal weight; common cohort):

| estimator | macro F1 |
|---|---:|
| ols | 0.000 |
| lifetime | 0.000 |
| naive | 0.000 |
| trailing-3d | 0.000 |
| trailing-7d | 0.000 |
| dow-seasonal | 0.000 |
| trailing-7d-else-lifetime | 0.000 |

By provider (common cohort):

| provider | estimator | scored | TP | FP | TN | FN | F1 | median abs err (min) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic | ols | 6157 | 0 | 2780 | 3377 | 0 | 0.000 | — |
| anthropic | lifetime | 6157 | 0 | 3461 | 2696 | 0 | 0.000 | — |
| anthropic | naive | 6157 | 0 | 1268 | 4889 | 0 | 0.000 | — |
| anthropic | trailing-3d | 6157 | 0 | 2874 | 3283 | 0 | 0.000 | — |
| anthropic | trailing-7d | 6157 | 0 | 3042 | 3115 | 0 | 0.000 | — |
| anthropic | dow-seasonal | 6157 | 0 | 2981 | 3176 | 0 | 0.000 | — |
| anthropic | trailing-7d-else-lifetime | 6157 | 0 | 3042 | 3115 | 0 | 0.000 | — |
| codex | ols | 1052 | 0 | 0 | 1052 | 0 | — | — |
| codex | lifetime | 1052 | 0 | 0 | 1052 | 0 | — | — |
| codex | naive | 1052 | 0 | 65 | 987 | 0 | 0.000 | — |
| codex | trailing-3d | 1052 | 0 | 0 | 1052 | 0 | — | — |
| codex | trailing-7d | 1052 | 0 | 0 | 1052 | 0 | — | — |
| codex | dow-seasonal | 1052 | 0 | 690 | 362 | 0 | 0.000 | — |
| codex | trailing-7d-else-lifetime | 1052 | 0 | 0 | 1052 | 0 | — | — |

Per-account contribution:

| account | provider | instants | scored | actual positives |
|---|---|---:|---:|---:|
| 1135d045-b26c-4118-8db2-00f0f0ecdf9b | anthropic | 1615 | 1588 | 0 |
| 1cae47ec-5813-41bc-837d-4f209e2ae1e7 | codex | 1459 | 1163 | 0 |
| 2acdf5e9-8298-42d5-816b-baecdb4498ca | anthropic | 1508 | 1508 | 0 |
| 4b3a18eb-5acb-4e1d-bb48-b3b36e29437a | anthropic | 1670 | 1670 | 0 |
| ae9e13bd-0a0d-4044-addb-5920075cd70f | anthropic | 1397 | 1397 | 0 |
| fb5944a3-df9e-49cd-b1d6-294988cd0fc4 | anthropic | 314 | 314 | 0 |

Bootstrap (accounts resampled with replacement):

| comparison | statistic | p2.5 | median | p97.5 | resamples |
|---|---|---:|---:|---:|---:|
| lifetime minus ols | f1 | 0.000 | 0.000 | 0.000 | 999 |
| lifetime minus ols | medianAbsErrorMinutes | — | — | — | 0 |
| naive minus ols | f1 | 0.000 | 0.000 | 0.000 | 999 |
| naive minus ols | medianAbsErrorMinutes | — | — | — | 0 |
| trailing-3d minus ols | f1 | 0.000 | 0.000 | 0.000 | 999 |
| trailing-3d minus ols | medianAbsErrorMinutes | — | — | — | 0 |
| trailing-7d minus ols | f1 | 0.000 | 0.000 | 0.000 | 999 |
| trailing-7d minus ols | medianAbsErrorMinutes | — | — | — | 0 |
| dow-seasonal minus ols | f1 | 0.000 | 0.000 | 0.000 | 999 |
| dow-seasonal minus ols | medianAbsErrorMinutes | — | — | — | 0 |
| trailing-7d-else-lifetime minus ols | f1 | 0.000 | 0.000 | 0.000 | 999 |
| trailing-7d-else-lifetime minus ols | medianAbsErrorMinutes | — | — | — | 0 |

## 429 diagnostic (label quality only)

Count of `requests` rows with `status_code = 429` falling inside windows this harness labelled `survived`. A high count would mean the polled percent missed real exhaustions. This is NEVER an input to a label.

| account | provider | window | survived windows | with a 429 | 429 requests |
|---|---|---|---:|---:|---:|
| 1135d045-b26c-4118-8db2-00f0f0ecdf9b | anthropic | seven_day | 14 | 4 | 26 |
| 1cae47ec-5813-41bc-837d-4f209e2ae1e7 | codex | seven_day | 60 | 1 | 8 |
| 2acdf5e9-8298-42d5-816b-baecdb4498ca | anthropic | seven_day | 9 | 4 | 30 |
| 4b3a18eb-5acb-4e1d-bb48-b3b36e29437a | anthropic | seven_day | 8 | 1 | 2 |
| ae9e13bd-0a0d-4044-addb-5920075cd70f | anthropic | seven_day | 12 | 5 | 21 |
| fb5944a3-df9e-49cd-b1d6-294988cd0fc4 | anthropic | seven_day | 3 | 0 | 0 |

## Notes

- Replay took 14.0 s; scoring and bootstrap 196.0 s.
