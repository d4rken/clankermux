# ClankerMux usage-prediction backtest

Generated: 2026-08-23T19:07:26.088Z

Reproduce with:

```
bun scripts/prediction-backtest.ts --from=2026-06-02T00:00:00Z --split=2026-08-01T00:00:00Z --to=2026-08-23T00:00:00Z --estimators=ols,lifetime,naive,endpoint-seg-30m,endpoint-seg-1h,endpoint-seg-2h,ols-1h,trailing-3d,trailing-7d,dow-seasonal --out=docs/prediction-backtest-baseline.md
```

| config | value |
|---|---|
| bootstrapIterations | 1000 |
| estimators | ols,lifetime,naive,endpoint-seg-30m,endpoint-seg-1h,endpoint-seg-2h,ols-1h,trailing-3d,trailing-7d,dow-seasonal |
| from | 2026-06-02T00:00:00.000Z |
| loadPadBeforeHours | 672 |
| seed | 20260823 |
| split | 2026-08-01T00:00:00Z |
| stepMinutes | 10 |
| to | 2026-08-23T00:00:00.000Z |
| windows | five_hour,seven_day |

## Dataset

| field | value |
|---|---|
| usage_snapshots rows | 155469 |
| accounts | 6 |
| providers | anthropic, codex |
| first sample | 2026-06-02T12:48:00.294Z |
| last sample | 2026-08-23T19:00:00.055Z |

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

### Tuning range — five_hour

Selection scoring (deployment cohort; an abstention counts as a
silent screen, i.e. a predicted NON-exhaustion):

| estimator | instants | TP | FP | TN | FN | selection F1 | median abs err (min) | macro F1 | usable coverage |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 16149 | 275 | 660 | 14950 | 264 | 0.373 | 48.9 | 0.431 | 99.5% |
| lifetime | 16149 | 276 | 661 | 14949 | 263 | 0.374 | 49.5 | 0.429 | 100.0% |
| naive | 16149 | 252 | 428 | 15182 | 287 | 0.413 | 35.6 | 0.451 | 99.9% |
| endpoint-seg-30m | 16149 | 299 | 616 | 14994 | 240 | 0.411 | 38.2 | 0.455 | 99.2% |
| endpoint-seg-1h | 16149 | 300 | 616 | 14994 | 239 | 0.412 | 38.6 | 0.466 | 99.3% |
| endpoint-seg-2h | 16149 | 287 | 628 | 14982 | 252 | 0.395 | 45.5 | 0.445 | 99.4% |
| ols-1h | 16149 | 299 | 623 | 14987 | 240 | 0.409 | 38.8 | 0.458 | 99.3% |

Winner: **naive** (locked on Tuning range)

Balance warning: pooled F1 favours naive but per-account macro F1 favours endpoint-seg-1h; the pooled number is account-weighted

Held-out gate:

| estimator | verdict | criterion | pass | detail |
|---|---|---|---|---|
| naive | PASS | F1 at least every baseline | yes | naive F1 0.413; at least ols (0.373), lifetime (0.374), naive (0.413) |
| naive | PASS | median absolute ETA error no worse than ols | yes | naive 35.6 min vs ols 48.9 min |
| naive | PASS | usable coverage within 2 points of ols | yes | naive 0.999 vs ols 0.995 |
| endpoint-seg-30m | FAIL | F1 at least every baseline | no | endpoint-seg-30m F1 0.411; below naive (0.413) |
| endpoint-seg-30m | FAIL | median absolute ETA error no worse than ols | yes | endpoint-seg-30m 38.2 min vs ols 48.9 min |
| endpoint-seg-30m | FAIL | usable coverage within 2 points of ols | yes | endpoint-seg-30m 0.992 vs ols 0.995 |
| endpoint-seg-1h | FAIL | F1 at least every baseline | no | endpoint-seg-1h F1 0.412; below naive (0.413) |
| endpoint-seg-1h | FAIL | median absolute ETA error no worse than ols | yes | endpoint-seg-1h 38.6 min vs ols 48.9 min |
| endpoint-seg-1h | FAIL | usable coverage within 2 points of ols | yes | endpoint-seg-1h 0.993 vs ols 0.995 |
| endpoint-seg-2h | FAIL | F1 at least every baseline | no | endpoint-seg-2h F1 0.395; below naive (0.413) |
| endpoint-seg-2h | FAIL | median absolute ETA error no worse than ols | yes | endpoint-seg-2h 45.5 min vs ols 48.9 min |
| endpoint-seg-2h | FAIL | usable coverage within 2 points of ols | yes | endpoint-seg-2h 0.994 vs ols 0.995 |
| ols-1h | FAIL | F1 at least every baseline | no | ols-1h F1 0.409; below naive (0.413) |
| ols-1h | FAIL | median absolute ETA error no worse than ols | yes | ols-1h 38.8 min vs ols 48.9 min |
| ols-1h | FAIL | usable coverage within 2 points of ols | yes | ols-1h 0.993 vs ols 0.995 |

Display red rule (what a user would actually see as an alarm):

| estimator | margin fraction | scored | TP | FP | TN | FN | precision |
|---|---:|---:|---:|---:|---:|---:|---:|
| naive | 0.1 | 16149 | 220 | 277 | 15333 | 319 | 0.443 |
| endpoint-seg-30m | 0.1 | 16149 | 268 | 441 | 15169 | 271 | 0.378 |
| endpoint-seg-1h | 0.1 | 16149 | 268 | 448 | 15162 | 271 | 0.374 |
| endpoint-seg-2h | 0.1 | 16149 | 257 | 447 | 15163 | 282 | 0.365 |
| ols-1h | 0.1 | 16149 | 261 | 431 | 15179 | 278 | 0.377 |
| ols | 0.1 | 16149 | 233 | 453 | 15157 | 306 | 0.340 |

Selection bootstrap (accounts resampled with replacement):

| comparison | statistic | p2.5 | median | p97.5 | resamples |
|---|---|---:|---:|---:|---:|
| naive minus ols (selection) | f1 | -0.032 | 0.040 | 0.078 | 1000 |
| naive minus ols (selection) | medianAbsErrorMinutes | -48.019 | -13.306 | 2.758 | 1000 |

Conditional (each estimator on the instants it can answer):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 33052 | 63.0% | 20063 | 839 | 275 | 660 | 18875 | 253 | 0.294 | 0.521 | 0.376 | 21.1 | 48.9 | 0.163 |
| lifetime | 33052 | 50.3% | 16149 | 839 | 276 | 661 | 14949 | 263 | 0.295 | 0.512 | 0.374 | 23.2 | 49.5 | 0.165 |
| naive | 33052 | 64.2% | 20411 | 839 | 252 | 429 | 19444 | 286 | 0.370 | 0.468 | 0.413 | 12.9 | 35.6 | 0.119 |
| endpoint-seg-30m | 33052 | 62.8% | 20024 | 839 | 299 | 616 | 18881 | 228 | 0.327 | 0.567 | 0.415 | 7.4 | 38.2 | 0.127 |
| endpoint-seg-1h | 33052 | 63.0% | 20051 | 839 | 300 | 616 | 18907 | 228 | 0.328 | 0.568 | 0.416 | 9.7 | 38.6 | 0.129 |
| endpoint-seg-2h | 33052 | 63.0% | 20060 | 839 | 287 | 628 | 18904 | 241 | 0.314 | 0.544 | 0.398 | 12.7 | 45.5 | 0.152 |
| ols-1h | 33052 | 62.8% | 20032 | 839 | 299 | 623 | 18881 | 229 | 0.324 | 0.566 | 0.412 | 11.9 | 38.8 | 0.129 |

Coverage:

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| ols | 20818 | 467 | 0 | 0 | 11767 | 33052 |
| lifetime | 16622 | 0 | 0 | 0 | 16430 | 33052 |
| naive | 21216 | 68 | 1 | 0 | 11767 | 33052 |
| endpoint-seg-30m | 20764 | 521 | 0 | 0 | 11767 | 33052 |
| endpoint-seg-1h | 20811 | 474 | 0 | 0 | 11767 | 33052 |
| endpoint-seg-2h | 20827 | 458 | 0 | 0 | 11767 | 33052 |
| ols-1h | 20761 | 524 | 0 | 0 | 11767 | 33052 |

Common cohort (instants every estimator answered):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 16017 | 100.0% | 16017 | 0 | 274 | 660 | 14830 | 253 | 0.293 | 0.520 | 0.375 | 21.1 | 48.9 | 0.163 |
| lifetime | 16017 | 100.0% | 16017 | 0 | 267 | 627 | 14863 | 260 | 0.299 | 0.507 | 0.376 | 24.4 | 48.6 | 0.162 |
| naive | 16017 | 100.0% | 16017 | 0 | 251 | 428 | 15062 | 276 | 0.370 | 0.476 | 0.416 | 11.9 | 35.6 | 0.119 |
| endpoint-seg-30m | 16017 | 100.0% | 16017 | 0 | 299 | 616 | 14874 | 228 | 0.327 | 0.567 | 0.415 | 7.4 | 38.2 | 0.127 |
| endpoint-seg-1h | 16017 | 100.0% | 16017 | 0 | 299 | 616 | 14874 | 228 | 0.327 | 0.567 | 0.415 | 9.7 | 38.9 | 0.130 |
| endpoint-seg-2h | 16017 | 100.0% | 16017 | 0 | 286 | 628 | 14862 | 241 | 0.313 | 0.543 | 0.397 | 12.7 | 45.5 | 0.152 |
| ols-1h | 16017 | 100.0% | 16017 | 0 | 298 | 623 | 14867 | 229 | 0.324 | 0.565 | 0.412 | 11.9 | 39.6 | 0.132 |

Lead time (common cohort):

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| ols | <30m | 72 | 4 | 0.947 | 2.8 | 53 |
| ols | 30m-2h | 140 | 94 | 0.598 | 43.3 | 271 |
| ols | 2h-12h | 62 | 155 | 0.286 | 82.3 | 336 |
| ols | 12h-48h | 0 | 0 | — | — | 0 |
| ols | >48h | 0 | 0 | — | — | 0 |
| lifetime | <30m | 70 | 6 | 0.921 | 3.1 | 45 |
| lifetime | 30m-2h | 140 | 94 | 0.598 | 37.8 | 257 |
| lifetime | 2h-12h | 57 | 160 | 0.263 | 95.3 | 325 |
| lifetime | 12h-48h | 0 | 0 | — | — | 0 |
| lifetime | >48h | 0 | 0 | — | — | 0 |
| naive | <30m | 72 | 4 | 0.947 | -0.4 | 35 |
| naive | 30m-2h | 152 | 82 | 0.650 | 14.9 | 229 |
| naive | 2h-12h | 27 | 190 | 0.124 | 123.3 | 164 |
| naive | 12h-48h | 0 | 0 | — | — | 0 |
| naive | >48h | 0 | 0 | — | — | 0 |
| endpoint-seg-30m | <30m | 71 | 5 | 0.934 | -1.0 | 29 |
| endpoint-seg-30m | 30m-2h | 167 | 67 | 0.714 | 11.1 | 262 |
| endpoint-seg-30m | 2h-12h | 61 | 156 | 0.281 | 62.6 | 325 |
| endpoint-seg-30m | 12h-48h | 0 | 0 | — | — | 0 |
| endpoint-seg-30m | >48h | 0 | 0 | — | — | 0 |
| endpoint-seg-1h | <30m | 72 | 4 | 0.947 | -0.4 | 37 |
| endpoint-seg-1h | 30m-2h | 167 | 67 | 0.714 | 14.5 | 254 |
| endpoint-seg-1h | 2h-12h | 60 | 157 | 0.276 | 73.6 | 325 |
| endpoint-seg-1h | 12h-48h | 0 | 0 | — | — | 0 |
| endpoint-seg-1h | >48h | 0 | 0 | — | — | 0 |
| endpoint-seg-2h | <30m | 71 | 5 | 0.934 | 0.3 | 40 |
| endpoint-seg-2h | 30m-2h | 148 | 86 | 0.632 | 31.5 | 249 |
| endpoint-seg-2h | 2h-12h | 67 | 150 | 0.309 | 65.5 | 339 |
| endpoint-seg-2h | 12h-48h | 0 | 0 | — | — | 0 |
| endpoint-seg-2h | >48h | 0 | 0 | — | — | 0 |
| ols-1h | <30m | 71 | 5 | 0.934 | -0.5 | 42 |
| ols-1h | 30m-2h | 166 | 68 | 0.709 | 18.9 | 259 |
| ols-1h | 2h-12h | 61 | 156 | 0.281 | 82.3 | 322 |
| ols-1h | 12h-48h | 0 | 0 | — | — | 0 |
| ols-1h | >48h | 0 | 0 | — | — | 0 |

Macro F1 (per-account, equal weight; common cohort):

| estimator | macro F1 |
|---|---:|
| ols | 0.435 |
| lifetime | 0.428 |
| naive | 0.455 |
| endpoint-seg-30m | 0.460 |
| endpoint-seg-1h | 0.470 |
| endpoint-seg-2h | 0.449 |
| ols-1h | 0.461 |

By provider (common cohort):

| provider | estimator | scored | TP | FP | TN | FN | F1 | median abs err (min) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic | ols | 15256 | 214 | 611 | 14189 | 242 | 0.334 | 56.0 |
| anthropic | lifetime | 15256 | 213 | 577 | 14223 | 243 | 0.342 | 52.7 |
| anthropic | naive | 15256 | 207 | 391 | 14409 | 249 | 0.393 | 31.0 |
| anthropic | endpoint-seg-30m | 15256 | 247 | 549 | 14251 | 209 | 0.395 | 32.8 |
| anthropic | endpoint-seg-1h | 15256 | 244 | 560 | 14240 | 212 | 0.387 | 35.3 |
| anthropic | endpoint-seg-2h | 15256 | 223 | 569 | 14231 | 233 | 0.357 | 42.8 |
| anthropic | ols-1h | 15256 | 246 | 563 | 14237 | 210 | 0.389 | 34.9 |
| codex | ols | 761 | 60 | 49 | 641 | 11 | 0.667 | 41.5 |
| codex | lifetime | 761 | 54 | 50 | 640 | 17 | 0.617 | 35.0 |
| codex | naive | 761 | 44 | 37 | 653 | 27 | 0.579 | 50.4 |
| codex | endpoint-seg-30m | 761 | 52 | 67 | 623 | 19 | 0.547 | 58.9 |
| codex | endpoint-seg-1h | 761 | 55 | 56 | 634 | 16 | 0.604 | 54.8 |
| codex | endpoint-seg-2h | 761 | 63 | 59 | 631 | 8 | 0.653 | 52.6 |
| codex | ols-1h | 761 | 52 | 60 | 630 | 19 | 0.568 | 61.9 |

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
| lifetime minus ols | f1 | -0.028 | 0.001 | 0.015 | 1000 |
| lifetime minus ols | medianAbsErrorMinutes | -12.090 | -3.246 | 3.947 | 1000 |
| naive minus ols | f1 | -0.031 | 0.041 | 0.078 | 1000 |
| naive minus ols | medianAbsErrorMinutes | -48.019 | -13.634 | 1.994 | 1000 |
| endpoint-seg-30m minus ols | f1 | -0.030 | 0.041 | 0.078 | 1000 |
| endpoint-seg-30m minus ols | medianAbsErrorMinutes | -43.744 | -11.378 | 5.145 | 1000 |
| endpoint-seg-1h minus ols | f1 | -0.002 | 0.041 | 0.066 | 1000 |
| endpoint-seg-1h minus ols | medianAbsErrorMinutes | -40.679 | -10.006 | 5.723 | 1000 |
| endpoint-seg-2h minus ols | f1 | 0.003 | 0.022 | 0.030 | 1000 |
| endpoint-seg-2h minus ols | medianAbsErrorMinutes | -26.171 | -5.832 | 6.290 | 1000 |
| ols-1h minus ols | f1 | -0.016 | 0.037 | 0.064 | 1000 |
| ols-1h minus ols | medianAbsErrorMinutes | -42.257 | -9.311 | 7.581 | 1000 |

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

Display red rule (what a user would actually see as an alarm):

| estimator | margin fraction | scored | TP | FP | TN | FN | precision |
|---|---:|---:|---:|---:|---:|---:|---:|
| lifetime | 0.1 | 17977 | 3350 | 2621 | 9657 | 2349 | 0.561 |
| trailing-3d | 0.1 | 17977 | 3349 | 2607 | 9671 | 2350 | 0.562 |
| trailing-7d | 0.1 | 17977 | 2280 | 2546 | 9732 | 3419 | 0.472 |
| dow-seasonal | 0.1 | 17977 | 2892 | 2372 | 9906 | 2807 | 0.549 |
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

Coverage:

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| ols | 19341 | 37 | 0 | 0 | 0 | 19378 |
| lifetime | 19328 | 0 | 0 | 0 | 50 | 19378 |
| naive | 19227 | 150 | 1 | 0 | 0 | 19378 |
| trailing-3d | 16801 | 2527 | 0 | 0 | 50 | 19378 |
| trailing-7d | 15033 | 4295 | 0 | 0 | 50 | 19378 |
| dow-seasonal | 13838 | 5490 | 0 | 0 | 50 | 19378 |

Common cohort (instants every estimator answered):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 12151 | 100.0% | 12151 | 0 | 2582 | 2814 | 5485 | 1270 | 0.479 | 0.670 | 0.558 | 396.5 | 1545.3 | 0.153 |
| lifetime | 12151 | 100.0% | 12151 | 0 | 2589 | 2758 | 5541 | 1263 | 0.484 | 0.672 | 0.563 | 431.4 | 1581.8 | 0.157 |
| naive | 12151 | 100.0% | 12151 | 0 | 1436 | 1668 | 6631 | 2416 | 0.463 | 0.373 | 0.413 | -766.1 | 1218.1 | 0.121 |
| trailing-3d | 12151 | 100.0% | 12151 | 0 | 2607 | 2789 | 5510 | 1245 | 0.483 | 0.677 | 0.564 | 178.4 | 1152.2 | 0.114 |
| trailing-7d | 12151 | 100.0% | 12151 | 0 | 2316 | 2849 | 5450 | 1536 | 0.448 | 0.601 | 0.514 | 1545.7 | 2487.4 | 0.247 |
| dow-seasonal | 12151 | 100.0% | 12151 | 0 | 2576 | 2896 | 5403 | 1276 | 0.471 | 0.669 | 0.553 | 123.3 | 1908.6 | 0.189 |

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

Macro F1 (per-account, equal weight; common cohort):

| estimator | macro F1 |
|---|---:|
| ols | 0.451 |
| lifetime | 0.481 |
| naive | 0.319 |
| trailing-3d | 0.491 |
| trailing-7d | 0.472 |
| dow-seasonal | 0.483 |

By provider (common cohort):

| provider | estimator | scored | TP | FP | TN | FN | F1 | median abs err (min) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic | ols | 10392 | 2307 | 1914 | 5071 | 1100 | 0.605 | 1577.4 |
| anthropic | lifetime | 10392 | 2280 | 1829 | 5156 | 1127 | 0.607 | 1601.0 |
| anthropic | naive | 10392 | 1302 | 1152 | 5833 | 2105 | 0.444 | 1213.2 |
| anthropic | trailing-3d | 10392 | 2217 | 1877 | 5108 | 1190 | 0.591 | 1461.3 |
| anthropic | trailing-7d | 10392 | 1926 | 1937 | 5048 | 1481 | 0.530 | 2749.1 |
| anthropic | dow-seasonal | 10392 | 2186 | 1904 | 5081 | 1221 | 0.583 | 1605.6 |
| codex | ols | 1759 | 275 | 900 | 414 | 170 | 0.340 | 899.2 |
| codex | lifetime | 1759 | 309 | 929 | 385 | 136 | 0.367 | 1511.3 |
| codex | naive | 1759 | 134 | 516 | 798 | 311 | 0.245 | 1238.6 |
| codex | trailing-3d | 1759 | 390 | 912 | 402 | 55 | 0.446 | 531.7 |
| codex | trailing-7d | 1759 | 390 | 912 | 402 | 55 | 0.446 | 885.7 |
| codex | dow-seasonal | 1759 | 390 | 992 | 322 | 55 | 0.427 | 2169.2 |

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

## Held-out range

Scoring interval: `[2026-08-01T00:00:00.000Z, 2026-08-23T00:00:00.000Z)`

### Held-out range — five_hour

Selection scoring (deployment cohort; an abstention counts as a
silent screen, i.e. a predicted NON-exhaustion):

| estimator | instants | TP | FP | TN | FN | selection F1 | median abs err (min) | macro F1 | usable coverage |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 7546 | 49 | 437 | 7050 | 10 | 0.180 | 20.0 | 0.119 | 99.4% |
| lifetime | 7546 | 50 | 421 | 7066 | 9 | 0.189 | 28.8 | 0.127 | 100.0% |
| naive | 7546 | 40 | 301 | 7186 | 19 | 0.200 | 43.1 | 0.124 | 100.0% |
| endpoint-seg-30m | 7546 | 43 | 379 | 7108 | 16 | 0.179 | 35.0 | 0.115 | 99.4% |
| endpoint-seg-1h | 7546 | 46 | 403 | 7084 | 13 | 0.181 | 22.4 | 0.115 | 99.4% |
| endpoint-seg-2h | 7546 | 49 | 408 | 7079 | 10 | 0.190 | 22.4 | 0.126 | 99.4% |
| ols-1h | 7546 | 46 | 414 | 7073 | 13 | 0.177 | 23.0 | 0.116 | 99.4% |

Winner: **naive** (locked on Tuning range)

Balance warning: pooled F1 favours naive but per-account macro F1 favours lifetime; the pooled number is account-weighted

Held-out gate:

| estimator | verdict | criterion | pass | detail |
|---|---|---|---|---|
| naive | FAIL | F1 at least every baseline | yes | naive F1 0.200; at least ols (0.180), lifetime (0.189), naive (0.200) |
| naive | FAIL | median absolute ETA error no worse than ols | no | naive 43.1 min vs ols 20.0 min |
| naive | FAIL | usable coverage within 2 points of ols | yes | naive 1.000 vs ols 0.994 |
| endpoint-seg-30m | FAIL | F1 at least every baseline | no | endpoint-seg-30m F1 0.179; below ols (0.180), lifetime (0.189), naive (0.200) |
| endpoint-seg-30m | FAIL | median absolute ETA error no worse than ols | no | endpoint-seg-30m 35.0 min vs ols 20.0 min |
| endpoint-seg-30m | FAIL | usable coverage within 2 points of ols | yes | endpoint-seg-30m 0.994 vs ols 0.994 |
| endpoint-seg-1h | FAIL | F1 at least every baseline | no | endpoint-seg-1h F1 0.181; below lifetime (0.189), naive (0.200) |
| endpoint-seg-1h | FAIL | median absolute ETA error no worse than ols | no | endpoint-seg-1h 22.4 min vs ols 20.0 min |
| endpoint-seg-1h | FAIL | usable coverage within 2 points of ols | yes | endpoint-seg-1h 0.994 vs ols 0.994 |
| endpoint-seg-2h | FAIL | F1 at least every baseline | no | endpoint-seg-2h F1 0.190; below naive (0.200) |
| endpoint-seg-2h | FAIL | median absolute ETA error no worse than ols | no | endpoint-seg-2h 22.4 min vs ols 20.0 min |
| endpoint-seg-2h | FAIL | usable coverage within 2 points of ols | yes | endpoint-seg-2h 0.994 vs ols 0.994 |
| ols-1h | FAIL | F1 at least every baseline | no | ols-1h F1 0.177; below ols (0.180), lifetime (0.189), naive (0.200) |
| ols-1h | FAIL | median absolute ETA error no worse than ols | no | ols-1h 23.0 min vs ols 20.0 min |
| ols-1h | FAIL | usable coverage within 2 points of ols | yes | ols-1h 0.994 vs ols 0.994 |

Display red rule (what a user would actually see as an alarm):

| estimator | margin fraction | scored | TP | FP | TN | FN | precision |
|---|---:|---:|---:|---:|---:|---:|---:|
| naive | 0.1 | 7546 | 38 | 203 | 7284 | 21 | 0.158 |
| endpoint-seg-30m | 0.1 | 7546 | 42 | 286 | 7201 | 17 | 0.128 |
| endpoint-seg-1h | 0.1 | 7546 | 44 | 295 | 7192 | 15 | 0.130 |
| endpoint-seg-2h | 0.1 | 7546 | 46 | 297 | 7190 | 13 | 0.134 |
| ols-1h | 0.1 | 7546 | 44 | 302 | 7185 | 15 | 0.127 |
| ols | 0.1 | 7546 | 48 | 308 | 7179 | 11 | 0.135 |

Selection bootstrap (accounts resampled with replacement):

| comparison | statistic | p2.5 | median | p97.5 | resamples |
|---|---|---:|---:|---:|---:|
| naive minus ols (selection) | f1 | -0.027 | 0.015 | 0.055 | 1000 |
| naive minus ols (selection) | medianAbsErrorMinutes | 3.030 | 3.105 | 23.692 | 932 |

Conditional (each estimator on the instants it can answer):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 18210 | 58.4% | 10616 | 26 | 49 | 437 | 10121 | 9 | 0.101 | 0.845 | 0.180 | 5.1 | 20.0 | 0.067 |
| lifetime | 18210 | 41.6% | 7546 | 26 | 50 | 421 | 7066 | 9 | 0.106 | 0.847 | 0.189 | 0.4 | 28.8 | 0.096 |
| naive | 18210 | 59.5% | 10805 | 26 | 40 | 301 | 10445 | 19 | 0.117 | 0.678 | 0.200 | 7.3 | 43.1 | 0.144 |
| endpoint-seg-30m | 18210 | 58.4% | 10614 | 26 | 43 | 379 | 10177 | 15 | 0.102 | 0.741 | 0.179 | -3.4 | 35.0 | 0.117 |
| endpoint-seg-1h | 18210 | 58.4% | 10615 | 26 | 46 | 403 | 10154 | 12 | 0.102 | 0.793 | 0.181 | -7.8 | 22.4 | 0.075 |
| endpoint-seg-2h | 18210 | 58.4% | 10616 | 26 | 49 | 408 | 10150 | 9 | 0.107 | 0.845 | 0.190 | 1.5 | 22.4 | 0.075 |
| ols-1h | 18210 | 58.4% | 10614 | 26 | 46 | 414 | 10142 | 12 | 0.100 | 0.793 | 0.178 | 0.5 | 23.0 | 0.077 |

Coverage:

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| ols | 10640 | 193 | 0 | 0 | 7377 | 18210 |
| lifetime | 7571 | 0 | 0 | 0 | 10639 | 18210 |
| naive | 10830 | 3 | 0 | 0 | 7377 | 18210 |
| endpoint-seg-30m | 10638 | 194 | 1 | 0 | 7377 | 18210 |
| endpoint-seg-1h | 10639 | 193 | 1 | 0 | 7377 | 18210 |
| endpoint-seg-2h | 10640 | 192 | 1 | 0 | 7377 | 18210 |
| ols-1h | 10638 | 195 | 0 | 0 | 7377 | 18210 |

Common cohort (instants every estimator answered):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 7497 | 100.0% | 7497 | 0 | 49 | 437 | 7002 | 9 | 0.101 | 0.845 | 0.180 | 5.1 | 20.0 | 0.067 |
| lifetime | 7497 | 100.0% | 7497 | 0 | 49 | 399 | 7040 | 9 | 0.109 | 0.845 | 0.194 | 0.6 | 28.8 | 0.096 |
| naive | 7497 | 100.0% | 7497 | 0 | 40 | 301 | 7138 | 18 | 0.117 | 0.690 | 0.201 | 7.3 | 43.1 | 0.144 |
| endpoint-seg-30m | 7497 | 100.0% | 7497 | 0 | 43 | 379 | 7060 | 15 | 0.102 | 0.741 | 0.179 | -3.4 | 35.0 | 0.117 |
| endpoint-seg-1h | 7497 | 100.0% | 7497 | 0 | 46 | 403 | 7036 | 12 | 0.102 | 0.793 | 0.181 | -7.8 | 22.4 | 0.075 |
| endpoint-seg-2h | 7497 | 100.0% | 7497 | 0 | 49 | 408 | 7031 | 9 | 0.107 | 0.845 | 0.190 | 1.5 | 22.4 | 0.075 |
| ols-1h | 7497 | 100.0% | 7497 | 0 | 46 | 414 | 7025 | 12 | 0.100 | 0.793 | 0.178 | 0.5 | 23.0 | 0.077 |

Lead time (common cohort):

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| ols | <30m | 7 | 0 | 1.000 | 5.6 | 50 |
| ols | 30m-2h | 26 | 0 | 1.000 | 4.9 | 168 |
| ols | 2h-12h | 16 | 9 | 0.640 | -9.4 | 219 |
| ols | 12h-48h | 0 | 0 | — | — | 0 |
| ols | >48h | 0 | 0 | — | — | 0 |
| lifetime | <30m | 7 | 0 | 1.000 | 1.5 | 43 |
| lifetime | 30m-2h | 26 | 0 | 1.000 | -12.3 | 160 |
| lifetime | 2h-12h | 16 | 9 | 0.640 | 16.8 | 196 |
| lifetime | 12h-48h | 0 | 0 | — | — | 0 |
| lifetime | >48h | 0 | 0 | — | — | 0 |
| naive | <30m | 5 | 2 | 0.714 | 10.7 | 44 |
| naive | 30m-2h | 22 | 4 | 0.846 | 2.7 | 142 |
| naive | 2h-12h | 13 | 12 | 0.520 | 28.3 | 115 |
| naive | 12h-48h | 0 | 0 | — | — | 0 |
| naive | >48h | 0 | 0 | — | — | 0 |
| endpoint-seg-30m | <30m | 5 | 2 | 0.714 | 7.5 | 25 |
| endpoint-seg-30m | 30m-2h | 24 | 2 | 0.923 | -16.4 | 163 |
| endpoint-seg-30m | 2h-12h | 14 | 11 | 0.560 | -17.2 | 191 |
| endpoint-seg-30m | 12h-48h | 0 | 0 | — | — | 0 |
| endpoint-seg-30m | >48h | 0 | 0 | — | — | 0 |
| endpoint-seg-1h | <30m | 5 | 2 | 0.714 | 10.7 | 44 |
| endpoint-seg-1h | 30m-2h | 26 | 0 | 1.000 | -8.6 | 155 |
| endpoint-seg-1h | 2h-12h | 15 | 10 | 0.600 | -12.4 | 204 |
| endpoint-seg-1h | 12h-48h | 0 | 0 | — | — | 0 |
| endpoint-seg-1h | >48h | 0 | 0 | — | — | 0 |
| endpoint-seg-2h | <30m | 7 | 0 | 1.000 | 8.1 | 51 |
| endpoint-seg-2h | 30m-2h | 26 | 0 | 1.000 | -7.8 | 159 |
| endpoint-seg-2h | 2h-12h | 16 | 9 | 0.640 | -8.0 | 198 |
| endpoint-seg-2h | 12h-48h | 0 | 0 | — | — | 0 |
| endpoint-seg-2h | >48h | 0 | 0 | — | — | 0 |
| ols-1h | <30m | 5 | 2 | 0.714 | 11.6 | 46 |
| ols-1h | 30m-2h | 25 | 1 | 0.962 | -8.7 | 158 |
| ols-1h | 2h-12h | 16 | 9 | 0.640 | -13.5 | 210 |
| ols-1h | 12h-48h | 0 | 0 | — | — | 0 |
| ols-1h | >48h | 0 | 0 | — | — | 0 |

Macro F1 (per-account, equal weight; common cohort):

| estimator | macro F1 |
|---|---:|
| ols | 0.120 |
| lifetime | 0.130 |
| naive | 0.124 |
| endpoint-seg-30m | 0.116 |
| endpoint-seg-1h | 0.116 |
| endpoint-seg-2h | 0.126 |
| ols-1h | 0.117 |

By provider (common cohort):

| provider | estimator | scored | TP | FP | TN | FN | F1 | median abs err (min) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic | ols | 7497 | 49 | 437 | 7002 | 9 | 0.180 | 20.0 |
| anthropic | lifetime | 7497 | 49 | 399 | 7040 | 9 | 0.194 | 28.8 |
| anthropic | naive | 7497 | 40 | 301 | 7138 | 18 | 0.201 | 43.1 |
| anthropic | endpoint-seg-30m | 7497 | 43 | 379 | 7060 | 15 | 0.179 | 35.0 |
| anthropic | endpoint-seg-1h | 7497 | 46 | 403 | 7036 | 12 | 0.181 | 22.4 |
| anthropic | endpoint-seg-2h | 7497 | 49 | 408 | 7031 | 9 | 0.190 | 22.4 |
| anthropic | ols-1h | 7497 | 46 | 414 | 7025 | 12 | 0.178 | 23.0 |

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
| naive minus ols | f1 | -0.027 | 0.015 | 0.055 | 1000 |
| naive minus ols | medianAbsErrorMinutes | 3.030 | 3.105 | 23.692 | 932 |
| endpoint-seg-30m minus ols | f1 | -0.023 | -0.001 | 0.018 | 1000 |
| endpoint-seg-30m minus ols | medianAbsErrorMinutes | 11.829 | 15.041 | 21.172 | 932 |
| endpoint-seg-1h minus ols | f1 | -0.014 | 0.000 | 0.009 | 1000 |
| endpoint-seg-1h minus ols | medianAbsErrorMinutes | -1.055 | 2.432 | 8.118 | 932 |
| endpoint-seg-2h minus ols | f1 | 0.000 | 0.010 | 0.016 | 1000 |
| endpoint-seg-2h minus ols | medianAbsErrorMinutes | -2.914 | -1.855 | 2.432 | 932 |
| ols-1h minus ols | f1 | -0.020 | -0.002 | 0.008 | 1000 |
| ols-1h minus ols | medianAbsErrorMinutes | -0.602 | 3.023 | 19.730 | 932 |

### Held-out range — seven_day

Selection scoring (deployment cohort; an abstention counts as a
silent screen, i.e. a predicted NON-exhaustion):

| estimator | instants | TP | FP | TN | FN | selection F1 | median abs err (min) | macro F1 | usable coverage |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 9290 | 1664 | 1425 | 5404 | 797 | 0.600 | 1507.7 | 0.535 | 100.0% |
| lifetime | 9290 | 2164 | 1642 | 5187 | 297 | 0.691 | 1176.0 | 0.606 | 100.0% |
| naive | 9290 | 909 | 971 | 5858 | 1552 | 0.419 | 1222.0 | 0.366 | 100.0% |
| trailing-3d | 9290 | 1484 | 1264 | 5565 | 977 | 0.570 | 1262.4 | 0.503 | 100.0% |
| trailing-7d | 9290 | 2193 | 1514 | 5315 | 268 | 0.711 | 960.9 | 0.636 | 100.0% |
| dow-seasonal | 9290 | 2232 | 2187 | 4642 | 229 | 0.649 | 673.5 | 0.600 | 96.1% |

Winner: **lifetime** (locked on Tuning range)

Held-out gate:

| estimator | verdict | criterion | pass | detail |
|---|---|---|---|---|
| lifetime | PASS | F1 at least every baseline | yes | lifetime F1 0.691; at least ols (0.600), lifetime (0.691), naive (0.419) |
| lifetime | PASS | median absolute ETA error no worse than ols | yes | lifetime 1176.0 min vs ols 1507.7 min |
| lifetime | PASS | usable coverage within 2 points of ols | yes | lifetime 1.000 vs ols 1.000 |
| trailing-3d | FAIL | F1 at least every baseline | no | trailing-3d F1 0.570; below ols (0.600), lifetime (0.691) |
| trailing-3d | FAIL | median absolute ETA error no worse than ols | yes | trailing-3d 1262.4 min vs ols 1507.7 min |
| trailing-3d | FAIL | usable coverage within 2 points of ols | yes | trailing-3d 1.000 vs ols 1.000 |
| trailing-7d | PASS | F1 at least every baseline | yes | trailing-7d F1 0.711; at least ols (0.600), lifetime (0.691), naive (0.419) |
| trailing-7d | PASS | median absolute ETA error no worse than ols | yes | trailing-7d 960.9 min vs ols 1507.7 min |
| trailing-7d | PASS | usable coverage within 2 points of ols | yes | trailing-7d 1.000 vs ols 1.000 |
| dow-seasonal | FAIL | F1 at least every baseline | no | dow-seasonal F1 0.649; below lifetime (0.691) |
| dow-seasonal | FAIL | median absolute ETA error no worse than ols | yes | dow-seasonal 673.5 min vs ols 1507.7 min |
| dow-seasonal | FAIL | usable coverage within 2 points of ols | no | dow-seasonal 0.961 vs ols 1.000 |

Display red rule (what a user would actually see as an alarm):

| estimator | margin fraction | scored | TP | FP | TN | FN | precision |
|---|---:|---:|---:|---:|---:|---:|---:|
| lifetime | 0.1 | 9290 | 1964 | 948 | 5881 | 497 | 0.674 |
| trailing-3d | 0.1 | 9290 | 1461 | 823 | 6006 | 1000 | 0.640 |
| trailing-7d | 0.1 | 9290 | 1786 | 923 | 5906 | 675 | 0.659 |
| dow-seasonal | 0.1 | 9290 | 1942 | 1707 | 5122 | 519 | 0.532 |
| ols | 0.1 | 9290 | 1615 | 942 | 5887 | 846 | 0.632 |

Selection bootstrap (accounts resampled with replacement):

| comparison | statistic | p2.5 | median | p97.5 | resamples |
|---|---|---:|---:|---:|---:|
| lifetime minus ols (selection) | f1 | -0.048 | 0.089 | 0.247 | 1000 |
| lifetime minus ols (selection) | medianAbsErrorMinutes | -694.618 | -331.739 | 405.869 | 998 |

- The in-range ranking would have picked trailing-7d; the winner stays locked to lifetime from Tuning range.

Conditional (each estimator on the instants it can answer):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 9326 | 99.9% | 9288 | 28 | 1664 | 1425 | 5402 | 797 | 0.539 | 0.676 | 0.600 | 14.4 | 1507.7 | 0.150 |
| lifetime | 9326 | 99.9% | 9290 | 28 | 2164 | 1642 | 5187 | 297 | 0.569 | 0.879 | 0.691 | -594.3 | 1176.0 | 0.117 |
| naive | 9326 | 100.0% | 9294 | 28 | 909 | 971 | 5862 | 1552 | 0.484 | 0.369 | 0.419 | -1014.1 | 1222.0 | 0.121 |
| trailing-3d | 9326 | 99.9% | 9290 | 28 | 1484 | 1264 | 5565 | 977 | 0.540 | 0.603 | 0.570 | 536.9 | 1262.4 | 0.125 |
| trailing-7d | 9326 | 99.9% | 9290 | 28 | 2193 | 1514 | 5315 | 268 | 0.592 | 0.891 | 0.711 | 746.9 | 960.9 | 0.095 |
| dow-seasonal | 9326 | 96.1% | 8931 | 28 | 2232 | 2187 | 4283 | 229 | 0.505 | 0.907 | 0.649 | 20.3 | 673.5 | 0.067 |

Coverage:

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| ols | 9316 | 9 | 0 | 0 | 1 | 9326 |
| lifetime | 9318 | 0 | 0 | 0 | 8 | 9326 |
| naive | 9322 | 3 | 0 | 0 | 1 | 9326 |
| trailing-3d | 9318 | 0 | 0 | 0 | 8 | 9326 |
| trailing-7d | 9318 | 0 | 0 | 0 | 8 | 9326 |
| dow-seasonal | 8959 | 359 | 0 | 0 | 8 | 9326 |

Common cohort (instants every estimator answered):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ols | 8927 | 100.0% | 8927 | 0 | 1664 | 1276 | 5190 | 797 | 0.566 | 0.676 | 0.616 | 14.4 | 1507.7 | 0.150 |
| lifetime | 8927 | 100.0% | 8927 | 0 | 2164 | 1368 | 5098 | 297 | 0.613 | 0.879 | 0.722 | -594.3 | 1176.0 | 0.117 |
| naive | 8927 | 100.0% | 8927 | 0 | 909 | 888 | 5578 | 1552 | 0.506 | 0.369 | 0.427 | -1014.1 | 1222.0 | 0.121 |
| trailing-3d | 8927 | 100.0% | 8927 | 0 | 1484 | 1108 | 5358 | 977 | 0.573 | 0.603 | 0.587 | 536.9 | 1262.4 | 0.125 |
| trailing-7d | 8927 | 100.0% | 8927 | 0 | 2193 | 1213 | 5253 | 268 | 0.644 | 0.891 | 0.748 | 746.9 | 960.9 | 0.095 |
| dow-seasonal | 8927 | 100.0% | 8927 | 0 | 2232 | 2184 | 4282 | 229 | 0.505 | 0.907 | 0.649 | 20.3 | 673.5 | 0.067 |

Lead time (common cohort):

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| ols | <30m | 13 | 0 | 1.000 | 99.4 | 2 |
| ols | 30m-2h | 41 | 3 | 0.932 | 216.0 | 0 |
| ols | 2h-12h | 141 | 142 | 0.498 | 1281.0 | 27 |
| ols | 12h-48h | 662 | 296 | 0.691 | 323.7 | 315 |
| ols | >48h | 807 | 356 | 0.694 | -1407.2 | 932 |
| lifetime | <30m | 13 | 0 | 1.000 | 54.5 | 0 |
| lifetime | 30m-2h | 44 | 0 | 1.000 | 84.7 | 136 |
| lifetime | 2h-12h | 283 | 0 | 1.000 | 349.6 | 66 |
| lifetime | 12h-48h | 911 | 47 | 0.951 | -483.4 | 580 |
| lifetime | >48h | 913 | 250 | 0.785 | -1537.7 | 586 |
| naive | <30m | 13 | 0 | 1.000 | 36.0 | 0 |
| naive | 30m-2h | 35 | 9 | 0.795 | -1.0 | 2 |
| naive | 2h-12h | 150 | 133 | 0.530 | -8.2 | 218 |
| naive | 12h-48h | 231 | 727 | 0.241 | -843.3 | 422 |
| naive | >48h | 480 | 683 | 0.413 | -2588.0 | 246 |
| trailing-3d | <30m | 13 | 0 | 1.000 | 74.0 | 0 |
| trailing-3d | 30m-2h | 37 | 7 | 0.841 | 130.0 | 2 |
| trailing-3d | 2h-12h | 225 | 58 | 0.795 | 630.9 | 12 |
| trailing-3d | 12h-48h | 683 | 275 | 0.713 | -114.6 | 381 |
| trailing-3d | >48h | 526 | 637 | 0.452 | 2735.2 | 713 |
| trailing-7d | <30m | 13 | 0 | 1.000 | 86.3 | 0 |
| trailing-7d | 30m-2h | 44 | 0 | 1.000 | 126.2 | 136 |
| trailing-7d | 2h-12h | 283 | 0 | 1.000 | 611.7 | 62 |
| trailing-7d | 12h-48h | 958 | 0 | 1.000 | 443.0 | 329 |
| trailing-7d | >48h | 895 | 268 | 0.770 | 1591.2 | 686 |
| dow-seasonal | <30m | 13 | 0 | 1.000 | 88.6 | 0 |
| dow-seasonal | 30m-2h | 44 | 0 | 1.000 | 148.4 | 30 |
| dow-seasonal | 2h-12h | 283 | 0 | 1.000 | 367.3 | 115 |
| dow-seasonal | 12h-48h | 958 | 0 | 1.000 | -223.4 | 620 |
| dow-seasonal | >48h | 934 | 229 | 0.803 | 194.4 | 1419 |

Macro F1 (per-account, equal weight; common cohort):

| estimator | macro F1 |
|---|---:|
| ols | 0.535 |
| lifetime | 0.606 |
| naive | 0.366 |
| trailing-3d | 0.503 |
| trailing-7d | 0.636 |
| dow-seasonal | 0.600 |

By provider (common cohort):

| provider | estimator | scored | TP | FP | TN | FN | F1 | median abs err (min) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic | ols | 6513 | 1355 | 1089 | 3490 | 579 | 0.619 | 1648.1 |
| anthropic | lifetime | 6513 | 1900 | 1122 | 3457 | 34 | 0.767 | 1028.4 |
| anthropic | naive | 6513 | 690 | 672 | 3907 | 1244 | 0.419 | 1694.5 |
| anthropic | trailing-3d | 6513 | 1295 | 781 | 3798 | 639 | 0.646 | 1131.1 |
| anthropic | trailing-7d | 6513 | 1846 | 754 | 3825 | 88 | 0.814 | 1039.1 |
| anthropic | dow-seasonal | 6513 | 1885 | 889 | 3690 | 49 | 0.801 | 924.2 |
| codex | ols | 2414 | 309 | 187 | 1700 | 218 | 0.604 | 620.5 |
| codex | lifetime | 2414 | 264 | 246 | 1641 | 263 | 0.509 | 1693.1 |
| codex | naive | 2414 | 219 | 216 | 1671 | 308 | 0.455 | 808.4 |
| codex | trailing-3d | 2414 | 189 | 327 | 1560 | 338 | 0.362 | 2356.4 |
| codex | trailing-7d | 2414 | 347 | 459 | 1428 | 180 | 0.521 | 775.6 |
| codex | dow-seasonal | 2414 | 347 | 1295 | 592 | 180 | 0.320 | 313.6 |

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
| lifetime minus ols | f1 | -0.034 | 0.101 | 0.266 | 1000 |
| lifetime minus ols | medianAbsErrorMinutes | -694.618 | -331.739 | 405.869 | 998 |
| naive minus ols | f1 | -0.267 | -0.189 | -0.099 | 1000 |
| naive minus ols | medianAbsErrorMinutes | -473.439 | -178.283 | 530.178 | 998 |
| trailing-3d minus ols | f1 | -0.155 | -0.029 | 0.076 | 1000 |
| trailing-3d minus ols | medianAbsErrorMinutes | -776.488 | -245.332 | 796.471 | 998 |
| trailing-7d minus ols | f1 | -0.015 | 0.131 | 0.291 | 1000 |
| trailing-7d minus ols | medianAbsErrorMinutes | -842.229 | -535.215 | -135.817 | 998 |
| dow-seasonal minus ols | f1 | -0.188 | 0.039 | 0.277 | 1000 |
| dow-seasonal minus ols | medianAbsErrorMinutes | -1338.488 | -791.838 | -70.564 | 998 |

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
- Replay took 11.4 s; scoring and bootstrap 358.6 s.

## Provenance of the decision this report backs

Appended by hand after the run above. It records how the estimator choice was
actually made, which a single combined table cannot show — and regenerating the
report will drop this section, so re-add it.

**The tables above did not make the choice.** They are one combined invocation,
run after the fact so every candidate sits in one place. The decision was made
by two earlier, separate invocations, in this order:

1. **Winner selection — a tuning-only invocation.** All ten estimators, scored
   on the tuning range alone (no held-out range in the run at all). This is what
   locked `naive` for `five_hour` and `lifetime` for `seven_day`. Selection used:

   ```
   bun scripts/prediction-backtest.ts --from=2026-06-02T00:00:00Z --to=2026-08-01T00:00:00Z --estimators=ols,lifetime,naive,endpoint-seg-30m,endpoint-seg-1h,endpoint-seg-2h,ols-1h,trailing-3d,trailing-7d,dow-seasonal
   ```

2. **The held-out gate — a separate baselines-plus-winner invocation.** The
   three baselines and the locked winner, over the split range, scoring the
   acceptance criteria on the held-out side. Both locked winners were themselves
   baselines, so the estimator list reduced to the three baselines. The gate
   used:

   ```
   bun scripts/prediction-backtest.ts --from=2026-08-01T00:00:00Z --to=2026-08-23T00:00:00Z --estimators=ols,lifetime,naive
   ```

Both ran at commit `ab6e3455`, read-only against the live DB, and stdout-only
(no `--out`), which is why neither has a report file of its own.

The order matters and the separation is the point: the harness locks the winner
on the first range and carries it forward, so a held-out range can never pick
its own winner. Read the combined tables above the same way — where a candidate
scores better on the held-out range than the locked winner does (`trailing-7d`
on `seven_day`), that is a number the decision could not and did not use.

**Baseline figures shifted against the v2026.8.70 report** (`ols`, `lifetime`
and `naive` on the same range and the same data). The estimators did not change;
the scoring did, in three ways, all of them corrections toward what a deployment
would actually have done:

- **Expired resets are refused.** Every adapter, baselines included, now rejects
  a reset at or before the prediction instant, because `estimateWindowExhaustion`
  refuses a spent window in production.
- **0% used is a confident negative, not an abstention.** The estimator's
  `no-usage` branch is an answer. The lifetime baseline previously spent that
  case as missing coverage, which flattered its precision and depressed its
  coverage.
- **Reset knowledge is point-in-time.** The cohort and the display red rule read
  the reset carried by the sample AT the prediction instant, not the one carried
  by the window's final sample. Within a window `resets_at` drifts forward
  sample by sample, so near a reset the two differ; the final-sample value stays
  ground truth for the outcome label only.

Numbers from the v2026.8.70 report are therefore not comparable with these, even
for the same estimator on the same range.
