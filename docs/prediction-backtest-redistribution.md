# ClankerMux runway redistribution backtest

Generated: 2026-09-07T07:46:43.377Z

Reproduce with:

```
bun scripts/redistribution-backtest.ts --db=/home/darken/.config/clankermux/clankermux.db --from=2026-07-01T00:00:00Z --to=2026-09-06T00:00:00Z --out=docs/prediction-backtest-redistribution.md --records-out=/tmp/claude-1000/redistribution-records-lag.jsonl
```

| config | value |
|---|---|
| from | 2026-07-01T00:00:00.000Z |
| loadPadDays | 8 |
| seed | 20260823 |
| stepMinutes | 10 |
| to | 2026-09-06T00:00:00.000Z |

## Dataset

| field | value |
|---|---|
| usage_snapshots rows | 194759 |
| accounts | 7 |
| providers | anthropic, codex |
| first sample | 2026-06-02T12:48:00.294Z |
| last sample | 2026-09-07T07:45:17.977Z |
| replay interval | `[2026-07-01T00:00:00.000Z, 2026-09-06T00:00:00.000Z)` |
| grid instants | 9648 |

## Methodology

Fixed-grid joint-roster replay. At every instant of the grid the roster is
rebuilt from recorded snapshots and EVERY model is fed the same window
inputs; nothing reads a row after the instant it is replaying.

- Reading: the newest row per account no older than 10 min (production's projection freshness bar, not the wider display bar). A window whose recorded reset had already passed is dropped, as production's `projectableWindows` does.
- Five-hour prediction: the production OLS over a 6 h lookback, reconstructed WITHOUT the live point (the replay has none). Weekly: no prediction at all, because production emits none — the lifetime average is that window's primary estimator.
- Burn anchors are reconstructed from the revision drops observed up to the instant, and never from later ones. Tiers come from the row's own `plan_tier`/`rate_limit_tier` when it has them (`recorded`), else from today's account row (`assumed`).
- No reset-credit bank is modelled: the credit ledger is not reconstructible per instant, so every model runs without it.
- Truth is PER WINDOW, from the same `deriveOutcome` the per-window backtests use: exhausted at the first observed 100 %, survived only on positive evidence, censored otherwise. Placeholder windows (codex's one-sample 5 h artefacts) are skipped.
- Truth-grid membership at a tick is every account of the class with a loaded snapshot on both sides of it (first loaded row ≤ tick ≤ last loaded row). Outside that loaded span, the account is absent. Inside it, a reading older than 10 minutes censors the tick.
- Current model: account-level learning, the strict rule that ships — ONE learning window makes the whole account unprojectable.
- Transition tagging: class-wide, 24 h after the event, shortened to the dying window's reset for a peer exhaustion when that reset comes sooner. The dying account is excluded from its own event.
- ETA parity: the current model's beyond-reset ETA is recorded as no prediction, which is the same statement the scenario makes when it projects no exhaustion this cycle.
- Aggregation: the verdict is scored on ONE record per window lifecycle (the median instant), because instants inside one window are not independent draws. Per-record tables are reported beside it.
- Sign convention: signed ETA error is `predicted − observed`, so POSITIVE is predicted-later-than-observed, i.e. OPTIMISTIC.
- Observation lag: `scenario-equal` and `scenario-headroom` advance each reading over the gap between the instant its estimator measured to and the instant being replayed, at the share slope the first assignment gives it. The lag is taken per estimator path from the same anchor the current model uses: the fit's own last point on the regression path, the observation instant on the observation-anchored lifetime path, and nothing on the now-anchored paths, which carry none. An anchor ahead of the replayed instant clamps to zero lag, while the current model keeps anchoring its own ETA to that future instant, so the two part company there. On a lone account, wherever the anchor was recoverable and sits behind the instant, this projects the window from the same anchor the current model projects it from; a window there can still land elsewhere whenever another window of the class exhausts while this one is still projecting — including a death the correction applies AT the replayed instant — because that suspends the account's burn and the ETA then carries the span it spends dead, which is the scenario's own semantics rather than the redistribution. `scenario-equal-original` is the same equal split with that advance switched off, and is the control the mechanism checks below are measured against.

Verdict rule, declared before the run:

```
MODELS. `scenario-equal` is the demand-conserving scan that ADVANCES each
   reading over its observation lag; `scenario-equal-original` is the same
   equal split with the pre-correction scan, which schedules every window
   from the instant of the replay however old its reading is. Both are
   scored on the COMMON cohort: every model usable, truth observed.

A. NOT MORE OPTIMISTIC ON TRANSITIONS. On the any-transition cohort,
   lifecycle-balanced: max(paired median signed error of scenario-equal, 0)
   <= max(paired median signed error of current, 0), AND recall of
   scenario-equal >= recall of current. (Positive signed error = predicted
   later than observed = optimistic; a model that is EARLY is not rewarded
   for it, which is why both sides are clamped at 0.)
B. BETTER AT TRANSITIONS. On the same cohort, F1 of scenario-equal >= F1 of
   current.
C. NO SIGNIFICANT OVERALL LOSS. On the overall cohort, the block-bootstrap
   95% CI of F1(scenario-equal) - F1(current) is not entirely below zero
   (p97.5 >= 0). Read from the entry whose BASELINE is the current model.
D. NOT WORSE THAN THE ORIGINAL SCENARIO. On the any-transition common
   cohort, lifecycle-balanced: F1(scenario-equal) >= F1(scenario-equal-
   original), AND the paired median of |error of scenario-equal| - |error
   of scenario-equal-original| <= 0 over the records both models dated.
   Recall of both is printed beside D and is NOT judged: the correction
   can change the ORDER of a class's events, and with it which windows are
   dated before their reset at all, in EITHER direction.

replace = A and B and C and D. keep-scenario = any criterion FALSE.
insufficient-evidence = no criterion false, at least one indeterminate.
The verdict basis is the EQUAL share rule, pre-declared; the headroom rule
is reported beside it and is never the basis.
```

## Transition events

| id | kind | at | ends | class | account | window | detail |
|---:|---|---|---|---|---|---|---|
| 1 | gift-reset | 2026-07-01T21:14:40.129Z | 2026-07-02T21:14:40.129Z | anthropic | Claude-1 | seven_day | drop 52 → 0 pp |
| 2 | peer-exhaustion | 2026-07-02T00:40:40.683Z | 2026-07-02T02:09:59.771Z | anthropic | Claude-1 | five_hour | hit 100 with 1.5 h to reset |
| 3 | peer-exhaustion | 2026-07-02T09:38:41.152Z | 2026-07-02T12:10:00.173Z | anthropic | Claude-1 | five_hour | hit 100 with 2.5 h to reset |
| 4 | peer-exhaustion | 2026-07-02T11:56:41.474Z | 2026-07-02T12:10:00.448Z | anthropic | Claude-2 | five_hour | hit 100 with 0.2 h to reset |
| 5 | peer-exhaustion | 2026-07-02T14:11:22.339Z | 2026-07-02T15:10:00.000Z | codex | Codex-1 | five_hour | hit 100 with 1.0 h to reset |
| 6 | peer-exhaustion | 2026-07-03T13:19:27.425Z | 2026-07-04T13:19:27.425Z | anthropic | Claude-1 | seven_day | hit 100 with 41.7 h to reset |
| 7 | gift-reset | 2026-07-07T14:03:18.524Z | 2026-07-08T14:03:18.524Z | codex | Codex-1 | seven_day | drop 36 → 31 pp |
| 8 | peer-exhaustion | 2026-07-10T13:35:13.432Z | 2026-07-10T13:49:59.517Z | anthropic | Claude-1 | five_hour | hit 100 with 0.2 h to reset |
| 9 | peer-exhaustion | 2026-07-11T11:41:13.710Z | 2026-07-11T14:50:00.235Z | anthropic | Claude-2 | five_hour | hit 100 with 3.1 h to reset |
| 10 | peer-exhaustion | 2026-07-14T14:57:14.374Z | 2026-07-14T17:09:59.951Z | anthropic | Claude-1 | five_hour | hit 100 with 2.2 h to reset |
| 11 | peer-exhaustion | 2026-07-19T10:59:04.428Z | 2026-07-19T11:49:59.613Z | anthropic | Claude-2 | five_hour | hit 100 with 0.8 h to reset |
| 12 | peer-exhaustion | 2026-07-19T14:25:04.566Z | 2026-07-19T15:49:59.659Z | anthropic | Claude-1 | five_hour | hit 100 with 1.4 h to reset |
| 13 | peer-exhaustion | 2026-07-19T15:15:05.073Z | 2026-07-19T16:50:00.165Z | anthropic | Claude-2 | five_hour | hit 100 with 1.6 h to reset |
| 14 | peer-exhaustion | 2026-07-19T16:29:05.469Z | 2026-07-19T20:10:00.261Z | anthropic | Claude-3 | five_hour | hit 100 with 3.7 h to reset |
| 15 | peer-exhaustion | 2026-07-19T18:21:05.585Z | 2026-07-19T20:50:00.351Z | anthropic | Claude-1 | five_hour | hit 100 with 2.5 h to reset |
| 16 | peer-exhaustion | 2026-07-19T22:23:06.461Z | 2026-07-20T01:09:59.598Z | anthropic | Claude-3 | five_hour | hit 100 with 2.8 h to reset |
| 17 | peer-exhaustion | 2026-07-20T19:22:06.633Z | 2026-07-20T21:10:00.250Z | anthropic | Claude-3 | five_hour | hit 100 with 1.8 h to reset |
| 18 | add | 2026-07-24T13:50:43.342Z | 2026-07-25T13:50:43.342Z | anthropic | Claude-4 | — | created |
| 19 | peer-exhaustion | 2026-07-24T16:20:53.492Z | 2026-07-25T16:20:53.492Z | codex | Codex-1 | seven_day | hit 100 with 96.7 h to reset |
| 20 | peer-exhaustion | 2026-07-24T17:16:53.597Z | 2026-07-24T18:49:59.773Z | anthropic | Claude-4 | five_hour | hit 100 with 1.6 h to reset |
| 21 | peer-exhaustion | 2026-07-24T17:42:54.184Z | 2026-07-25T17:42:54.184Z | anthropic | Claude-2 | seven_day | hit 100 with 81.3 h to reset |
| 22 | peer-exhaustion | 2026-07-24T19:46:54.680Z | 2026-07-25T19:46:54.680Z | anthropic | Claude-1 | seven_day | hit 100 with 35.2 h to reset |
| 23 | peer-exhaustion | 2026-07-24T19:48:54.680Z | 2026-07-25T19:48:54.680Z | anthropic | Claude-3 | seven_day | hit 100 with 58.2 h to reset |
| 24 | peer-exhaustion | 2026-07-26T15:26:25.563Z | 2026-07-26T15:40:00.147Z | anthropic | Claude-4 | five_hour | hit 100 with 0.2 h to reset |
| 25 | peer-exhaustion | 2026-07-26T19:02:46.831Z | 2026-07-26T20:40:00.262Z | anthropic | Claude-4 | five_hour | hit 100 with 1.6 h to reset |
| 26 | peer-exhaustion | 2026-07-26T21:16:47.529Z | 2026-07-27T21:16:47.529Z | anthropic | Claude-4 | seven_day | hit 100 with 35.7 h to reset |
| 27 | peer-exhaustion | 2026-07-27T06:00:48.362Z | 2026-07-28T06:00:48.362Z | anthropic | Claude-3 | seven_day | hit 100 with unknown h to reset |
| 28 | peer-exhaustion | 2026-07-28T13:42:08.510Z | 2026-07-28T16:59:59.546Z | anthropic | Claude-3 | five_hour | hit 100 with 3.3 h to reset |
| 29 | gift-reset | 2026-07-28T13:52:08.511Z | 2026-07-29T13:52:08.511Z | anthropic | Claude-1 | five_hour | drop 90 → 13 pp |
| 30 | peer-exhaustion | 2026-07-28T15:18:09.431Z | 2026-07-28T18:00:00.061Z | anthropic | Claude-2 | five_hour | hit 100 with 2.7 h to reset |
| 31 | peer-exhaustion | 2026-07-28T19:36:41.291Z | 2026-07-28T21:59:59.677Z | anthropic | Claude-3 | five_hour | hit 100 with 2.4 h to reset |
| 32 | gift-reset | 2026-07-30T13:58:17.381Z | 2026-07-31T13:58:17.381Z | codex | Codex-1 | seven_day | drop 65 → 56 pp |
| 33 | gift-reset | 2026-07-30T16:04:17.392Z | 2026-07-31T16:04:17.392Z | codex | Codex-1 | seven_day | drop 65 → 58 pp |
| 34 | peer-exhaustion | 2026-08-03T18:06:23.413Z | 2026-08-04T03:00:00.308Z | anthropic | Claude-2 | seven_day | hit 100 with 8.9 h to reset |
| 35 | peer-exhaustion | 2026-08-04T15:44:49.581Z | 2026-08-04T17:00:00.368Z | anthropic | Claude-3 | five_hour | hit 100 with 1.3 h to reset |
| 36 | peer-exhaustion | 2026-08-04T20:36:50.624Z | 2026-08-05T20:36:50.624Z | codex | Codex-1 | seven_day | hit 100 with 79.0 h to reset |
| 37 | peer-exhaustion | 2026-08-06T12:49:40.245Z | 2026-08-07T12:49:40.245Z | anthropic | Claude-1 | seven_day | hit 100 with 66.2 h to reset |
| 38 | peer-exhaustion | 2026-08-07T19:02:42.073Z | 2026-08-08T19:02:42.073Z | anthropic | Claude-2 | seven_day | hit 100 with 80.0 h to reset |
| 39 | peer-exhaustion | 2026-08-07T19:58:42.079Z | 2026-08-08T19:58:42.079Z | anthropic | Claude-3 | seven_day | hit 100 with 58.0 h to reset |
| 40 | gift-reset | 2026-08-07T20:52:42.084Z | 2026-08-08T20:52:42.084Z | anthropic | Claude-2 | five_hour | drop 41 → 9 pp |
| 41 | peer-exhaustion | 2026-08-17T13:17:38.486Z | 2026-08-17T13:50:00.035Z | anthropic | Claude-1 | five_hour | hit 100 with 0.5 h to reset |
| 42 | peer-exhaustion | 2026-08-17T17:53:47.828Z | 2026-08-17T20:59:59.877Z | anthropic | Claude-3 | five_hour | hit 100 with 3.1 h to reset |
| 43 | gift-reset | 2026-08-19T15:59:10.008Z | 2026-08-20T15:59:10.008Z | anthropic | Claude-3 | seven_day | drop 81 → 0 pp |
| 44 | add | 2026-08-21T10:35:02.252Z | 2026-08-22T10:35:02.252Z | anthropic | Claude-5 | — | created |
| 45 | peer-exhaustion | 2026-08-24T12:12:49.311Z | 2026-08-24T12:59:59.609Z | anthropic | Claude-1 | five_hour | hit 100 with 0.8 h to reset |
| 46 | gift-reset | 2026-09-01T18:00:44.047Z | 2026-09-02T18:00:44.047Z | anthropic | Claude-3 | seven_day | drop 28 → 0 pp |
| 47 | gift-reset | 2026-09-01T18:00:44.047Z | 2026-09-02T18:00:44.047Z | anthropic | Claude-1 | seven_day | drop 91 → 1 pp |
| 48 | peer-exhaustion | 2026-09-02T07:17:12.861Z | 2026-09-02T08:50:00.007Z | anthropic | Claude-1 | five_hour | hit 100 with 1.5 h to reset |
| 49 | peer-exhaustion | 2026-09-02T16:02:28.745Z | 2026-09-02T18:50:00.497Z | anthropic | Claude-1 | five_hour | hit 100 with 2.8 h to reset |
| 50 | peer-exhaustion | 2026-09-02T16:06:28.745Z | 2026-09-02T18:49:59.539Z | anthropic | Claude-2 | five_hour | hit 100 with 2.7 h to reset |
| 51 | peer-exhaustion | 2026-09-02T17:18:29.332Z | 2026-09-02T19:00:00.149Z | anthropic | Claude-5 | five_hour | hit 100 with 1.7 h to reset |
| 52 | peer-exhaustion | 2026-09-02T18:08:29.337Z | 2026-09-02T18:50:00.166Z | anthropic | Claude-3 | five_hour | hit 100 with 0.7 h to reset |
| 53 | peer-exhaustion | 2026-09-03T12:37:55.770Z | 2026-09-03T14:50:00.082Z | anthropic | Claude-2 | five_hour | hit 100 with 2.2 h to reset |
| 54 | add | 2026-09-04T16:07:18.911Z | 2026-09-05T16:07:18.911Z | codex | Codex-2 | — | created |
| 55 | upgrade | 2026-09-05T07:11:10.649Z | 2026-09-06T07:11:10.649Z | codex | Codex-1 | — | pro/— → prolite/— |
| 56 | peer-exhaustion | 2026-09-05T13:43:12.377Z | 2026-09-05T18:29:09.000Z | codex | Codex-2 | five_hour | hit 100 with 4.8 h to reset |
| 57 | upgrade | 2026-09-05T13:57:12.378Z | 2026-09-06T13:57:12.378Z | codex | Codex-2 | — | plus/— → pro/— |
| 58 | upgrade | 2026-09-05T13:59:12.378Z | 2026-09-06T13:59:12.378Z | codex | Codex-1 | — | prolite/— → pro/— |
| 59 | peer-exhaustion | 2026-09-05T14:11:12.387Z | 2026-09-05T16:00:00.258Z | anthropic | Claude-1 | five_hour | hit 100 with 1.8 h to reset |
| 60 | peer-exhaustion | 2026-09-05T15:09:12.393Z | 2026-09-05T16:10:00.260Z | anthropic | Claude-5 | five_hour | hit 100 with 1.0 h to reset |
| 61 | peer-exhaustion | 2026-09-05T16:01:10.300Z | 2026-09-06T16:01:10.300Z | anthropic | Claude-1 | five_hour | hit 100 with unknown h to reset |
| 62 | peer-exhaustion | 2026-09-05T18:02:28.976Z | 2026-09-05T21:09:59.968Z | anthropic | Claude-5 | five_hour | hit 100 with 3.1 h to reset |
| 63 | peer-exhaustion | 2026-09-05T18:12:28.976Z | 2026-09-05T20:50:00.116Z | anthropic | Claude-2 | five_hour | hit 100 with 2.6 h to reset |
| 64 | peer-exhaustion | 2026-09-05T18:38:28.979Z | 2026-09-05T21:00:00.312Z | anthropic | Claude-3 | five_hour | hit 100 with 2.4 h to reset |
| 65 | peer-exhaustion | 2026-09-05T19:33:14.876Z | 2026-09-05T20:59:59.734Z | anthropic | Claude-4 | five_hour | hit 100 with 1.4 h to reset |

| tag | events | share of grid instants |
|---|---:|---:|
| peer-exhaustion | 50 | 13.7% |
| add | 3 | 4.5% |
| upgrade | 3 | 1.0% |
| gift-reset | 9 | 10.6% |

## Scores

### Overall

n: 25200 records, 619 window lifecycles, 57 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 619 | 100.0% | 619 | 0 | 32 | 77 | 495 | 15 | 0.294 | 0.681 | 0.410 | -4.8 | 25.8 | 0.053 |
| scenario-equal | 619 | 100.0% | 619 | 0 | 32 | 54 | 518 | 15 | 0.372 | 0.681 | 0.481 | 13.9 | 35.6 | 0.104 |
| scenario-equal-original | 619 | 100.0% | 619 | 0 | 32 | 54 | 518 | 15 | 0.372 | 0.681 | 0.481 | 14.6 | 36.9 | 0.104 |
| scenario-headroom | 619 | 100.0% | 619 | 0 | 23 | 38 | 534 | 24 | 0.377 | 0.489 | 0.426 | 48.6 | 81.8 | 0.139 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-equal | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-equal-original | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-headroom | 619 | 0 | 0 | 0 | 0 | 619 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 3 | 1 | 0.750 | -3.6 | 11 |
| current | 30m-2h | 20 | 12 | 0.625 | 0.4 | 35 |
| current | 2h-12h | 0 | 0 | — | — | 3 |
| current | 12h-48h | 3 | 2 | 0.600 | 758.8 | 19 |
| current | >48h | 6 | 0 | 1.000 | -2515.9 | 9 |
| scenario-equal | <30m | 4 | 0 | 1.000 | 0.1 | 7 |
| scenario-equal | 30m-2h | 18 | 14 | 0.563 | 19.1 | 18 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 4 | 1 | 0.800 | 5.0 | 23 |
| scenario-equal | >48h | 6 | 0 | 1.000 | -2196.3 | 6 |
| scenario-equal-original | <30m | 4 | 0 | 1.000 | 1.0 | 7 |
| scenario-equal-original | 30m-2h | 18 | 14 | 0.563 | 21.0 | 18 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 4 | 1 | 0.800 | 1.8 | 23 |
| scenario-equal-original | >48h | 6 | 0 | 1.000 | -2196.3 | 6 |
| scenario-headroom | <30m | 4 | 0 | 1.000 | 63.0 | 1 |
| scenario-headroom | 30m-2h | 10 | 22 | 0.313 | 48.6 | 9 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 3 | 2 | 0.600 | 758.8 | 18 |
| scenario-headroom | >48h | 6 | 0 | 1.000 | -1360.3 | 10 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 25200 | 100.0% | 25200 | 0 | 2992 | 7726 | 13788 | 694 | 0.279 | 0.812 | 0.415 | -70.4 | 1205.8 | 0.123 |
| scenario-equal | 25200 | 100.0% | 25200 | 0 | 3150 | 7582 | 13932 | 536 | 0.294 | 0.855 | 0.437 | -401.3 | 1048.3 | 0.110 |
| scenario-equal-original | 25200 | 100.0% | 25200 | 0 | 3148 | 7574 | 13940 | 538 | 0.294 | 0.854 | 0.437 | -401.8 | 1049.7 | 0.110 |
| scenario-headroom | 25200 | 100.0% | 25200 | 0 | 2744 | 6201 | 15313 | 942 | 0.307 | 0.744 | 0.434 | -14.3 | 965.6 | 0.103 |

Paired median signed error (n=27; positive = optimistic): scenario-equal 14.1 min, current -12.4 min.

Against the pre-correction scan (n=32): scenario-equal 13.9 min, scenario-equal-original 14.6 min; paired median change in absolute error -0.5 min (n=32, negative = the correction lands closer).

### Any transition

n: 4280 records, 171 window lifecycles, 57 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 171 | 100.0% | 171 | 0 | 18 | 30 | 113 | 10 | 0.375 | 0.643 | 0.474 | -0.4 | 29.5 | 0.048 |
| scenario-equal | 171 | 100.0% | 171 | 0 | 21 | 25 | 118 | 7 | 0.457 | 0.750 | 0.568 | 14.1 | 51.6 | 0.066 |
| scenario-equal-original | 171 | 100.0% | 171 | 0 | 21 | 25 | 118 | 7 | 0.457 | 0.750 | 0.568 | 14.6 | 53.1 | 0.075 |
| scenario-headroom | 171 | 100.0% | 171 | 0 | 17 | 22 | 121 | 11 | 0.436 | 0.607 | 0.507 | 36.4 | 81.8 | 0.137 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 171 | 0 | 0 | 0 | 0 | 171 |
| scenario-equal | 171 | 0 | 0 | 0 | 0 | 171 |
| scenario-equal-original | 171 | 0 | 0 | 0 | 0 | 171 |
| scenario-headroom | 171 | 0 | 0 | 0 | 0 | 171 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 3 | 2 | 0.600 | 13.1 | 4 |
| current | 30m-2h | 8 | 6 | 0.571 | 0.4 | 13 |
| current | 2h-12h | 2 | 0 | 1.000 | 50.3 | 2 |
| current | 12h-48h | 1 | 2 | 0.333 | -442.1 | 7 |
| current | >48h | 4 | 0 | 1.000 | -5678.0 | 4 |
| scenario-equal | <30m | 4 | 1 | 0.800 | 0.1 | 4 |
| scenario-equal | 30m-2h | 9 | 5 | 0.643 | 19.1 | 8 |
| scenario-equal | 2h-12h | 2 | 0 | 1.000 | 59.5 | 1 |
| scenario-equal | 12h-48h | 2 | 1 | 0.667 | -758.3 | 10 |
| scenario-equal | >48h | 4 | 0 | 1.000 | -3934.5 | 2 |
| scenario-equal-original | <30m | 4 | 1 | 0.800 | 1.0 | 4 |
| scenario-equal-original | 30m-2h | 9 | 5 | 0.643 | 21.0 | 8 |
| scenario-equal-original | 2h-12h | 2 | 0 | 1.000 | 59.5 | 1 |
| scenario-equal-original | 12h-48h | 2 | 1 | 0.667 | -758.3 | 10 |
| scenario-equal-original | >48h | 4 | 0 | 1.000 | -3934.5 | 2 |
| scenario-headroom | <30m | 4 | 1 | 0.800 | 19.2 | 2 |
| scenario-headroom | 30m-2h | 6 | 8 | 0.429 | 36.4 | 7 |
| scenario-headroom | 2h-12h | 2 | 0 | 1.000 | 130.9 | 0 |
| scenario-headroom | 12h-48h | 1 | 2 | 0.333 | -400.3 | 10 |
| scenario-headroom | >48h | 4 | 0 | 1.000 | -1762.8 | 3 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 4280 | 100.0% | 4280 | 0 | 468 | 1490 | 2075 | 247 | 0.239 | 0.655 | 0.350 | -369.8 | 538.5 | 0.083 |
| scenario-equal | 4280 | 100.0% | 4280 | 0 | 589 | 1558 | 2007 | 126 | 0.274 | 0.824 | 0.412 | -314.3 | 636.0 | 0.085 |
| scenario-equal-original | 4280 | 100.0% | 4280 | 0 | 588 | 1557 | 2008 | 127 | 0.274 | 0.822 | 0.411 | -321.2 | 636.0 | 0.085 |
| scenario-headroom | 4280 | 100.0% | 4280 | 0 | 482 | 1416 | 2149 | 233 | 0.254 | 0.674 | 0.369 | -134.2 | 721.1 | 0.112 |

Paired median signed error (n=16; positive = optimistic): scenario-equal 14.1 min, current -3.6 min.

Against the pre-correction scan (n=21): scenario-equal 14.1 min, scenario-equal-original 14.6 min; paired median change in absolute error 0.0 min (n=21, negative = the correction lands closer).

### peer-exhaustion

n: 2245 records, 116 window lifecycles, 51 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 116 | 100.0% | 116 | 0 | 14 | 24 | 71 | 7 | 0.368 | 0.667 | 0.475 | -3.6 | 66.9 | 0.052 |
| scenario-equal | 116 | 100.0% | 116 | 0 | 18 | 22 | 73 | 3 | 0.450 | 0.857 | 0.590 | 0.1 | 29.6 | 0.064 |
| scenario-equal-original | 116 | 100.0% | 116 | 0 | 18 | 22 | 73 | 3 | 0.450 | 0.857 | 0.590 | 1.0 | 29.6 | 0.070 |
| scenario-headroom | 116 | 100.0% | 116 | 0 | 16 | 19 | 76 | 5 | 0.457 | 0.762 | 0.571 | 28.3 | 63.0 | 0.115 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 116 | 0 | 0 | 0 | 0 | 116 |
| scenario-equal | 116 | 0 | 0 | 0 | 0 | 116 |
| scenario-equal-original | 116 | 0 | 0 | 0 | 0 | 116 |
| scenario-headroom | 116 | 0 | 0 | 0 | 0 | 116 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 4 | 2 | 0.667 | 13.1 | 3 |
| current | 30m-2h | 5 | 3 | 0.625 | 15.8 | 8 |
| current | 2h-12h | 0 | 0 | — | — | 3 |
| current | 12h-48h | 1 | 2 | 0.333 | -442.1 | 4 |
| current | >48h | 4 | 0 | 1.000 | -5641.6 | 6 |
| scenario-equal | <30m | 5 | 1 | 0.833 | 19.2 | 5 |
| scenario-equal | 30m-2h | 7 | 1 | 0.875 | 19.1 | 6 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-equal | 12h-48h | 2 | 1 | 0.667 | -758.3 | 5 |
| scenario-equal | >48h | 4 | 0 | 1.000 | -4331.2 | 4 |
| scenario-equal-original | <30m | 5 | 1 | 0.833 | 20.1 | 5 |
| scenario-equal-original | 30m-2h | 7 | 1 | 0.875 | 21.0 | 6 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-equal-original | 12h-48h | 2 | 1 | 0.667 | -758.3 | 5 |
| scenario-equal-original | >48h | 4 | 0 | 1.000 | -4331.2 | 4 |
| scenario-headroom | <30m | 5 | 1 | 0.833 | 63.0 | 3 |
| scenario-headroom | 30m-2h | 6 | 2 | 0.750 | 36.4 | 7 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 1 | 2 | 0.333 | -400.3 | 3 |
| scenario-headroom | >48h | 4 | 0 | 1.000 | -3292.8 | 6 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 2245 | 100.0% | 2245 | 0 | 321 | 651 | 1137 | 136 | 0.330 | 0.702 | 0.449 | -827.6 | 827.6 | 0.098 |
| scenario-equal | 2245 | 100.0% | 2245 | 0 | 445 | 670 | 1118 | 12 | 0.399 | 0.974 | 0.566 | -540.7 | 618.4 | 0.084 |
| scenario-equal-original | 2245 | 100.0% | 2245 | 0 | 445 | 669 | 1119 | 12 | 0.399 | 0.974 | 0.567 | -540.7 | 618.4 | 0.084 |
| scenario-headroom | 2245 | 100.0% | 2245 | 0 | 363 | 632 | 1156 | 94 | 0.365 | 0.794 | 0.500 | -263.1 | 589.8 | 0.086 |

Paired median signed error (n=14; positive = optimistic): scenario-equal 14.1 min, current -3.6 min.

Against the pre-correction scan (n=18): scenario-equal 0.1 min, scenario-equal-original 1.0 min; paired median change in absolute error 0.0 min (n=18, negative = the correction lands closer).

### add

n: 974 records, 37 window lifecycles, 8 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 37 | 100.0% | 37 | 0 | 3 | 7 | 25 | 2 | 0.300 | 0.600 | 0.400 | 50.3 | 50.3 | 0.005 |
| scenario-equal | 37 | 100.0% | 37 | 0 | 4 | 6 | 26 | 1 | 0.400 | 0.800 | 0.533 | 47.3 | 59.5 | 0.006 |
| scenario-equal-original | 37 | 100.0% | 37 | 0 | 4 | 6 | 26 | 1 | 0.400 | 0.800 | 0.533 | 47.3 | 59.5 | 0.006 |
| scenario-headroom | 37 | 100.0% | 37 | 0 | 4 | 5 | 27 | 1 | 0.444 | 0.800 | 0.571 | 130.9 | 787.4 | 0.078 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 37 | 0 | 0 | 0 | 0 | 37 |
| scenario-equal | 37 | 0 | 0 | 0 | 0 | 37 |
| scenario-equal-original | 37 | 0 | 0 | 0 | 0 | 37 |
| scenario-headroom | 37 | 0 | 0 | 0 | 0 | 37 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 1 | 0.000 | — | 3 |
| current | 2h-12h | 3 | 0 | 1.000 | 50.3 | 3 |
| current | 12h-48h | 0 | 1 | 0.000 | — | 1 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 1 | 0.000 | — | 1 |
| scenario-equal | 2h-12h | 3 | 0 | 1.000 | 59.5 | 3 |
| scenario-equal | 12h-48h | 1 | 0 | 1.000 | -1195.8 | 2 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 1 | 0.000 | — | 1 |
| scenario-equal-original | 2h-12h | 3 | 0 | 1.000 | 59.5 | 3 |
| scenario-equal-original | 12h-48h | 1 | 0 | 1.000 | -1195.8 | 2 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 1 | 0.000 | — | 0 |
| scenario-headroom | 2h-12h | 3 | 0 | 1.000 | 787.4 | 0 |
| scenario-headroom | 12h-48h | 1 | 0 | 1.000 | -1195.8 | 5 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 974 | 100.0% | 974 | 0 | 79 | 260 | 538 | 97 | 0.233 | 0.449 | 0.307 | 74.3 | 84.6 | 0.009 |
| scenario-equal | 974 | 100.0% | 974 | 0 | 160 | 299 | 499 | 16 | 0.349 | 0.909 | 0.504 | 22.4 | 239.4 | 0.024 |
| scenario-equal-original | 974 | 100.0% | 974 | 0 | 159 | 299 | 499 | 17 | 0.347 | 0.903 | 0.502 | 22.4 | 245.4 | 0.024 |
| scenario-headroom | 974 | 100.0% | 974 | 0 | 112 | 220 | 578 | 64 | 0.337 | 0.636 | 0.441 | 201.7 | 821.2 | 0.102 |

Paired median signed error (n=3; positive = optimistic): scenario-equal 59.5 min, current 50.3 min.

Against the pre-correction scan (n=4): scenario-equal 47.3 min, scenario-equal-original 47.3 min; paired median change in absolute error 0.0 min (n=4, negative = the correction lands closer).

### upgrade

n: 23 records, 1 window lifecycles, 2 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1 | 100.0% | 1 | 0 | 0 | 0 | 1 | 0 | — | — | — | — | — | — |
| scenario-equal | 1 | 100.0% | 1 | 0 | 0 | 0 | 1 | 0 | — | — | — | — | — | — |
| scenario-equal-original | 1 | 100.0% | 1 | 0 | 0 | 0 | 1 | 0 | — | — | — | — | — | — |
| scenario-headroom | 1 | 100.0% | 1 | 0 | 0 | 0 | 1 | 0 | — | — | — | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 1 | 0 | 0 | 0 | 0 | 1 |
| scenario-equal | 1 | 0 | 0 | 0 | 0 | 1 |
| scenario-equal-original | 1 | 0 | 0 | 0 | 0 | 1 |
| scenario-headroom | 1 | 0 | 0 | 0 | 0 | 1 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 23 | 100.0% | 23 | 0 | 0 | 5 | 18 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 23 | 100.0% | 23 | 0 | 0 | 1 | 22 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 23 | 100.0% | 23 | 0 | 0 | 1 | 22 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 23 | 100.0% | 23 | 0 | 0 | 0 | 23 | 0 | — | — | — | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

Against the pre-correction scan (n=0): scenario-equal — min, scenario-equal-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

### gift-reset

n: 1714 records, 68 window lifecycles, 20 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 68 | 100.0% | 68 | 0 | 7 | 14 | 42 | 5 | 0.333 | 0.583 | 0.424 | -0.4 | 4.8 | 0.016 |
| scenario-equal | 68 | 100.0% | 68 | 0 | 7 | 11 | 45 | 5 | 0.389 | 0.583 | 0.467 | 19.1 | 51.6 | 0.172 |
| scenario-equal-original | 68 | 100.0% | 68 | 0 | 7 | 11 | 45 | 5 | 0.389 | 0.583 | 0.467 | 21.0 | 53.1 | 0.177 |
| scenario-headroom | 68 | 100.0% | 68 | 0 | 4 | 9 | 47 | 8 | 0.308 | 0.333 | 0.320 | -34.5 | 51.5 | 0.172 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 68 | 0 | 0 | 0 | 0 | 68 |
| scenario-equal | 68 | 0 | 0 | 0 | 0 | 68 |
| scenario-equal-original | 68 | 0 | 0 | 0 | 0 | 68 |
| scenario-headroom | 68 | 0 | 0 | 0 | 0 | 68 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 1 |
| current | 30m-2h | 6 | 4 | 0.600 | -0.4 | 5 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 1 | 0.000 | — | 7 |
| current | >48h | 1 | 0 | 1.000 | -6519.4 | 1 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 6 | 4 | 0.600 | 19.1 | 3 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-equal | 12h-48h | 0 | 1 | 0.000 | — | 7 |
| scenario-equal | >48h | 1 | 0 | 1.000 | -7011.8 | 0 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 6 | 4 | 0.600 | 21.0 | 3 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-equal-original | 12h-48h | 0 | 1 | 0.000 | — | 7 |
| scenario-equal-original | >48h | 1 | 0 | 1.000 | -7011.8 | 0 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 3 | 7 | 0.300 | 51.5 | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-headroom | 12h-48h | 0 | 1 | 0.000 | — | 7 |
| scenario-headroom | >48h | 1 | 0 | 1.000 | -6880.8 | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1714 | 100.0% | 1714 | 0 | 143 | 736 | 733 | 102 | 0.163 | 0.584 | 0.254 | -5260.7 | 5260.7 | 0.522 |
| scenario-equal | 1714 | 100.0% | 1714 | 0 | 140 | 753 | 716 | 105 | 0.157 | 0.571 | 0.246 | -5341.2 | 5332.5 | 0.529 |
| scenario-equal-original | 1714 | 100.0% | 1714 | 0 | 140 | 753 | 716 | 105 | 0.157 | 0.571 | 0.246 | -5341.2 | 5332.5 | 0.529 |
| scenario-headroom | 1714 | 100.0% | 1714 | 0 | 113 | 712 | 757 | 132 | 0.137 | 0.461 | 0.211 | -5665.0 | 5665.0 | 0.562 |

Paired median signed error (n=5; positive = optimistic): scenario-equal 19.1 min, current -4.8 min.

Against the pre-correction scan (n=7): scenario-equal 19.1 min, scenario-equal-original 21.0 min; paired median change in absolute error -1.5 min (n=7, negative = the correction lands closer).

### Peer exhaustion by time since death

IF a survivor's own lookback already contains the traffic it absorbed, the scenario would be adding that demand a second time and would read pessimistic the longer the peer has been dead. That is the hypothesis this cohort exists to test, not a property the measurements here establish; the slope table below is what speaks to it. Disclosed, not corrected.

Buckets are fine (30 min at the start) because a five-hour window is only 300 minutes long: at the three coarse buckets this replaced, one bucket held a whole five-hour lifecycle. Reported combined and split by window kind, because the two kinds absorb a death on completely different timescales.

#### combined

##### since death 0-30m

n: 308 records, 85 window lifecycles, 49 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 85 | 100.0% | 85 | 0 | 9 | 17 | 50 | 9 | 0.346 | 0.500 | 0.409 | -887.9 | 887.9 | 0.088 |
| scenario-equal | 85 | 100.0% | 85 | 0 | 15 | 26 | 41 | 3 | 0.366 | 0.833 | 0.508 | 6.0 | 61.7 | 0.114 |
| scenario-equal-original | 85 | 100.0% | 85 | 0 | 15 | 26 | 41 | 3 | 0.366 | 0.833 | 0.508 | 7.6 | 63.2 | 0.114 |
| scenario-headroom | 85 | 100.0% | 85 | 0 | 12 | 22 | 45 | 6 | 0.353 | 0.667 | 0.462 | -12.5 | 109.9 | 0.089 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 85 | 0 | 0 | 0 | 0 | 85 |
| scenario-equal | 85 | 0 | 0 | 0 | 0 | 85 |
| scenario-equal-original | 85 | 0 | 0 | 0 | 0 | 85 |
| scenario-headroom | 85 | 0 | 0 | 0 | 0 | 85 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 2 | 1 | 0.667 | 7.8 | 3 |
| current | 30m-2h | 1 | 5 | 0.167 | 8.2 | 4 |
| current | 2h-12h | 1 | 1 | 0.500 | 70.9 | 2 |
| current | 12h-48h | 2 | 1 | 0.667 | -1780.6 | 4 |
| current | >48h | 3 | 1 | 0.750 | -5878.0 | 4 |
| scenario-equal | <30m | 3 | 0 | 1.000 | 14.2 | 4 |
| scenario-equal | 30m-2h | 4 | 2 | 0.667 | 39.9 | 6 |
| scenario-equal | 2h-12h | 2 | 0 | 1.000 | -12.5 | 8 |
| scenario-equal | 12h-48h | 2 | 1 | 0.667 | -1557.0 | 4 |
| scenario-equal | >48h | 4 | 0 | 1.000 | -4291.2 | 4 |
| scenario-equal-original | <30m | 3 | 0 | 1.000 | 15.7 | 4 |
| scenario-equal-original | 30m-2h | 4 | 2 | 0.667 | 41.7 | 6 |
| scenario-equal-original | 2h-12h | 2 | 0 | 1.000 | -11.1 | 8 |
| scenario-equal-original | 12h-48h | 2 | 1 | 0.667 | -1557.0 | 4 |
| scenario-equal-original | >48h | 4 | 0 | 1.000 | -4291.2 | 4 |
| scenario-headroom | <30m | 3 | 0 | 1.000 | 67.9 | 2 |
| scenario-headroom | 30m-2h | 2 | 4 | 0.333 | -16.1 | 8 |
| scenario-headroom | 2h-12h | 2 | 0 | 1.000 | -12.5 | 4 |
| scenario-headroom | 12h-48h | 2 | 1 | 0.667 | -895.3 | 2 |
| scenario-headroom | >48h | 3 | 1 | 0.750 | -2712.3 | 6 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 308 | 100.0% | 308 | 0 | 42 | 81 | 160 | 25 | 0.341 | 0.627 | 0.442 | -887.9 | 875.8 | 0.089 |
| scenario-equal | 308 | 100.0% | 308 | 0 | 60 | 103 | 138 | 7 | 0.368 | 0.896 | 0.522 | -10.1 | 85.9 | 0.099 |
| scenario-equal-original | 308 | 100.0% | 308 | 0 | 60 | 103 | 138 | 7 | 0.368 | 0.896 | 0.522 | -9.4 | 87.7 | 0.102 |
| scenario-headroom | 308 | 100.0% | 308 | 0 | 51 | 91 | 150 | 16 | 0.359 | 0.761 | 0.488 | -10.1 | 235.9 | 0.064 |

Paired median signed error (n=9; positive = optimistic): scenario-equal -1075.2 min, current -887.9 min.

Against the pre-correction scan (n=15): scenario-equal 6.0 min, scenario-equal-original 7.6 min; paired median change in absolute error 0.0 min (n=15, negative = the correction lands closer).

##### since death 30-60m

n: 267 records, 77 window lifecycles, 47 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 77 | 100.0% | 77 | 0 | 11 | 21 | 40 | 5 | 0.344 | 0.688 | 0.458 | -36.6 | 53.9 | 0.104 |
| scenario-equal | 77 | 100.0% | 77 | 0 | 14 | 21 | 40 | 2 | 0.400 | 0.875 | 0.549 | -0.4 | 29.6 | 0.096 |
| scenario-equal-original | 77 | 100.0% | 77 | 0 | 14 | 21 | 40 | 2 | 0.400 | 0.875 | 0.549 | 0.3 | 30.6 | 0.102 |
| scenario-headroom | 77 | 100.0% | 77 | 0 | 12 | 16 | 45 | 4 | 0.429 | 0.750 | 0.545 | -0.4 | 111.5 | 0.089 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 77 | 0 | 0 | 0 | 0 | 77 |
| scenario-equal | 77 | 0 | 0 | 0 | 0 | 77 |
| scenario-equal-original | 77 | 0 | 0 | 0 | 0 | 77 |
| scenario-headroom | 77 | 0 | 0 | 0 | 0 | 77 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 2 | 2 | 0.500 | 25.3 | 3 |
| current | 30m-2h | 4 | 2 | 0.667 | -1.3 | 6 |
| current | 2h-12h | 0 | 0 | — | — | 4 |
| current | 12h-48h | 2 | 0 | 1.000 | -1809.7 | 5 |
| current | >48h | 3 | 1 | 0.750 | -4879.7 | 3 |
| scenario-equal | <30m | 3 | 1 | 0.750 | 3.0 | 5 |
| scenario-equal | 30m-2h | 5 | 1 | 0.833 | 28.8 | 6 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 4 |
| scenario-equal | 12h-48h | 2 | 0 | 1.000 | -1573.7 | 2 |
| scenario-equal | >48h | 4 | 0 | 1.000 | -2517.9 | 4 |
| scenario-equal-original | <30m | 3 | 1 | 0.750 | 3.9 | 5 |
| scenario-equal-original | 30m-2h | 5 | 1 | 0.833 | 29.6 | 6 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 4 |
| scenario-equal-original | 12h-48h | 2 | 0 | 1.000 | -1573.7 | 2 |
| scenario-equal-original | >48h | 4 | 0 | 1.000 | -2518.8 | 4 |
| scenario-headroom | <30m | 2 | 2 | 0.500 | -0.4 | 2 |
| scenario-headroom | 30m-2h | 4 | 2 | 0.667 | 6.0 | 7 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-headroom | 12h-48h | 2 | 0 | 1.000 | -903.4 | 1 |
| scenario-headroom | >48h | 4 | 0 | 1.000 | -2476.3 | 5 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 267 | 100.0% | 267 | 0 | 45 | 73 | 133 | 16 | 0.381 | 0.738 | 0.503 | -1646.3 | 1646.3 | 0.180 |
| scenario-equal | 267 | 100.0% | 267 | 0 | 57 | 78 | 128 | 4 | 0.422 | 0.934 | 0.582 | -1061.0 | 1131.2 | 0.118 |
| scenario-equal-original | 267 | 100.0% | 267 | 0 | 57 | 78 | 128 | 4 | 0.422 | 0.934 | 0.582 | -1061.0 | 1131.2 | 0.118 |
| scenario-headroom | 267 | 100.0% | 267 | 0 | 50 | 71 | 135 | 11 | 0.413 | 0.820 | 0.549 | -772.0 | 887.6 | 0.116 |

Paired median signed error (n=11; positive = optimistic): scenario-equal 3.0 min, current -36.6 min.

Against the pre-correction scan (n=14): scenario-equal -0.4 min, scenario-equal-original 0.3 min; paired median change in absolute error -0.5 min (n=14, negative = the correction lands closer).

##### since death 1-2h

n: 403 records, 66 window lifecycles, 42 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 66 | 100.0% | 66 | 0 | 13 | 16 | 34 | 3 | 0.448 | 0.813 | 0.578 | -0.5 | 16.6 | 0.053 |
| scenario-equal | 66 | 100.0% | 66 | 0 | 15 | 13 | 37 | 1 | 0.536 | 0.938 | 0.682 | 0.1 | 24.7 | 0.082 |
| scenario-equal-original | 66 | 100.0% | 66 | 0 | 15 | 13 | 37 | 1 | 0.536 | 0.938 | 0.682 | 1.0 | 25.2 | 0.084 |
| scenario-headroom | 66 | 100.0% | 66 | 0 | 14 | 13 | 37 | 2 | 0.519 | 0.875 | 0.651 | 27.7 | 81.8 | 0.130 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 66 | 0 | 0 | 0 | 0 | 66 |
| scenario-equal | 66 | 0 | 0 | 0 | 0 | 66 |
| scenario-equal-original | 66 | 0 | 0 | 0 | 0 | 66 |
| scenario-headroom | 66 | 0 | 0 | 0 | 0 | 66 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 4 | 0 | 1.000 | -0.5 | 3 |
| current | 30m-2h | 4 | 2 | 0.667 | 15.8 | 7 |
| current | 2h-12h | 0 | 0 | — | — | 1 |
| current | 12h-48h | 0 | 0 | — | — | 3 |
| current | >48h | 5 | 1 | 0.833 | -2561.3 | 2 |
| scenario-equal | <30m | 4 | 0 | 1.000 | 9.3 | 5 |
| scenario-equal | 30m-2h | 5 | 1 | 0.833 | 17.1 | 3 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 4 |
| scenario-equal | >48h | 6 | 0 | 1.000 | -2243.0 | 1 |
| scenario-equal-original | <30m | 4 | 0 | 1.000 | 10.9 | 5 |
| scenario-equal-original | 30m-2h | 5 | 1 | 0.833 | 18.0 | 3 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 4 |
| scenario-equal-original | >48h | 6 | 0 | 1.000 | -2243.0 | 1 |
| scenario-headroom | <30m | 3 | 1 | 0.750 | 63.0 | 3 |
| scenario-headroom | 30m-2h | 5 | 1 | 0.833 | 35.3 | 5 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-headroom | >48h | 6 | 0 | 1.000 | -1398.6 | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 403 | 100.0% | 403 | 0 | 83 | 105 | 199 | 16 | 0.441 | 0.838 | 0.578 | -815.6 | 815.6 | 0.092 |
| scenario-equal | 403 | 100.0% | 403 | 0 | 98 | 105 | 199 | 1 | 0.483 | 0.990 | 0.649 | -1096.6 | 1084.9 | 0.115 |
| scenario-equal-original | 403 | 100.0% | 403 | 0 | 98 | 105 | 199 | 1 | 0.483 | 0.990 | 0.649 | -1096.6 | 1084.9 | 0.114 |
| scenario-headroom | 403 | 100.0% | 403 | 0 | 97 | 93 | 211 | 2 | 0.511 | 0.980 | 0.671 | -24.5 | 615.4 | 0.130 |

Paired median signed error (n=13; positive = optimistic): scenario-equal 0.1 min, current -0.5 min.

Against the pre-correction scan (n=15): scenario-equal 0.1 min, scenario-equal-original 1.0 min; paired median change in absolute error 0.0 min (n=15, negative = the correction lands closer).

##### since death 2-3h

n: 198 records, 42 window lifecycles, 27 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 42 | 100.0% | 42 | 0 | 4 | 9 | 27 | 2 | 0.308 | 0.667 | 0.421 | -5736.9 | 2538.2 | 0.252 |
| scenario-equal | 42 | 100.0% | 42 | 0 | 6 | 8 | 28 | 0 | 0.429 | 1.000 | 0.600 | -2187.0 | 2142.4 | 0.213 |
| scenario-equal-original | 42 | 100.0% | 42 | 0 | 6 | 8 | 28 | 0 | 0.429 | 1.000 | 0.600 | -2187.0 | 2142.4 | 0.213 |
| scenario-headroom | 42 | 100.0% | 42 | 0 | 6 | 5 | 31 | 0 | 0.545 | 1.000 | 0.706 | -1233.4 | 1172.4 | 0.116 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 42 | 0 | 0 | 0 | 0 | 42 |
| scenario-equal | 42 | 0 | 0 | 0 | 0 | 42 |
| scenario-equal-original | 42 | 0 | 0 | 0 | 0 | 42 |
| scenario-headroom | 42 | 0 | 0 | 0 | 0 | 42 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 1 | 0.000 | — | 3 |
| current | 30m-2h | 0 | 0 | — | — | 2 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 1 | 0.000 | — | 2 |
| current | >48h | 4 | 0 | 1.000 | -5736.9 | 2 |
| scenario-equal | <30m | 1 | 0 | 1.000 | 0.4 | 2 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 1 | 0 | 1.000 | -1233.4 | 4 |
| scenario-equal | >48h | 4 | 0 | 1.000 | -3459.4 | 1 |
| scenario-equal-original | <30m | 1 | 0 | 1.000 | 1.7 | 2 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 1 | 0 | 1.000 | -1233.4 | 4 |
| scenario-equal-original | >48h | 4 | 0 | 1.000 | -3459.4 | 1 |
| scenario-headroom | <30m | 1 | 0 | 1.000 | 0.4 | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 1 | 0 | 1.000 | -1233.4 | 3 |
| scenario-headroom | >48h | 4 | 0 | 1.000 | -3401.4 | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 198 | 100.0% | 198 | 0 | 32 | 45 | 114 | 7 | 0.416 | 0.821 | 0.552 | -5611.4 | 5589.1 | 0.554 |
| scenario-equal | 198 | 100.0% | 198 | 0 | 39 | 45 | 114 | 0 | 0.464 | 1.000 | 0.634 | -2187.0 | 2187.0 | 0.217 |
| scenario-equal-original | 198 | 100.0% | 198 | 0 | 39 | 45 | 114 | 0 | 0.464 | 1.000 | 0.634 | -2187.0 | 2187.0 | 0.217 |
| scenario-headroom | 198 | 100.0% | 198 | 0 | 39 | 38 | 121 | 0 | 0.506 | 1.000 | 0.672 | -1246.0 | 1246.0 | 0.124 |

Paired median signed error (n=4; positive = optimistic): scenario-equal -3459.4 min, current -5736.9 min.

Against the pre-correction scan (n=6): scenario-equal -2187.0 min, scenario-equal-original -2187.0 min; paired median change in absolute error 0.0 min (n=6, negative = the correction lands closer).

##### since death 3-4h

n: 85 records, 17 window lifecycles, 15 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 17 | 100.0% | 17 | 0 | 3 | 3 | 10 | 1 | 0.500 | 0.750 | 0.600 | -5594.0 | 5594.0 | 0.555 |
| scenario-equal | 17 | 100.0% | 17 | 0 | 4 | 3 | 10 | 0 | 0.571 | 1.000 | 0.727 | -3811.0 | 2164.9 | 0.215 |
| scenario-equal-original | 17 | 100.0% | 17 | 0 | 4 | 3 | 10 | 0 | 0.571 | 1.000 | 0.727 | -3811.0 | 2164.9 | 0.215 |
| scenario-headroom | 17 | 100.0% | 17 | 0 | 4 | 3 | 10 | 0 | 0.571 | 1.000 | 0.727 | -3784.8 | 1158.2 | 0.115 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-equal | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-equal-original | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-headroom | 17 | 0 | 0 | 0 | 0 | 17 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 1 | 0.000 | — | 0 |
| current | >48h | 3 | 0 | 1.000 | -5594.0 | 3 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 1 | 0 | 1.000 | -1158.2 | 3 |
| scenario-equal | >48h | 3 | 0 | 1.000 | -3811.0 | 0 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 1 | 0 | 1.000 | -1158.2 | 3 |
| scenario-equal-original | >48h | 3 | 0 | 1.000 | -3811.0 | 0 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 1 | 0 | 1.000 | -1158.2 | 2 |
| scenario-headroom | >48h | 3 | 0 | 1.000 | -3784.8 | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 85 | 100.0% | 85 | 0 | 12 | 20 | 47 | 6 | 0.375 | 0.667 | 0.480 | -5594.0 | 2531.6 | 0.251 |
| scenario-equal | 85 | 100.0% | 85 | 0 | 18 | 21 | 46 | 0 | 0.462 | 1.000 | 0.632 | -2164.9 | 2164.1 | 0.215 |
| scenario-equal-original | 85 | 100.0% | 85 | 0 | 18 | 21 | 46 | 0 | 0.462 | 1.000 | 0.632 | -2164.9 | 2164.1 | 0.215 |
| scenario-headroom | 85 | 100.0% | 85 | 0 | 18 | 21 | 46 | 0 | 0.462 | 1.000 | 0.632 | -1158.2 | 1145.7 | 0.114 |

Paired median signed error (n=3; positive = optimistic): scenario-equal -3811.0 min, current -5594.0 min.

Against the pre-correction scan (n=4): scenario-equal -3811.0 min, scenario-equal-original -3811.0 min; paired median change in absolute error 0.0 min (n=4, negative = the correction lands closer).

##### since death 4-6h

n: 144 records, 16 window lifecycles, 9 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 16 | 100.0% | 16 | 0 | 2 | 5 | 8 | 1 | 0.286 | 0.667 | 0.400 | -2406.5 | 2140.4 | 0.212 |
| scenario-equal | 16 | 100.0% | 16 | 0 | 3 | 4 | 9 | 0 | 0.429 | 1.000 | 0.600 | -1916.7 | 1916.7 | 0.190 |
| scenario-equal-original | 16 | 100.0% | 16 | 0 | 3 | 4 | 9 | 0 | 0.429 | 1.000 | 0.600 | -1916.7 | 1916.7 | 0.190 |
| scenario-headroom | 16 | 100.0% | 16 | 0 | 3 | 4 | 9 | 0 | 0.429 | 1.000 | 0.600 | -986.9 | 986.9 | 0.098 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 16 | 0 | 0 | 0 | 0 | 16 |
| scenario-equal | 16 | 0 | 0 | 0 | 0 | 16 |
| scenario-equal-original | 16 | 0 | 0 | 0 | 0 | 16 |
| scenario-headroom | 16 | 0 | 0 | 0 | 0 | 16 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 2 |
| current | 12h-48h | 0 | 1 | 0.000 | — | 2 |
| current | >48h | 2 | 0 | 1.000 | -2406.5 | 1 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-equal | 12h-48h | 1 | 0 | 1.000 | -1108.1 | 3 |
| scenario-equal | >48h | 2 | 0 | 1.000 | -2037.8 | 0 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-equal-original | 12h-48h | 1 | 0 | 1.000 | -1108.1 | 3 |
| scenario-equal-original | >48h | 2 | 0 | 1.000 | -2037.8 | 0 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-headroom | 12h-48h | 1 | 0 | 1.000 | -1108.1 | 2 |
| scenario-headroom | >48h | 2 | 0 | 1.000 | -986.9 | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 144 | 100.0% | 144 | 0 | 27 | 47 | 69 | 1 | 0.365 | 0.964 | 0.529 | -2265.4 | 2265.4 | 0.225 |
| scenario-equal | 144 | 100.0% | 144 | 0 | 28 | 42 | 74 | 0 | 0.400 | 1.000 | 0.571 | -1975.7 | 1955.9 | 0.194 |
| scenario-equal-original | 144 | 100.0% | 144 | 0 | 28 | 42 | 74 | 0 | 0.400 | 1.000 | 0.571 | -1975.7 | 1955.9 | 0.194 |
| scenario-headroom | 144 | 100.0% | 144 | 0 | 28 | 42 | 74 | 0 | 0.400 | 1.000 | 0.571 | -537.6 | 688.5 | 0.068 |

Paired median signed error (n=2; positive = optimistic): scenario-equal -2037.8 min, current -2406.5 min.

Against the pre-correction scan (n=3): scenario-equal -1916.7 min, scenario-equal-original -1916.7 min; paired median change in absolute error 0.0 min (n=3, negative = the correction lands closer).

##### since death 6-12h

n: 328 records, 18 window lifecycles, 12 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 18 | 100.0% | 18 | 0 | 1 | 4 | 12 | 1 | 0.200 | 0.500 | 0.286 | -369.8 | 369.8 | 0.037 |
| scenario-equal | 18 | 100.0% | 18 | 0 | 2 | 4 | 12 | 0 | 0.333 | 1.000 | 0.500 | -688.4 | 289.3 | 0.029 |
| scenario-equal-original | 18 | 100.0% | 18 | 0 | 2 | 4 | 12 | 0 | 0.333 | 1.000 | 0.500 | -688.4 | 289.3 | 0.029 |
| scenario-headroom | 18 | 100.0% | 18 | 0 | 1 | 4 | 12 | 1 | 0.200 | 0.500 | 0.286 | -325.4 | 325.4 | 0.032 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-equal | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-equal-original | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-headroom | 18 | 0 | 0 | 0 | 0 | 18 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 1 | 1 | 0.500 | -369.8 | 3 |
| current | >48h | 0 | 0 | — | — | 1 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 2 | 0 | 1.000 | -688.4 | 3 |
| scenario-equal | >48h | 0 | 0 | — | — | 1 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 2 | 0 | 1.000 | -688.4 | 3 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 1 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 1 | 1 | 0.500 | -325.4 | 2 |
| scenario-headroom | >48h | 0 | 0 | — | — | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 328 | 100.0% | 328 | 0 | 42 | 128 | 153 | 5 | 0.247 | 0.894 | 0.387 | -369.8 | 357.7 | 0.035 |
| scenario-equal | 328 | 100.0% | 328 | 0 | 47 | 124 | 157 | 0 | 0.275 | 1.000 | 0.431 | -665.0 | 665.0 | 0.066 |
| scenario-equal-original | 328 | 100.0% | 328 | 0 | 47 | 124 | 157 | 0 | 0.275 | 1.000 | 0.431 | -665.0 | 665.0 | 0.066 |
| scenario-headroom | 328 | 100.0% | 328 | 0 | 42 | 124 | 157 | 5 | 0.253 | 0.894 | 0.394 | -337.9 | 325.4 | 0.032 |

Paired median signed error (n=1; positive = optimistic): scenario-equal -688.4 min, current -369.8 min.

Against the pre-correction scan (n=2): scenario-equal -688.4 min, scenario-equal-original -688.4 min; paired median change in absolute error 0.0 min (n=2, negative = the correction lands closer).

##### since death 12-24h

n: 512 records, 24 window lifecycles, 11 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 24 | 100.0% | 24 | 0 | 2 | 5 | 16 | 1 | 0.286 | 0.667 | 0.400 | 109.2 | 109.2 | 0.011 |
| scenario-equal | 24 | 100.0% | 24 | 0 | 3 | 5 | 16 | 0 | 0.375 | 1.000 | 0.545 | 27.5 | 82.2 | 0.008 |
| scenario-equal-original | 24 | 100.0% | 24 | 0 | 3 | 5 | 16 | 0 | 0.375 | 1.000 | 0.545 | 27.5 | 82.2 | 0.008 |
| scenario-headroom | 24 | 100.0% | 24 | 0 | 2 | 5 | 16 | 1 | 0.286 | 0.667 | 0.400 | 464.2 | 464.2 | 0.046 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 24 | 0 | 0 | 0 | 0 | 24 |
| scenario-equal | 24 | 0 | 0 | 0 | 0 | 24 |
| scenario-equal-original | 24 | 0 | 0 | 0 | 0 | 24 |
| scenario-headroom | 24 | 0 | 0 | 0 | 0 | 24 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 1 |
| current | 2h-12h | 2 | 0 | 1.000 | 109.2 | 0 |
| current | 12h-48h | 0 | 1 | 0.000 | — | 3 |
| current | >48h | 0 | 0 | — | — | 1 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-equal | 2h-12h | 2 | 0 | 1.000 | -82.2 | 1 |
| scenario-equal | 12h-48h | 1 | 0 | 1.000 | 27.5 | 2 |
| scenario-equal | >48h | 0 | 0 | — | — | 1 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-equal-original | 2h-12h | 2 | 0 | 1.000 | -82.2 | 1 |
| scenario-equal-original | 12h-48h | 1 | 0 | 1.000 | 27.5 | 2 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 1 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-headroom | 2h-12h | 2 | 0 | 1.000 | 464.2 | 1 |
| scenario-headroom | 12h-48h | 0 | 1 | 0.000 | — | 1 |
| scenario-headroom | >48h | 0 | 0 | — | — | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 512 | 100.0% | 512 | 0 | 38 | 152 | 262 | 60 | 0.200 | 0.388 | 0.264 | -33.5 | 151.3 | 0.015 |
| scenario-equal | 512 | 100.0% | 512 | 0 | 98 | 152 | 262 | 0 | 0.392 | 1.000 | 0.563 | -97.7 | 125.3 | 0.012 |
| scenario-equal-original | 512 | 100.0% | 512 | 0 | 98 | 151 | 263 | 0 | 0.394 | 1.000 | 0.565 | -97.7 | 125.3 | 0.012 |
| scenario-headroom | 512 | 100.0% | 512 | 0 | 38 | 152 | 262 | 60 | 0.200 | 0.388 | 0.264 | 425.8 | 425.8 | 0.042 |

Paired median signed error (n=2; positive = optimistic): scenario-equal -82.2 min, current 109.2 min.

Against the pre-correction scan (n=3): scenario-equal 27.5 min, scenario-equal-original 27.5 min; paired median change in absolute error 0.0 min (n=3, negative = the correction lands closer).

#### five_hour

##### since death 0-30m

n: 180 records, 58 window lifecycles, 47 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 58 | 100.0% | 58 | 0 | 2 | 7 | 42 | 7 | 0.222 | 0.222 | 0.222 | 7.8 | 7.8 | 0.026 |
| scenario-equal | 58 | 100.0% | 58 | 0 | 7 | 16 | 33 | 2 | 0.304 | 0.778 | 0.438 | 14.2 | 16.1 | 0.054 |
| scenario-equal-original | 58 | 100.0% | 58 | 0 | 7 | 16 | 33 | 2 | 0.304 | 0.778 | 0.438 | 15.7 | 15.7 | 0.052 |
| scenario-headroom | 58 | 100.0% | 58 | 0 | 5 | 14 | 35 | 4 | 0.263 | 0.556 | 0.357 | 37.6 | 37.6 | 0.125 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 58 | 0 | 0 | 0 | 0 | 58 |
| scenario-equal | 58 | 0 | 0 | 0 | 0 | 58 |
| scenario-equal-original | 58 | 0 | 0 | 0 | 0 | 58 |
| scenario-headroom | 58 | 0 | 0 | 0 | 0 | 58 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 1 | 1 | 0.500 | 7.8 | 3 |
| current | 30m-2h | 1 | 5 | 0.167 | 8.2 | 4 |
| current | 2h-12h | 0 | 1 | 0.000 | — | 0 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 2 | 0 | 1.000 | 6.0 | 4 |
| scenario-equal | 30m-2h | 4 | 2 | 0.667 | 39.9 | 6 |
| scenario-equal | 2h-12h | 1 | 0 | 1.000 | -12.5 | 6 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 2 | 0 | 1.000 | 7.6 | 4 |
| scenario-equal-original | 30m-2h | 4 | 2 | 0.667 | 41.7 | 6 |
| scenario-equal-original | 2h-12h | 1 | 0 | 1.000 | -11.1 | 6 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 2 | 0 | 1.000 | 37.6 | 2 |
| scenario-headroom | 30m-2h | 2 | 4 | 0.333 | -16.1 | 8 |
| scenario-headroom | 2h-12h | 1 | 0 | 1.000 | -12.5 | 4 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 180 | 100.0% | 180 | 0 | 4 | 34 | 125 | 17 | 0.105 | 0.190 | 0.136 | 8.2 | 8.2 | 0.027 |
| scenario-equal | 180 | 100.0% | 180 | 0 | 16 | 53 | 106 | 5 | 0.232 | 0.762 | 0.356 | 19.2 | 19.2 | 0.064 |
| scenario-equal-original | 180 | 100.0% | 180 | 0 | 16 | 53 | 106 | 5 | 0.232 | 0.762 | 0.356 | 20.1 | 20.1 | 0.067 |
| scenario-headroom | 180 | 100.0% | 180 | 0 | 10 | 49 | 110 | 11 | 0.169 | 0.476 | 0.250 | 19.2 | 19.2 | 0.064 |

Paired median signed error (n=2; positive = optimistic): scenario-equal 6.0 min, current 7.8 min.

Against the pre-correction scan (n=7): scenario-equal 14.2 min, scenario-equal-original 15.7 min; paired median change in absolute error -1.5 min (n=7, negative = the correction lands closer).

##### since death 30-60m

n: 161 records, 54 window lifecycles, 46 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 54 | 100.0% | 54 | 0 | 5 | 11 | 34 | 4 | 0.313 | 0.556 | 0.400 | 14.9 | 25.3 | 0.084 |
| scenario-equal | 54 | 100.0% | 54 | 0 | 7 | 12 | 33 | 2 | 0.368 | 0.778 | 0.500 | 6.0 | 16.0 | 0.053 |
| scenario-equal-original | 54 | 100.0% | 54 | 0 | 7 | 12 | 33 | 2 | 0.368 | 0.778 | 0.500 | 6.9 | 17.5 | 0.058 |
| scenario-headroom | 54 | 100.0% | 54 | 0 | 5 | 9 | 36 | 4 | 0.357 | 0.556 | 0.435 | 3.0 | 6.0 | 0.020 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 54 | 0 | 0 | 0 | 0 | 54 |
| scenario-equal | 54 | 0 | 0 | 0 | 0 | 54 |
| scenario-equal-original | 54 | 0 | 0 | 0 | 0 | 54 |
| scenario-headroom | 54 | 0 | 0 | 0 | 0 | 54 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 2 | 2 | 0.500 | 25.3 | 3 |
| current | 30m-2h | 3 | 2 | 0.600 | -1.3 | 6 |
| current | 2h-12h | 0 | 0 | — | — | 2 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 3 | 1 | 0.750 | 3.0 | 5 |
| scenario-equal | 30m-2h | 4 | 1 | 0.800 | 6.0 | 6 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 3 | 1 | 0.750 | 3.9 | 5 |
| scenario-equal-original | 30m-2h | 4 | 1 | 0.800 | 6.9 | 6 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 2 | 2 | 0.500 | -0.4 | 2 |
| scenario-headroom | 30m-2h | 3 | 2 | 0.600 | 6.0 | 7 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 161 | 100.0% | 161 | 0 | 14 | 35 | 102 | 10 | 0.286 | 0.583 | 0.384 | 15.7 | 16.9 | 0.056 |
| scenario-equal | 161 | 100.0% | 161 | 0 | 20 | 40 | 97 | 4 | 0.333 | 0.833 | 0.476 | 5.6 | 13.3 | 0.044 |
| scenario-equal-original | 161 | 100.0% | 161 | 0 | 20 | 40 | 97 | 4 | 0.333 | 0.833 | 0.476 | 6.5 | 14.8 | 0.049 |
| scenario-headroom | 161 | 100.0% | 161 | 0 | 14 | 35 | 102 | 10 | 0.286 | 0.583 | 0.384 | 0.1 | 8.4 | 0.028 |

Paired median signed error (n=5; positive = optimistic): scenario-equal 16.0 min, current 14.9 min.

Against the pre-correction scan (n=7): scenario-equal 6.0 min, scenario-equal-original 6.9 min; paired median change in absolute error -0.9 min (n=7, negative = the correction lands closer).

##### since death 1-2h

n: 230 records, 48 window lifecycles, 41 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 48 | 100.0% | 48 | 0 | 7 | 11 | 28 | 2 | 0.389 | 0.778 | 0.519 | 10.0 | 10.0 | 0.033 |
| scenario-equal | 48 | 100.0% | 48 | 0 | 8 | 8 | 31 | 1 | 0.500 | 0.889 | 0.640 | 13.4 | 14.1 | 0.047 |
| scenario-equal-original | 48 | 100.0% | 48 | 0 | 8 | 8 | 31 | 1 | 0.500 | 0.889 | 0.640 | 14.6 | 15.3 | 0.051 |
| scenario-headroom | 48 | 100.0% | 48 | 0 | 7 | 8 | 31 | 2 | 0.467 | 0.778 | 0.583 | 48.6 | 48.6 | 0.162 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 48 | 0 | 0 | 0 | 0 | 48 |
| scenario-equal | 48 | 0 | 0 | 0 | 0 | 48 |
| scenario-equal-original | 48 | 0 | 0 | 0 | 0 | 48 |
| scenario-headroom | 48 | 0 | 0 | 0 | 0 | 48 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 4 | 0 | 1.000 | -0.5 | 3 |
| current | 30m-2h | 3 | 2 | 0.600 | 15.8 | 7 |
| current | 2h-12h | 0 | 0 | — | — | 1 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 4 | 0 | 1.000 | 9.3 | 5 |
| scenario-equal | 30m-2h | 4 | 1 | 0.800 | 14.1 | 3 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 4 | 0 | 1.000 | 10.9 | 5 |
| scenario-equal-original | 30m-2h | 4 | 1 | 0.800 | 14.6 | 3 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 3 | 1 | 0.750 | 63.0 | 3 |
| scenario-headroom | 30m-2h | 4 | 1 | 0.800 | 27.7 | 5 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 230 | 100.0% | 230 | 0 | 26 | 55 | 140 | 9 | 0.321 | 0.743 | 0.448 | 8.2 | 9.2 | 0.031 |
| scenario-equal | 230 | 100.0% | 230 | 0 | 34 | 48 | 147 | 1 | 0.415 | 0.971 | 0.581 | 10.9 | 15.8 | 0.053 |
| scenario-equal-original | 230 | 100.0% | 230 | 0 | 34 | 48 | 147 | 1 | 0.415 | 0.971 | 0.581 | 12.4 | 15.4 | 0.051 |
| scenario-headroom | 230 | 100.0% | 230 | 0 | 33 | 36 | 159 | 2 | 0.478 | 0.943 | 0.635 | 36.4 | 36.4 | 0.121 |

Paired median signed error (n=7; positive = optimistic): scenario-equal 13.4 min, current 10.0 min.

Against the pre-correction scan (n=8): scenario-equal 13.4 min, scenario-equal-original 14.6 min; paired median change in absolute error -0.9 min (n=8, negative = the correction lands closer).

##### since death 2-3h

n: 106 records, 28 window lifecycles, 25 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 28 | 100.0% | 28 | 0 | 0 | 5 | 22 | 1 | 0.000 | 0.000 | 0.000 | — | — | — |
| scenario-equal | 28 | 100.0% | 28 | 0 | 1 | 3 | 24 | 0 | 0.250 | 1.000 | 0.400 | 0.4 | 0.4 | 0.001 |
| scenario-equal-original | 28 | 100.0% | 28 | 0 | 1 | 3 | 24 | 0 | 0.250 | 1.000 | 0.400 | 1.7 | 1.7 | 0.006 |
| scenario-headroom | 28 | 100.0% | 28 | 0 | 1 | 0 | 27 | 0 | 1.000 | 1.000 | 1.000 | 0.4 | 0.4 | 0.001 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 28 | 0 | 0 | 0 | 0 | 28 |
| scenario-equal | 28 | 0 | 0 | 0 | 0 | 28 |
| scenario-equal-original | 28 | 0 | 0 | 0 | 0 | 28 |
| scenario-headroom | 28 | 0 | 0 | 0 | 0 | 28 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 1 | 0.000 | — | 3 |
| current | 30m-2h | 0 | 0 | — | — | 2 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 1 | 0 | 1.000 | 0.4 | 2 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 1 | 0 | 1.000 | 1.7 | 2 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 1 | 0 | 1.000 | 0.4 | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 106 | 100.0% | 106 | 0 | 1 | 13 | 91 | 1 | 0.071 | 0.500 | 0.125 | -5.5 | 5.5 | 0.018 |
| scenario-equal | 106 | 100.0% | 106 | 0 | 2 | 7 | 97 | 0 | 0.222 | 1.000 | 0.364 | -6.7 | 0.4 | 0.001 |
| scenario-equal-original | 106 | 100.0% | 106 | 0 | 2 | 7 | 97 | 0 | 0.222 | 1.000 | 0.364 | -5.4 | 1.7 | 0.006 |
| scenario-headroom | 106 | 100.0% | 106 | 0 | 2 | 0 | 104 | 0 | 1.000 | 1.000 | 1.000 | -6.7 | 0.4 | 0.001 |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

Against the pre-correction scan (n=1): scenario-equal 0.4 min, scenario-equal-original 1.7 min; paired median change in absolute error -1.3 min (n=1, negative = the correction lands closer).

##### since death 3-4h

n: 46 records, 10 window lifecycles, 12 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-equal | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-equal-original | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-headroom | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal-original | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-headroom | 10 | 0 | 0 | 0 | 0 | 10 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 46 | 100.0% | 46 | 0 | 0 | 0 | 46 | 0 | — | — | — | — | — | — |
| scenario-equal | 46 | 100.0% | 46 | 0 | 0 | 0 | 46 | 0 | — | — | — | — | — | — |
| scenario-equal-original | 46 | 100.0% | 46 | 0 | 0 | 0 | 46 | 0 | — | — | — | — | — | — |
| scenario-headroom | 46 | 100.0% | 46 | 0 | 0 | 0 | 46 | 0 | — | — | — | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

Against the pre-correction scan (n=0): scenario-equal — min, scenario-equal-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### since death 4-6h

n: 76 records, 10 window lifecycles, 9 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 10 | 100.0% | 10 | 0 | 0 | 2 | 8 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 10 | 100.0% | 10 | 0 | 0 | 1 | 9 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 10 | 100.0% | 10 | 0 | 0 | 1 | 9 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 10 | 100.0% | 10 | 0 | 0 | 1 | 9 | 0 | 0.000 | — | 0.000 | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal-original | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-headroom | 10 | 0 | 0 | 0 | 0 | 10 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 2 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 76 | 100.0% | 76 | 0 | 0 | 7 | 69 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 76 | 100.0% | 76 | 0 | 0 | 2 | 74 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 76 | 100.0% | 76 | 0 | 0 | 2 | 74 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 76 | 100.0% | 76 | 0 | 0 | 2 | 74 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

Against the pre-correction scan (n=0): scenario-equal — min, scenario-equal-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### since death 6-12h

n: 162 records, 12 window lifecycles, 9 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 12 | 100.0% | 12 | 0 | 0 | 0 | 12 | 0 | — | — | — | — | — | — |
| scenario-equal | 12 | 100.0% | 12 | 0 | 0 | 0 | 12 | 0 | — | — | — | — | — | — |
| scenario-equal-original | 12 | 100.0% | 12 | 0 | 0 | 0 | 12 | 0 | — | — | — | — | — | — |
| scenario-headroom | 12 | 100.0% | 12 | 0 | 0 | 0 | 12 | 0 | — | — | — | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 12 | 0 | 0 | 0 | 0 | 12 |
| scenario-equal | 12 | 0 | 0 | 0 | 0 | 12 |
| scenario-equal-original | 12 | 0 | 0 | 0 | 0 | 12 |
| scenario-headroom | 12 | 0 | 0 | 0 | 0 | 12 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 162 | 100.0% | 162 | 0 | 0 | 9 | 153 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 162 | 100.0% | 162 | 0 | 0 | 5 | 157 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 162 | 100.0% | 162 | 0 | 0 | 5 | 157 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 162 | 100.0% | 162 | 0 | 0 | 5 | 157 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

Against the pre-correction scan (n=0): scenario-equal — min, scenario-equal-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### since death 12-24h

n: 266 records, 17 window lifecycles, 11 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 17 | 100.0% | 17 | 0 | 0 | 1 | 16 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 17 | 100.0% | 17 | 0 | 0 | 1 | 16 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 17 | 100.0% | 17 | 0 | 0 | 1 | 16 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 17 | 100.0% | 17 | 0 | 0 | 1 | 16 | 0 | 0.000 | — | 0.000 | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-equal | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-equal-original | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-headroom | 17 | 0 | 0 | 0 | 0 | 17 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 1 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 266 | 100.0% | 266 | 0 | 0 | 4 | 262 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 266 | 100.0% | 266 | 0 | 0 | 4 | 262 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 266 | 100.0% | 266 | 0 | 0 | 3 | 263 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 266 | 100.0% | 266 | 0 | 0 | 4 | 262 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

Against the pre-correction scan (n=0): scenario-equal — min, scenario-equal-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

#### seven_day

##### since death 0-30m

n: 128 records, 27 window lifecycles, 34 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 27 | 100.0% | 27 | 0 | 7 | 10 | 8 | 2 | 0.412 | 0.778 | 0.538 | -1737.3 | 1737.3 | 0.172 |
| scenario-equal | 27 | 100.0% | 27 | 0 | 8 | 10 | 8 | 1 | 0.444 | 0.889 | 0.593 | -1145.2 | 1145.2 | 0.114 |
| scenario-equal-original | 27 | 100.0% | 27 | 0 | 8 | 10 | 8 | 1 | 0.444 | 0.889 | 0.593 | -1145.2 | 1145.2 | 0.114 |
| scenario-headroom | 27 | 100.0% | 27 | 0 | 7 | 8 | 10 | 2 | 0.467 | 0.778 | 0.583 | -895.3 | 895.3 | 0.089 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 27 | 0 | 0 | 0 | 0 | 27 |
| scenario-equal | 27 | 0 | 0 | 0 | 0 | 27 |
| scenario-equal-original | 27 | 0 | 0 | 0 | 0 | 27 |
| scenario-headroom | 27 | 0 | 0 | 0 | 0 | 27 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 1 | 0 | 1.000 | 93.0 | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 1 | 0 | 1.000 | 70.9 | 2 |
| current | 12h-48h | 2 | 1 | 0.667 | -1780.6 | 4 |
| current | >48h | 3 | 1 | 0.750 | -5878.0 | 4 |
| scenario-equal | <30m | 1 | 0 | 1.000 | 119.0 | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 1 | 0 | 1.000 | 45.2 | 2 |
| scenario-equal | 12h-48h | 2 | 1 | 0.667 | -1557.0 | 4 |
| scenario-equal | >48h | 4 | 0 | 1.000 | -4291.2 | 4 |
| scenario-equal-original | <30m | 1 | 0 | 1.000 | 119.0 | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 1 | 0 | 1.000 | 44.6 | 2 |
| scenario-equal-original | 12h-48h | 2 | 1 | 0.667 | -1557.0 | 4 |
| scenario-equal-original | >48h | 4 | 0 | 1.000 | -4291.2 | 4 |
| scenario-headroom | <30m | 1 | 0 | 1.000 | 246.3 | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 1 | 0 | 1.000 | 109.9 | 0 |
| scenario-headroom | 12h-48h | 2 | 1 | 0.667 | -895.3 | 2 |
| scenario-headroom | >48h | 3 | 1 | 0.750 | -2712.3 | 6 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 128 | 100.0% | 128 | 0 | 38 | 47 | 35 | 8 | 0.447 | 0.826 | 0.580 | -983.2 | 899.9 | 0.089 |
| scenario-equal | 128 | 100.0% | 128 | 0 | 44 | 50 | 32 | 2 | 0.468 | 0.957 | 0.629 | -995.8 | 1075.2 | 0.107 |
| scenario-equal-original | 128 | 100.0% | 128 | 0 | 44 | 50 | 32 | 2 | 0.468 | 0.957 | 0.629 | -995.8 | 1075.2 | 0.107 |
| scenario-headroom | 128 | 100.0% | 128 | 0 | 41 | 42 | 40 | 5 | 0.494 | 0.891 | 0.636 | -186.4 | 614.7 | 0.061 |

Paired median signed error (n=7; positive = optimistic): scenario-equal -1145.2 min, current -1737.3 min.

Against the pre-correction scan (n=8): scenario-equal -1145.2 min, scenario-equal-original -1145.2 min; paired median change in absolute error 0.0 min (n=8, negative = the correction lands closer).

##### since death 30-60m

n: 106 records, 23 window lifecycles, 32 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 23 | 100.0% | 23 | 0 | 6 | 10 | 6 | 1 | 0.375 | 0.857 | 0.522 | -1907.7 | 1809.7 | 0.180 |
| scenario-equal | 23 | 100.0% | 23 | 0 | 7 | 9 | 7 | 0 | 0.438 | 1.000 | 0.609 | -1318.0 | 1318.0 | 0.131 |
| scenario-equal-original | 23 | 100.0% | 23 | 0 | 7 | 9 | 7 | 0 | 0.438 | 1.000 | 0.609 | -1318.0 | 1318.0 | 0.131 |
| scenario-headroom | 23 | 100.0% | 23 | 0 | 7 | 7 | 9 | 0 | 0.500 | 1.000 | 0.667 | -903.4 | 1363.1 | 0.135 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 23 | 0 | 0 | 0 | 0 | 23 |
| scenario-equal | 23 | 0 | 0 | 0 | 0 | 23 |
| scenario-equal-original | 23 | 0 | 0 | 0 | 0 | 23 |
| scenario-headroom | 23 | 0 | 0 | 0 | 0 | 23 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 1 | 0 | 1.000 | 53.9 | 0 |
| current | 2h-12h | 0 | 0 | — | — | 2 |
| current | 12h-48h | 2 | 0 | 1.000 | -1809.7 | 5 |
| current | >48h | 3 | 1 | 0.750 | -4879.7 | 3 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 1 | 0 | 1.000 | 29.6 | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 3 |
| scenario-equal | 12h-48h | 2 | 0 | 1.000 | -1573.7 | 2 |
| scenario-equal | >48h | 4 | 0 | 1.000 | -2517.9 | 4 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 1 | 0 | 1.000 | 29.6 | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 3 |
| scenario-equal-original | 12h-48h | 2 | 0 | 1.000 | -1573.7 | 2 |
| scenario-equal-original | >48h | 4 | 0 | 1.000 | -2518.8 | 4 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 1 | 0 | 1.000 | 111.5 | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-headroom | 12h-48h | 2 | 0 | 1.000 | -903.4 | 1 |
| scenario-headroom | >48h | 4 | 0 | 1.000 | -2476.3 | 5 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 106 | 100.0% | 106 | 0 | 31 | 38 | 31 | 6 | 0.449 | 0.838 | 0.585 | -2069.2 | 2069.2 | 0.205 |
| scenario-equal | 106 | 100.0% | 106 | 0 | 37 | 38 | 31 | 0 | 0.493 | 1.000 | 0.661 | -1573.7 | 1573.7 | 0.156 |
| scenario-equal-original | 106 | 100.0% | 106 | 0 | 37 | 38 | 31 | 0 | 0.493 | 1.000 | 0.661 | -1573.7 | 1573.7 | 0.156 |
| scenario-headroom | 106 | 100.0% | 106 | 0 | 36 | 36 | 33 | 1 | 0.500 | 0.973 | 0.661 | -1346.2 | 1358.7 | 0.135 |

Paired median signed error (n=6; positive = optimistic): scenario-equal -1573.7 min, current -1907.7 min.

Against the pre-correction scan (n=7): scenario-equal -1318.0 min, scenario-equal-original -1318.0 min; paired median change in absolute error 0.0 min (n=7, negative = the correction lands closer).

##### since death 1-2h

n: 173 records, 18 window lifecycles, 30 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 18 | 100.0% | 18 | 0 | 6 | 5 | 6 | 1 | 0.545 | 0.857 | 0.667 | -2561.3 | 2090.4 | 0.207 |
| scenario-equal | 18 | 100.0% | 18 | 0 | 7 | 5 | 6 | 0 | 0.583 | 1.000 | 0.737 | -2164.0 | 2164.0 | 0.215 |
| scenario-equal-original | 18 | 100.0% | 18 | 0 | 7 | 5 | 6 | 0 | 0.583 | 1.000 | 0.737 | -2164.0 | 2164.0 | 0.215 |
| scenario-headroom | 18 | 100.0% | 18 | 0 | 7 | 5 | 6 | 0 | 0.583 | 1.000 | 0.737 | -1308.6 | 1308.6 | 0.130 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-equal | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-equal-original | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-headroom | 18 | 0 | 0 | 0 | 0 | 18 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 1 | 0 | 1.000 | 27.3 | 0 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 0 | — | — | 3 |
| current | >48h | 5 | 1 | 0.833 | -2561.3 | 2 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 1 | 0 | 1.000 | 20.4 | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 4 |
| scenario-equal | >48h | 6 | 0 | 1.000 | -2243.0 | 1 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 1 | 0 | 1.000 | 20.4 | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 4 |
| scenario-equal-original | >48h | 6 | 0 | 1.000 | -2243.0 | 1 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 1 | 0 | 1.000 | 179.4 | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-headroom | >48h | 6 | 0 | 1.000 | -1398.6 | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 173 | 100.0% | 173 | 0 | 57 | 50 | 59 | 7 | 0.533 | 0.891 | 0.667 | -2545.2 | 2545.2 | 0.252 |
| scenario-equal | 173 | 100.0% | 173 | 0 | 64 | 57 | 52 | 0 | 0.529 | 1.000 | 0.692 | -2243.0 | 2210.0 | 0.219 |
| scenario-equal-original | 173 | 100.0% | 173 | 0 | 64 | 57 | 52 | 0 | 0.529 | 1.000 | 0.692 | -2243.0 | 2210.0 | 0.219 |
| scenario-headroom | 173 | 100.0% | 173 | 0 | 64 | 57 | 52 | 0 | 0.529 | 1.000 | 0.692 | -1308.6 | 1308.6 | 0.130 |

Paired median signed error (n=6; positive = optimistic): scenario-equal -2243.0 min, current -2561.3 min.

Against the pre-correction scan (n=7): scenario-equal -2164.0 min, scenario-equal-original -2164.0 min; paired median change in absolute error 0.0 min (n=7, negative = the correction lands closer).

##### since death 2-3h

n: 92 records, 14 window lifecycles, 24 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 14 | 100.0% | 14 | 0 | 4 | 4 | 5 | 1 | 0.500 | 0.800 | 0.615 | -5736.9 | 2538.2 | 0.252 |
| scenario-equal | 14 | 100.0% | 14 | 0 | 5 | 5 | 4 | 0 | 0.500 | 1.000 | 0.667 | -2187.0 | 2187.0 | 0.217 |
| scenario-equal-original | 14 | 100.0% | 14 | 0 | 5 | 5 | 4 | 0 | 0.500 | 1.000 | 0.667 | -2187.0 | 2187.0 | 0.217 |
| scenario-headroom | 14 | 100.0% | 14 | 0 | 5 | 5 | 4 | 0 | 0.500 | 1.000 | 0.667 | -1233.4 | 1233.4 | 0.122 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 14 | 0 | 0 | 0 | 0 | 14 |
| scenario-equal | 14 | 0 | 0 | 0 | 0 | 14 |
| scenario-equal-original | 14 | 0 | 0 | 0 | 0 | 14 |
| scenario-headroom | 14 | 0 | 0 | 0 | 0 | 14 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 1 | 0.000 | — | 2 |
| current | >48h | 4 | 0 | 1.000 | -5736.9 | 2 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 1 | 0 | 1.000 | -1233.4 | 4 |
| scenario-equal | >48h | 4 | 0 | 1.000 | -3459.4 | 1 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 1 | 0 | 1.000 | -1233.4 | 4 |
| scenario-equal-original | >48h | 4 | 0 | 1.000 | -3459.4 | 1 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 1 | 0 | 1.000 | -1233.4 | 3 |
| scenario-headroom | >48h | 4 | 0 | 1.000 | -3401.4 | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 92 | 100.0% | 92 | 0 | 31 | 32 | 23 | 6 | 0.492 | 0.838 | 0.620 | -5611.4 | 5611.4 | 0.557 |
| scenario-equal | 92 | 100.0% | 92 | 0 | 37 | 38 | 17 | 0 | 0.493 | 1.000 | 0.661 | -2188.3 | 2188.3 | 0.217 |
| scenario-equal-original | 92 | 100.0% | 92 | 0 | 37 | 38 | 17 | 0 | 0.493 | 1.000 | 0.661 | -2188.3 | 2188.3 | 0.217 |
| scenario-headroom | 92 | 100.0% | 92 | 0 | 37 | 38 | 17 | 0 | 0.493 | 1.000 | 0.661 | -1258.5 | 1258.5 | 0.125 |

Paired median signed error (n=4; positive = optimistic): scenario-equal -3459.4 min, current -5736.9 min.

Against the pre-correction scan (n=5): scenario-equal -2187.0 min, scenario-equal-original -2187.0 min; paired median change in absolute error 0.0 min (n=5, negative = the correction lands closer).

##### since death 3-4h

n: 39 records, 7 window lifecycles, 15 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 7 | 100.0% | 7 | 0 | 3 | 3 | 0 | 1 | 0.500 | 0.750 | 0.600 | -5594.0 | 5594.0 | 0.555 |
| scenario-equal | 7 | 100.0% | 7 | 0 | 4 | 3 | 0 | 0 | 0.571 | 1.000 | 0.727 | -3811.0 | 2164.9 | 0.215 |
| scenario-equal-original | 7 | 100.0% | 7 | 0 | 4 | 3 | 0 | 0 | 0.571 | 1.000 | 0.727 | -3811.0 | 2164.9 | 0.215 |
| scenario-headroom | 7 | 100.0% | 7 | 0 | 4 | 3 | 0 | 0 | 0.571 | 1.000 | 0.727 | -3784.8 | 1158.2 | 0.115 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-equal | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-equal-original | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-headroom | 7 | 0 | 0 | 0 | 0 | 7 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 1 | 0.000 | — | 0 |
| current | >48h | 3 | 0 | 1.000 | -5594.0 | 3 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 1 | 0 | 1.000 | -1158.2 | 3 |
| scenario-equal | >48h | 3 | 0 | 1.000 | -3811.0 | 0 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 1 | 0 | 1.000 | -1158.2 | 3 |
| scenario-equal-original | >48h | 3 | 0 | 1.000 | -3811.0 | 0 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 1 | 0 | 1.000 | -1158.2 | 2 |
| scenario-headroom | >48h | 3 | 0 | 1.000 | -3784.8 | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 39 | 100.0% | 39 | 0 | 12 | 20 | 1 | 6 | 0.375 | 0.667 | 0.480 | -5594.0 | 2531.6 | 0.251 |
| scenario-equal | 39 | 100.0% | 39 | 0 | 18 | 21 | 0 | 0 | 0.462 | 1.000 | 0.632 | -2164.9 | 2164.1 | 0.215 |
| scenario-equal-original | 39 | 100.0% | 39 | 0 | 18 | 21 | 0 | 0 | 0.462 | 1.000 | 0.632 | -2164.9 | 2164.1 | 0.215 |
| scenario-headroom | 39 | 100.0% | 39 | 0 | 18 | 21 | 0 | 0 | 0.462 | 1.000 | 0.632 | -1158.2 | 1145.7 | 0.114 |

Paired median signed error (n=3; positive = optimistic): scenario-equal -3811.0 min, current -5594.0 min.

Against the pre-correction scan (n=4): scenario-equal -3811.0 min, scenario-equal-original -3811.0 min; paired median change in absolute error 0.0 min (n=4, negative = the correction lands closer).

##### since death 4-6h

n: 68 records, 6 window lifecycles, 9 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 6 | 100.0% | 6 | 0 | 2 | 3 | 0 | 1 | 0.400 | 0.667 | 0.500 | -2406.5 | 2140.4 | 0.212 |
| scenario-equal | 6 | 100.0% | 6 | 0 | 3 | 3 | 0 | 0 | 0.500 | 1.000 | 0.667 | -1916.7 | 1916.7 | 0.190 |
| scenario-equal-original | 6 | 100.0% | 6 | 0 | 3 | 3 | 0 | 0 | 0.500 | 1.000 | 0.667 | -1916.7 | 1916.7 | 0.190 |
| scenario-headroom | 6 | 100.0% | 6 | 0 | 3 | 3 | 0 | 0 | 0.500 | 1.000 | 0.667 | -986.9 | 986.9 | 0.098 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-equal | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-equal-original | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-headroom | 6 | 0 | 0 | 0 | 0 | 6 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 1 | 0.000 | — | 2 |
| current | >48h | 2 | 0 | 1.000 | -2406.5 | 1 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 1 | 0 | 1.000 | -1108.1 | 3 |
| scenario-equal | >48h | 2 | 0 | 1.000 | -2037.8 | 0 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 1 | 0 | 1.000 | -1108.1 | 3 |
| scenario-equal-original | >48h | 2 | 0 | 1.000 | -2037.8 | 0 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 1 | 0 | 1.000 | -1108.1 | 2 |
| scenario-headroom | >48h | 2 | 0 | 1.000 | -986.9 | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 68 | 100.0% | 68 | 0 | 27 | 40 | 0 | 1 | 0.403 | 0.964 | 0.568 | -2265.4 | 2265.4 | 0.225 |
| scenario-equal | 68 | 100.0% | 68 | 0 | 28 | 40 | 0 | 0 | 0.412 | 1.000 | 0.583 | -1975.7 | 1955.9 | 0.194 |
| scenario-equal-original | 68 | 100.0% | 68 | 0 | 28 | 40 | 0 | 0 | 0.412 | 1.000 | 0.583 | -1975.7 | 1955.9 | 0.194 |
| scenario-headroom | 68 | 100.0% | 68 | 0 | 28 | 40 | 0 | 0 | 0.412 | 1.000 | 0.583 | -537.6 | 688.5 | 0.068 |

Paired median signed error (n=2; positive = optimistic): scenario-equal -2037.8 min, current -2406.5 min.

Against the pre-correction scan (n=3): scenario-equal -1916.7 min, scenario-equal-original -1916.7 min; paired median change in absolute error 0.0 min (n=3, negative = the correction lands closer).

##### since death 6-12h

n: 166 records, 6 window lifecycles, 12 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 6 | 100.0% | 6 | 0 | 1 | 4 | 0 | 1 | 0.200 | 0.500 | 0.286 | -369.8 | 369.8 | 0.037 |
| scenario-equal | 6 | 100.0% | 6 | 0 | 2 | 4 | 0 | 0 | 0.333 | 1.000 | 0.500 | -688.4 | 289.3 | 0.029 |
| scenario-equal-original | 6 | 100.0% | 6 | 0 | 2 | 4 | 0 | 0 | 0.333 | 1.000 | 0.500 | -688.4 | 289.3 | 0.029 |
| scenario-headroom | 6 | 100.0% | 6 | 0 | 1 | 4 | 0 | 1 | 0.200 | 0.500 | 0.286 | -325.4 | 325.4 | 0.032 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-equal | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-equal-original | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-headroom | 6 | 0 | 0 | 0 | 0 | 6 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 1 | 1 | 0.500 | -369.8 | 3 |
| current | >48h | 0 | 0 | — | — | 1 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 2 | 0 | 1.000 | -688.4 | 3 |
| scenario-equal | >48h | 0 | 0 | — | — | 1 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 2 | 0 | 1.000 | -688.4 | 3 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 1 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 1 | 1 | 0.500 | -325.4 | 2 |
| scenario-headroom | >48h | 0 | 0 | — | — | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 166 | 100.0% | 166 | 0 | 42 | 119 | 0 | 5 | 0.261 | 0.894 | 0.404 | -369.8 | 357.7 | 0.035 |
| scenario-equal | 166 | 100.0% | 166 | 0 | 47 | 119 | 0 | 0 | 0.283 | 1.000 | 0.441 | -665.0 | 665.0 | 0.066 |
| scenario-equal-original | 166 | 100.0% | 166 | 0 | 47 | 119 | 0 | 0 | 0.283 | 1.000 | 0.441 | -665.0 | 665.0 | 0.066 |
| scenario-headroom | 166 | 100.0% | 166 | 0 | 42 | 119 | 0 | 5 | 0.261 | 0.894 | 0.404 | -337.9 | 325.4 | 0.032 |

Paired median signed error (n=1; positive = optimistic): scenario-equal -688.4 min, current -369.8 min.

Against the pre-correction scan (n=2): scenario-equal -688.4 min, scenario-equal-original -688.4 min; paired median change in absolute error 0.0 min (n=2, negative = the correction lands closer).

##### since death 12-24h

n: 246 records, 7 window lifecycles, 11 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 7 | 100.0% | 7 | 0 | 2 | 4 | 0 | 1 | 0.333 | 0.667 | 0.444 | 109.2 | 109.2 | 0.011 |
| scenario-equal | 7 | 100.0% | 7 | 0 | 3 | 4 | 0 | 0 | 0.429 | 1.000 | 0.600 | 27.5 | 82.2 | 0.008 |
| scenario-equal-original | 7 | 100.0% | 7 | 0 | 3 | 4 | 0 | 0 | 0.429 | 1.000 | 0.600 | 27.5 | 82.2 | 0.008 |
| scenario-headroom | 7 | 100.0% | 7 | 0 | 2 | 4 | 0 | 1 | 0.333 | 0.667 | 0.444 | 464.2 | 464.2 | 0.046 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-equal | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-equal-original | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-headroom | 7 | 0 | 0 | 0 | 0 | 7 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 2 | 0 | 1.000 | 109.2 | 0 |
| current | 12h-48h | 0 | 1 | 0.000 | — | 3 |
| current | >48h | 0 | 0 | — | — | 1 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 2 | 0 | 1.000 | -82.2 | 1 |
| scenario-equal | 12h-48h | 1 | 0 | 1.000 | 27.5 | 2 |
| scenario-equal | >48h | 0 | 0 | — | — | 1 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 2 | 0 | 1.000 | -82.2 | 1 |
| scenario-equal-original | 12h-48h | 1 | 0 | 1.000 | 27.5 | 2 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 1 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 2 | 0 | 1.000 | 464.2 | 1 |
| scenario-headroom | 12h-48h | 0 | 1 | 0.000 | — | 1 |
| scenario-headroom | >48h | 0 | 0 | — | — | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 246 | 100.0% | 246 | 0 | 38 | 148 | 0 | 60 | 0.204 | 0.388 | 0.268 | -33.5 | 151.3 | 0.015 |
| scenario-equal | 246 | 100.0% | 246 | 0 | 98 | 148 | 0 | 0 | 0.398 | 1.000 | 0.570 | -97.7 | 125.3 | 0.012 |
| scenario-equal-original | 246 | 100.0% | 246 | 0 | 98 | 148 | 0 | 0 | 0.398 | 1.000 | 0.570 | -97.7 | 125.3 | 0.012 |
| scenario-headroom | 246 | 100.0% | 246 | 0 | 38 | 148 | 0 | 60 | 0.204 | 0.388 | 0.268 | 425.8 | 425.8 | 0.042 |

Paired median signed error (n=2; positive = optimistic): scenario-equal -82.2 min, current 109.2 min.

Against the pre-correction scan (n=3): scenario-equal 27.5 min, scenario-equal-original 27.5 min; paired median change in absolute error 0.0 min (n=3, negative = the correction lands closer).

### Survivor slope trajectory after a death

The survivor's OWN fitted burn slope, expressed against its slope just after the peer died: `slope(t) / slope(t_death+)`. A ratio above 1 is consistent with the inherited traffic having entered the survivor's lookback, which is the demand the scenario would then be adding a second time; a ratio near 1 is consistent with it not having arrived. The table cannot separate absorbed traffic from any other change in the survivor's own burn, and it cannot see absorption at all where the survivor was still learning when its peer died.

Median within a (window lifecycle × death) first, then across them, so a lifecycle that happens to be sampled more often does not outvote one that is not. `t_death+` is the earliest instant at or after the death that has a fitted slope at all, not the literal first instant: a survivor is often still learning when its peer dies, and requiring a slope there would discard the lifecycles this table is about. Instants with no slope enter no bucket, and a lifecycle whose baseline slope is zero is dropped rather than imputed.

Unlike the scored buckets above, this table reads the peer-exhaustion records that survive the replay's label-horizon filtering, not only the ones where every model is comparable and the window's fate was observed. The slope belongs to the survivor's own reading, so a model abstaining or an unobserved outcome is no reason to move the baseline off the earliest post-death reading there is.

| since death | lifecycles | median ratio | median slope (pct/h) | five_hour n | five_hour ratio | seven_day n | seven_day ratio |
|---|---:|---:|---:|---:|---:|---:|---:|
| 0-30m | 130 | 1.000 | 1.84 | 70 | 1.002 | 60 | 0.999 |
| 30-60m | 112 | 1.003 | 1.94 | 59 | 1.092 | 53 | 0.997 |
| 1-2h | 90 | 0.990 | 1.92 | 46 | 0.945 | 44 | 0.992 |
| 2-3h | 56 | 0.971 | 1.96 | 27 | 0.716 | 29 | 0.987 |
| 3-4h | 26 | 0.957 | 1.43 | 12 | 0.328 | 14 | 0.973 |
| 4-6h | 20 | 0.919 | 1.32 | 9 | 0.127 | 11 | 0.957 |
| 6-12h | 17 | 0.903 | 1.24 | 5 | 0.462 | 12 | 0.910 |
| 12-24h | 14 | 0.868 | 0.91 | 6 | 0.367 | 8 | 0.895 |

### By class and window

#### anthropic/five_hour

n: 10515 records, 548 window lifecycles, 52 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 548 | 100.0% | 548 | 0 | 22 | 46 | 467 | 13 | 0.324 | 0.629 | 0.427 | -0.4 | 13.1 | 0.044 |
| scenario-equal | 548 | 100.0% | 548 | 0 | 21 | 24 | 489 | 14 | 0.467 | 0.600 | 0.525 | 15.5 | 19.8 | 0.066 |
| scenario-equal-original | 548 | 100.0% | 548 | 0 | 21 | 24 | 489 | 14 | 0.467 | 0.600 | 0.525 | 15.6 | 23.7 | 0.079 |
| scenario-headroom | 548 | 100.0% | 548 | 0 | 13 | 10 | 503 | 22 | 0.565 | 0.371 | 0.448 | 51.5 | 51.5 | 0.172 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 548 | 0 | 0 | 0 | 0 | 548 |
| scenario-equal | 548 | 0 | 0 | 0 | 0 | 548 |
| scenario-equal-original | 548 | 0 | 0 | 0 | 0 | 548 |
| scenario-headroom | 548 | 0 | 0 | 0 | 0 | 548 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 3 | 1 | 0.750 | -3.6 | 11 |
| current | 30m-2h | 19 | 12 | 0.613 | 0.4 | 34 |
| current | 2h-12h | 0 | 0 | — | — | 1 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 4 | 0 | 1.000 | 0.1 | 7 |
| scenario-equal | 30m-2h | 17 | 14 | 0.548 | 19.1 | 17 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 4 | 0 | 1.000 | 1.0 | 7 |
| scenario-equal-original | 30m-2h | 17 | 14 | 0.548 | 21.0 | 17 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 4 | 0 | 1.000 | 63.0 | 1 |
| scenario-headroom | 30m-2h | 9 | 22 | 0.290 | 51.5 | 9 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 10515 | 100.0% | 10515 | 0 | 236 | 928 | 9215 | 136 | 0.203 | 0.634 | 0.307 | 0.2 | 15.6 | 0.052 |
| scenario-equal | 10515 | 100.0% | 10515 | 0 | 202 | 452 | 9691 | 170 | 0.309 | 0.543 | 0.394 | 14.3 | 20.7 | 0.069 |
| scenario-equal-original | 10515 | 100.0% | 10515 | 0 | 200 | 446 | 9697 | 172 | 0.310 | 0.538 | 0.393 | 15.4 | 21.6 | 0.072 |
| scenario-headroom | 10515 | 100.0% | 10515 | 0 | 122 | 268 | 9875 | 250 | 0.313 | 0.328 | 0.320 | 57.1 | 57.1 | 0.190 |

Paired median signed error (n=17; positive = optimistic): scenario-equal 15.5 min, current -3.6 min.

Against the pre-correction scan (n=21): scenario-equal 15.5 min, scenario-equal-original 15.6 min; paired median change in absolute error -0.9 min (n=21, negative = the correction lands closer).

#### anthropic/seven_day

n: 9472 records, 38 window lifecycles, 38 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 38 | 100.0% | 38 | 0 | 7 | 18 | 11 | 2 | 0.280 | 0.778 | 0.412 | -2031.1 | 2031.1 | 0.202 |
| scenario-equal | 38 | 100.0% | 38 | 0 | 8 | 17 | 12 | 1 | 0.320 | 0.889 | 0.471 | -1835.7 | 1417.9 | 0.141 |
| scenario-equal-original | 38 | 100.0% | 38 | 0 | 8 | 17 | 12 | 1 | 0.320 | 0.889 | 0.471 | -1835.7 | 1417.9 | 0.141 |
| scenario-headroom | 38 | 100.0% | 38 | 0 | 7 | 16 | 13 | 2 | 0.304 | 0.778 | 0.438 | -954.1 | 954.1 | 0.095 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 38 | 0 | 0 | 0 | 0 | 38 |
| scenario-equal | 38 | 0 | 0 | 0 | 0 | 38 |
| scenario-equal-original | 38 | 0 | 0 | 0 | 0 | 38 |
| scenario-headroom | 38 | 0 | 0 | 0 | 0 | 38 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 2 |
| current | 12h-48h | 1 | 2 | 0.333 | -517.7 | 12 |
| current | >48h | 6 | 0 | 1.000 | -2515.9 | 4 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 2 | 1 | 0.667 | -954.1 | 16 |
| scenario-equal | >48h | 6 | 0 | 1.000 | -2196.3 | 1 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 2 | 1 | 0.667 | -954.1 | 16 |
| scenario-equal-original | >48h | 6 | 0 | 1.000 | -2196.3 | 1 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 1 | 2 | 0.333 | -954.1 | 11 |
| scenario-headroom | >48h | 6 | 0 | 1.000 | -1360.3 | 5 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 9472 | 100.0% | 9472 | 0 | 2159 | 4774 | 2149 | 390 | 0.311 | 0.847 | 0.455 | -1055.5 | 1309.6 | 0.130 |
| scenario-equal | 9472 | 100.0% | 9472 | 0 | 2351 | 5114 | 1809 | 198 | 0.315 | 0.922 | 0.470 | -941.6 | 1071.5 | 0.106 |
| scenario-equal-original | 9472 | 100.0% | 9472 | 0 | 2351 | 5113 | 1810 | 198 | 0.315 | 0.922 | 0.470 | -941.6 | 1071.5 | 0.106 |
| scenario-headroom | 9472 | 100.0% | 9472 | 0 | 2025 | 3938 | 2985 | 524 | 0.340 | 0.794 | 0.476 | -525.0 | 911.1 | 0.090 |

Paired median signed error (n=7; positive = optimistic): scenario-equal -1835.7 min, current -2031.1 min.

Against the pre-correction scan (n=8): scenario-equal -1835.7 min, scenario-equal-original -1835.7 min; paired median change in absolute error 0.0 min (n=8, negative = the correction lands closer).

#### codex/five_hour

n: 217 records, 13 window lifecycles, 2 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 13 | 100.0% | 13 | 0 | 1 | 1 | 11 | 0 | 0.500 | 1.000 | 0.667 | 35.6 | 35.6 | 0.119 |
| scenario-equal | 13 | 100.0% | 13 | 0 | 1 | 1 | 11 | 0 | 0.500 | 1.000 | 0.667 | 35.6 | 35.6 | 0.119 |
| scenario-equal-original | 13 | 100.0% | 13 | 0 | 1 | 1 | 11 | 0 | 0.500 | 1.000 | 0.667 | 36.9 | 36.9 | 0.123 |
| scenario-headroom | 13 | 100.0% | 13 | 0 | 1 | 0 | 12 | 0 | 1.000 | 1.000 | 1.000 | 35.6 | 35.6 | 0.119 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 13 | 0 | 0 | 0 | 0 | 13 |
| scenario-equal | 13 | 0 | 0 | 0 | 0 | 13 |
| scenario-equal-original | 13 | 0 | 0 | 0 | 0 | 13 |
| scenario-headroom | 13 | 0 | 0 | 0 | 0 | 13 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 1 | 0 | 1.000 | 35.6 | 1 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 1 | 0 | 1.000 | 35.6 | 1 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 1 | 0 | 1.000 | 36.9 | 1 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 1 | 0 | 1.000 | 35.6 | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 217 | 100.0% | 217 | 0 | 18 | 33 | 166 | 0 | 0.353 | 1.000 | 0.522 | -0.9 | 15.0 | 0.050 |
| scenario-equal | 217 | 100.0% | 217 | 0 | 18 | 26 | 173 | 0 | 0.409 | 1.000 | 0.581 | -0.9 | 15.0 | 0.050 |
| scenario-equal-original | 217 | 100.0% | 217 | 0 | 18 | 25 | 174 | 0 | 0.419 | 1.000 | 0.590 | 1.4 | 15.4 | 0.051 |
| scenario-headroom | 217 | 100.0% | 217 | 0 | 18 | 5 | 194 | 0 | 0.783 | 1.000 | 0.878 | -0.9 | 15.0 | 0.050 |

Paired median signed error (n=1; positive = optimistic): scenario-equal 35.6 min, current 35.6 min.

Against the pre-correction scan (n=1): scenario-equal 35.6 min, scenario-equal-original 36.9 min; paired median change in absolute error -1.3 min (n=1, negative = the correction lands closer).

#### codex/seven_day

n: 4996 records, 20 window lifecycles, 2 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 20 | 100.0% | 20 | 0 | 2 | 12 | 6 | 0 | 0.143 | 1.000 | 0.250 | 758.8 | 758.8 | 0.075 |
| scenario-equal | 20 | 100.0% | 20 | 0 | 2 | 12 | 6 | 0 | 0.143 | 1.000 | 0.250 | 758.8 | 758.8 | 0.075 |
| scenario-equal-original | 20 | 100.0% | 20 | 0 | 2 | 12 | 6 | 0 | 0.143 | 1.000 | 0.250 | 758.8 | 758.8 | 0.075 |
| scenario-headroom | 20 | 100.0% | 20 | 0 | 2 | 12 | 6 | 0 | 0.143 | 1.000 | 0.250 | 758.8 | 758.8 | 0.075 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 20 | 0 | 0 | 0 | 0 | 20 |
| scenario-equal | 20 | 0 | 0 | 0 | 0 | 20 |
| scenario-equal-original | 20 | 0 | 0 | 0 | 0 | 20 |
| scenario-headroom | 20 | 0 | 0 | 0 | 0 | 20 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 2 | 0 | 1.000 | 758.8 | 7 |
| current | >48h | 0 | 0 | — | — | 5 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 2 | 0 | 1.000 | 758.8 | 7 |
| scenario-equal | >48h | 0 | 0 | — | — | 5 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 2 | 0 | 1.000 | 758.8 | 7 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 5 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 2 | 0 | 1.000 | 758.8 | 7 |
| scenario-headroom | >48h | 0 | 0 | — | — | 5 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 4996 | 100.0% | 4996 | 0 | 579 | 1991 | 2258 | 168 | 0.225 | 0.775 | 0.349 | 1340.0 | 1340.0 | 0.133 |
| scenario-equal | 4996 | 100.0% | 4996 | 0 | 579 | 1990 | 2259 | 168 | 0.225 | 0.775 | 0.349 | 1340.0 | 1340.0 | 0.133 |
| scenario-equal-original | 4996 | 100.0% | 4996 | 0 | 579 | 1990 | 2259 | 168 | 0.225 | 0.775 | 0.349 | 1340.0 | 1340.0 | 0.133 |
| scenario-headroom | 4996 | 100.0% | 4996 | 0 | 579 | 1990 | 2259 | 168 | 0.225 | 0.775 | 0.349 | 1340.0 | 1340.0 | 0.133 |

Paired median signed error (n=2; positive = optimistic): scenario-equal 758.8 min, current 758.8 min.

Against the pre-correction scan (n=2): scenario-equal 758.8 min, scenario-equal-original 758.8 min; paired median change in absolute error 0.0 min (n=2, negative = the correction lands closer).

### Scenario-only cohort (instants the current model withholds)

n: 17095 records, 619 window lifecycles, 45 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 619 | 0.0% | 0 | 0 | 0 | 0 | 0 | 0 | — | — | — | — | — | — |
| scenario-equal | 619 | 100.0% | 619 | 0 | 13 | 30 | 555 | 21 | 0.302 | 0.382 | 0.338 | -1033.0 | 1033.0 | 0.199 |
| scenario-equal-original | 619 | 100.0% | 619 | 0 | 13 | 30 | 555 | 21 | 0.302 | 0.382 | 0.338 | -1033.0 | 1033.0 | 0.199 |
| scenario-headroom | 619 | 100.0% | 619 | 0 | 11 | 26 | 559 | 23 | 0.297 | 0.324 | 0.310 | -1033.0 | 1033.0 | 0.152 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 0 | 0 | 619 | 0 | 0 | 619 |
| scenario-equal | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-equal-original | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-headroom | 619 | 0 | 0 | 0 | 0 | 619 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 3 | 6 | 0.333 | 77.3 | 2 |
| scenario-equal | 2h-12h | 2 | 14 | 0.125 | -35.3 | 14 |
| scenario-equal | 12h-48h | 5 | 1 | 0.833 | -1819.1 | 12 |
| scenario-equal | >48h | 3 | 0 | 1.000 | -2004.0 | 2 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 3 | 6 | 0.333 | 79.8 | 2 |
| scenario-equal-original | 2h-12h | 2 | 14 | 0.125 | -33.5 | 14 |
| scenario-equal-original | 12h-48h | 5 | 1 | 0.833 | -1819.1 | 12 |
| scenario-equal-original | >48h | 3 | 0 | 1.000 | -2004.0 | 2 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 2 | 7 | 0.222 | -21.0 | 2 |
| scenario-headroom | 2h-12h | 1 | 15 | 0.063 | -30.2 | 12 |
| scenario-headroom | 12h-48h | 5 | 1 | 0.833 | -1033.0 | 9 |
| scenario-headroom | >48h | 3 | 0 | 1.000 | -1615.4 | 3 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 17095 | 0.0% | 0 | 0 | 0 | 0 | 0 | 0 | — | — | — | — | — | — |
| scenario-equal | 17095 | 100.0% | 17095 | 0 | 1969 | 7590 | 7365 | 171 | 0.206 | 0.920 | 0.337 | -1439.6 | 1488.6 | 0.151 |
| scenario-equal-original | 17095 | 100.0% | 17095 | 0 | 1969 | 7586 | 7369 | 171 | 0.206 | 0.920 | 0.337 | -1439.6 | 1488.6 | 0.151 |
| scenario-headroom | 17095 | 100.0% | 17095 | 0 | 1780 | 5338 | 9617 | 360 | 0.250 | 0.832 | 0.385 | -826.1 | 1122.8 | 0.113 |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

Against the pre-correction scan (n=13): scenario-equal -1033.0 min, scenario-equal-original -1033.0 min; paired median change in absolute error 0.0 min (n=13, negative = the correction lands closer).

### Bootstrap

Block bootstrap of `scenario-equal − baseline`, resampling blocks rather than instants (window lifecycles overall, episodes on transitions). The baseline is the current model for criteria A-C and the pre-correction scan for criterion D; both rows are printed for both cohorts.

| cohort | baseline | statistic | p2.5 | p50 | p97.5 | resamples |
|---|---|---|---:|---:|---:|---:|
| Overall (block = window lifecycle) | current | f1 | -0.007 | 0.070 | 0.145 | 1000 |
| Overall (block = window lifecycle) | current | medianAbsErrorMinutes | -37.145 | 11.570 | 45.147 | 1000 |
| Overall (block = window lifecycle) | current | medianSignedErrorMinutes | 3.721 | 17.749 | 35.093 | 1000 |
| Any transition (block = episode) | current | f1 | 0.013 | 0.091 | 0.181 | 1000 |
| Any transition (block = episode) | current | medianAbsErrorMinutes | -220.541 | 4.929 | 171.271 | 1000 |
| Any transition (block = episode) | current | medianSignedErrorMinutes | -88.834 | 5.999 | 320.561 | 1000 |
| Overall (block = window lifecycle) | scenario-equal-original | f1 | 0.000 | 0.000 | 0.000 | 1000 |
| Overall (block = window lifecycle) | scenario-equal-original | medianAbsErrorMinutes | -3.890 | -1.309 | 1.314 | 1000 |
| Overall (block = window lifecycle) | scenario-equal-original | medianSignedErrorMinutes | -3.890 | -0.909 | 3.242 | 1000 |
| Any transition (block = episode) | scenario-equal-original | f1 | 0.000 | 0.000 | 0.000 | 1000 |
| Any transition (block = episode) | scenario-equal-original | medianAbsErrorMinutes | -4.461 | -1.516 | 1.314 | 1000 |
| Any transition (block = episode) | scenario-equal-original | medianSignedErrorMinutes | -4.461 | -0.916 | 0.000 | 1000 |

## Observation-lag mechanism check

What the correction actually did to the projections, as opposed to what it scored. `scenario-equal` advances each reading over its observation lag; `scenario-equal-original` is the identical equal split with that advance switched off. Each check below states what it measures, which records enter it, which are excluded and by which predicate, and prints the number that falls out of that population. None of them states what the number ought to be; reading it against the mechanism described is the reader's job. An eligible set of zero is reported as such rather than as a pass.

### Observation age

The scored cohort split by how old the reading behind each record was. Buckets are half-open and contiguous; a negative age is a reading stamped ahead of the instant replaying it, and `unknown` is a row with no `observed_at` at all — which is most rows before 2026-08-24, and is why the regression path derives its lag from the fit rather than from the observation.

#### combined

Reconciliation: 0 + 1632 + 2546 + 1018 + 57 + 19947 = 25200 of 25200 eligible records.

##### age future (< 0)

n: 0 records, 0 window lifecycles, 0 episodes.

No records in this cohort.

##### age 0-2 min

n: 1632 records, 160 window lifecycles, 18 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 160 | 100.0% | 160 | 0 | 7 | 28 | 119 | 6 | 0.200 | 0.538 | 0.292 | -8.1 | 12.4 | 0.041 |
| scenario-equal | 160 | 100.0% | 160 | 0 | 8 | 20 | 127 | 5 | 0.286 | 0.615 | 0.390 | 24.7 | 24.7 | 0.082 |
| scenario-equal-original | 160 | 100.0% | 160 | 0 | 8 | 20 | 127 | 5 | 0.286 | 0.615 | 0.390 | 25.2 | 25.2 | 0.084 |
| scenario-headroom | 160 | 100.0% | 160 | 0 | 6 | 14 | 133 | 7 | 0.300 | 0.462 | 0.364 | 54.2 | 54.2 | 0.181 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 160 | 0 | 0 | 0 | 0 | 160 |
| scenario-equal | 160 | 0 | 0 | 0 | 0 | 160 |
| scenario-equal-original | 160 | 0 | 0 | 0 | 0 | 160 |
| scenario-headroom | 160 | 0 | 0 | 0 | 0 | 160 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 1 | 0.000 | — | 9 |
| current | 30m-2h | 7 | 5 | 0.583 | -8.1 | 7 |
| current | 2h-12h | 0 | 0 | — | — | 7 |
| current | 12h-48h | 0 | 0 | — | — | 3 |
| current | >48h | 0 | 0 | — | — | 2 |
| scenario-equal | <30m | 1 | 0 | 1.000 | -4.1 | 4 |
| scenario-equal | 30m-2h | 7 | 5 | 0.583 | 36.6 | 7 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 5 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-equal | >48h | 0 | 0 | — | — | 1 |
| scenario-equal-original | <30m | 1 | 0 | 1.000 | -2.4 | 4 |
| scenario-equal-original | 30m-2h | 7 | 5 | 0.583 | 37.1 | 7 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 5 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 1 |
| scenario-headroom | <30m | 1 | 0 | 1.000 | -3.3 | 1 |
| scenario-headroom | 30m-2h | 5 | 7 | 0.417 | 57.1 | 6 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 1 |
| scenario-headroom | >48h | 0 | 0 | — | — | 4 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1632 | 100.0% | 1632 | 0 | 46 | 609 | 957 | 20 | 0.070 | 0.697 | 0.128 | -2.9 | 14.5 | 0.048 |
| scenario-equal | 1632 | 100.0% | 1632 | 0 | 34 | 596 | 970 | 32 | 0.054 | 0.515 | 0.098 | 20.9 | 20.9 | 0.070 |
| scenario-equal-original | 1632 | 100.0% | 1632 | 0 | 34 | 596 | 970 | 32 | 0.054 | 0.515 | 0.098 | 21.4 | 21.4 | 0.071 |
| scenario-headroom | 1632 | 100.0% | 1632 | 0 | 23 | 430 | 1136 | 43 | 0.051 | 0.348 | 0.089 | 54.3 | 54.3 | 0.181 |

Paired median signed error (n=5; positive = optimistic): scenario-equal 36.6 min, current -5.1 min.

Against the pre-correction scan (n=8): scenario-equal 24.7 min, scenario-equal-original 25.2 min; paired median change in absolute error -0.5 min (n=8, negative = the correction lands closer).

##### age 2-5 min

n: 2546 records, 164 window lifecycles, 18 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 164 | 100.0% | 164 | 0 | 6 | 26 | 126 | 6 | 0.188 | 0.500 | 0.273 | 0.4 | 5.1 | 0.017 |
| scenario-equal | 164 | 100.0% | 164 | 0 | 7 | 22 | 130 | 5 | 0.241 | 0.583 | 0.341 | 29.1 | 29.1 | 0.097 |
| scenario-equal-original | 164 | 100.0% | 164 | 0 | 7 | 21 | 131 | 5 | 0.250 | 0.583 | 0.350 | 30.6 | 30.6 | 0.102 |
| scenario-headroom | 164 | 100.0% | 164 | 0 | 5 | 11 | 141 | 7 | 0.313 | 0.417 | 0.357 | 56.7 | 56.7 | 0.189 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 164 | 0 | 0 | 0 | 0 | 164 |
| scenario-equal | 164 | 0 | 0 | 0 | 0 | 164 |
| scenario-equal-original | 164 | 0 | 0 | 0 | 0 | 164 |
| scenario-headroom | 164 | 0 | 0 | 0 | 0 | 164 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 2 | 2 | 0.500 | 9.0 | 7 |
| current | 30m-2h | 4 | 4 | 0.500 | -5.1 | 9 |
| current | 2h-12h | 0 | 0 | — | — | 4 |
| current | 12h-48h | 0 | 0 | — | — | 3 |
| current | >48h | 0 | 0 | — | — | 3 |
| scenario-equal | <30m | 3 | 1 | 0.750 | 17.5 | 4 |
| scenario-equal | 30m-2h | 4 | 4 | 0.500 | 51.6 | 8 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 5 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-equal | >48h | 0 | 0 | — | — | 2 |
| scenario-equal-original | <30m | 3 | 1 | 0.750 | 19.0 | 4 |
| scenario-equal-original | 30m-2h | 4 | 4 | 0.500 | 53.1 | 7 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 5 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 2 |
| scenario-headroom | <30m | 3 | 1 | 0.750 | 56.7 | 0 |
| scenario-headroom | 30m-2h | 2 | 6 | 0.250 | -10.1 | 5 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 4 |
| scenario-headroom | >48h | 0 | 0 | — | — | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 2546 | 100.0% | 2546 | 0 | 33 | 1117 | 1379 | 17 | 0.029 | 0.660 | 0.055 | 2.2 | 10.0 | 0.033 |
| scenario-equal | 2546 | 100.0% | 2546 | 0 | 31 | 1051 | 1445 | 19 | 0.029 | 0.620 | 0.055 | 17.5 | 17.5 | 0.058 |
| scenario-equal-original | 2546 | 100.0% | 2546 | 0 | 31 | 1049 | 1447 | 19 | 0.029 | 0.620 | 0.055 | 19.0 | 19.0 | 0.063 |
| scenario-headroom | 2546 | 100.0% | 2546 | 0 | 16 | 725 | 1771 | 34 | 0.022 | 0.320 | 0.040 | 63.6 | 63.6 | 0.212 |

Paired median signed error (n=4; positive = optimistic): scenario-equal 17.5 min, current 3.8 min.

Against the pre-correction scan (n=7): scenario-equal 29.1 min, scenario-equal-original 30.6 min; paired median change in absolute error -1.5 min (n=7, negative = the correction lands closer).

##### age 5-10 min

n: 1018 records, 97 window lifecycles, 9 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 97 | 100.0% | 97 | 0 | 1 | 14 | 80 | 2 | 0.067 | 0.333 | 0.111 | 27.5 | 27.5 | 0.092 |
| scenario-equal | 97 | 100.0% | 97 | 0 | 2 | 11 | 83 | 1 | 0.154 | 0.667 | 0.250 | 18.3 | 18.3 | 0.061 |
| scenario-equal-original | 97 | 100.0% | 97 | 0 | 2 | 11 | 83 | 1 | 0.154 | 0.667 | 0.250 | 22.8 | 22.8 | 0.076 |
| scenario-headroom | 97 | 100.0% | 97 | 0 | 2 | 5 | 89 | 1 | 0.286 | 0.667 | 0.400 | 33.7 | 33.7 | 0.112 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 97 | 0 | 0 | 0 | 0 | 97 |
| scenario-equal | 97 | 0 | 0 | 0 | 0 | 97 |
| scenario-equal-original | 97 | 0 | 0 | 0 | 0 | 97 |
| scenario-headroom | 97 | 0 | 0 | 0 | 0 | 97 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 5 |
| current | 30m-2h | 1 | 1 | 0.500 | 27.5 | 2 |
| current | 2h-12h | 0 | 1 | 0.000 | — | 3 |
| current | 12h-48h | 0 | 0 | — | — | 2 |
| current | >48h | 0 | 0 | — | — | 2 |
| scenario-equal | <30m | 0 | 0 | — | — | 1 |
| scenario-equal | 30m-2h | 2 | 0 | 1.000 | 18.3 | 4 |
| scenario-equal | 2h-12h | 0 | 1 | 0.000 | — | 3 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-equal | >48h | 0 | 0 | — | — | 1 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 1 |
| scenario-equal-original | 30m-2h | 2 | 0 | 1.000 | 22.8 | 4 |
| scenario-equal-original | 2h-12h | 0 | 1 | 0.000 | — | 3 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 1 |
| scenario-headroom | <30m | 0 | 0 | — | — | 1 |
| scenario-headroom | 30m-2h | 2 | 0 | 1.000 | 33.7 | 0 |
| scenario-headroom | 2h-12h | 0 | 1 | 0.000 | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-headroom | >48h | 0 | 0 | — | — | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1018 | 100.0% | 1018 | 0 | 1 | 359 | 655 | 3 | 0.003 | 0.250 | 0.005 | 27.5 | 27.5 | 0.092 |
| scenario-equal | 1018 | 100.0% | 1018 | 0 | 2 | 350 | 664 | 2 | 0.006 | 0.500 | 0.011 | 18.3 | 18.3 | 0.061 |
| scenario-equal-original | 1018 | 100.0% | 1018 | 0 | 2 | 349 | 665 | 2 | 0.006 | 0.500 | 0.011 | 22.8 | 22.8 | 0.076 |
| scenario-headroom | 1018 | 100.0% | 1018 | 0 | 2 | 240 | 774 | 2 | 0.008 | 0.500 | 0.016 | 33.7 | 33.7 | 0.112 |

Paired median signed error (n=1; positive = optimistic): scenario-equal 18.3 min, current 27.5 min.

Against the pre-correction scan (n=2): scenario-equal 18.3 min, scenario-equal-original 22.8 min; paired median change in absolute error -4.5 min (n=2, negative = the correction lands closer).

##### age >= 10 min

n: 57 records, 17 window lifecycles, 2 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 17 | 100.0% | 17 | 0 | 0 | 6 | 11 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 17 | 100.0% | 17 | 0 | 0 | 6 | 11 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 17 | 100.0% | 17 | 0 | 0 | 6 | 11 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 17 | 100.0% | 17 | 0 | 0 | 5 | 12 | 0 | 0.000 | — | 0.000 | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-equal | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-equal-original | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-headroom | 17 | 0 | 0 | 0 | 0 | 17 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 1 |
| current | 12h-48h | 0 | 0 | — | — | 3 |
| current | >48h | 0 | 0 | — | — | 2 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-equal | >48h | 0 | 0 | — | — | 2 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 2 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-headroom | >48h | 0 | 0 | — | — | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 57 | 100.0% | 57 | 0 | 0 | 23 | 34 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 57 | 100.0% | 57 | 0 | 0 | 23 | 34 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 57 | 100.0% | 57 | 0 | 0 | 23 | 34 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 57 | 100.0% | 57 | 0 | 0 | 20 | 37 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

Against the pre-correction scan (n=0): scenario-equal — min, scenario-equal-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### age unknown (null)

n: 19947 records, 455 window lifecycles, 39 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 455 | 100.0% | 455 | 0 | 25 | 52 | 369 | 9 | 0.325 | 0.735 | 0.450 | -12.4 | 35.6 | 0.089 |
| scenario-equal | 455 | 100.0% | 455 | 0 | 24 | 37 | 384 | 10 | 0.393 | 0.706 | 0.505 | 5.0 | 41.7 | 0.104 |
| scenario-equal-original | 455 | 100.0% | 455 | 0 | 24 | 37 | 384 | 10 | 0.393 | 0.706 | 0.505 | 1.8 | 42.5 | 0.104 |
| scenario-headroom | 455 | 100.0% | 455 | 0 | 18 | 27 | 394 | 16 | 0.400 | 0.529 | 0.456 | 35.6 | 138.3 | 0.135 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 455 | 0 | 0 | 0 | 0 | 455 |
| scenario-equal | 455 | 0 | 0 | 0 | 0 | 455 |
| scenario-equal-original | 455 | 0 | 0 | 0 | 0 | 455 |
| scenario-headroom | 455 | 0 | 0 | 0 | 0 | 455 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 2 | 0 | 1.000 | -12.4 | 4 |
| current | 30m-2h | 14 | 7 | 0.667 | 8.9 | 24 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 3 | 2 | 0.600 | 758.8 | 17 |
| current | >48h | 6 | 0 | 1.000 | -2515.9 | 7 |
| scenario-equal | <30m | 2 | 0 | 1.000 | 0.1 | 2 |
| scenario-equal | 30m-2h | 12 | 9 | 0.571 | 14.5 | 11 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 4 | 1 | 0.800 | 5.0 | 19 |
| scenario-equal | >48h | 6 | 0 | 1.000 | -2196.3 | 5 |
| scenario-equal-original | <30m | 2 | 0 | 1.000 | 1.0 | 2 |
| scenario-equal-original | 30m-2h | 12 | 9 | 0.571 | 15.4 | 11 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 4 | 1 | 0.800 | 1.8 | 19 |
| scenario-equal-original | >48h | 6 | 0 | 1.000 | -2196.3 | 5 |
| scenario-headroom | <30m | 2 | 0 | 1.000 | 81.8 | 0 |
| scenario-headroom | 30m-2h | 7 | 14 | 0.333 | 51.5 | 4 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 3 | 2 | 0.600 | 758.8 | 15 |
| scenario-headroom | >48h | 6 | 0 | 1.000 | -1360.3 | 8 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 19947 | 100.0% | 19947 | 0 | 2912 | 5618 | 10763 | 654 | 0.341 | 0.817 | 0.481 | -109.7 | 1237.4 | 0.126 |
| scenario-equal | 19947 | 100.0% | 19947 | 0 | 3083 | 5562 | 10819 | 483 | 0.357 | 0.865 | 0.505 | -460.9 | 1071.6 | 0.110 |
| scenario-equal-original | 19947 | 100.0% | 19947 | 0 | 3081 | 5557 | 10824 | 485 | 0.357 | 0.864 | 0.505 | -461.1 | 1071.9 | 0.110 |
| scenario-headroom | 19947 | 100.0% | 19947 | 0 | 2703 | 4786 | 11595 | 863 | 0.361 | 0.758 | 0.489 | -30.5 | 979.3 | 0.102 |

Paired median signed error (n=22; positive = optimistic): scenario-equal 5.7 min, current -25.8 min.

Against the pre-correction scan (n=24): scenario-equal 5.0 min, scenario-equal-original 1.8 min; paired median change in absolute error 0.0 min (n=24, negative = the correction lands closer).

#### five_hour

Reconciliation: 0 + 1107 + 1380 + 451 + 13 + 7781 = 10732 of 10732 eligible records.

##### age future (< 0)

n: 0 records, 0 window lifecycles, 0 episodes.

No records in this cohort.

##### age 0-2 min

n: 1107 records, 150 window lifecycles, 18 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 150 | 100.0% | 150 | 0 | 7 | 20 | 117 | 6 | 0.259 | 0.538 | 0.350 | -8.1 | 12.4 | 0.041 |
| scenario-equal | 150 | 100.0% | 150 | 0 | 8 | 12 | 125 | 5 | 0.400 | 0.615 | 0.485 | 24.7 | 24.7 | 0.082 |
| scenario-equal-original | 150 | 100.0% | 150 | 0 | 8 | 12 | 125 | 5 | 0.400 | 0.615 | 0.485 | 25.2 | 25.2 | 0.084 |
| scenario-headroom | 150 | 100.0% | 150 | 0 | 6 | 9 | 128 | 7 | 0.400 | 0.462 | 0.429 | 54.2 | 54.2 | 0.181 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 150 | 0 | 0 | 0 | 0 | 150 |
| scenario-equal | 150 | 0 | 0 | 0 | 0 | 150 |
| scenario-equal-original | 150 | 0 | 0 | 0 | 0 | 150 |
| scenario-headroom | 150 | 0 | 0 | 0 | 0 | 150 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 1 | 0.000 | — | 9 |
| current | 30m-2h | 7 | 5 | 0.583 | -8.1 | 7 |
| current | 2h-12h | 0 | 0 | — | — | 4 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 1 | 0 | 1.000 | -4.1 | 4 |
| scenario-equal | 30m-2h | 7 | 5 | 0.583 | 36.6 | 7 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 1 | 0 | 1.000 | -2.4 | 4 |
| scenario-equal-original | 30m-2h | 7 | 5 | 0.583 | 37.1 | 7 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 1 | 0 | 1.000 | -3.3 | 1 |
| scenario-headroom | 30m-2h | 5 | 7 | 0.417 | 57.1 | 6 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1107 | 100.0% | 1107 | 0 | 46 | 160 | 881 | 20 | 0.223 | 0.697 | 0.338 | -2.9 | 14.5 | 0.048 |
| scenario-equal | 1107 | 100.0% | 1107 | 0 | 34 | 135 | 906 | 32 | 0.201 | 0.515 | 0.289 | 20.9 | 20.9 | 0.070 |
| scenario-equal-original | 1107 | 100.0% | 1107 | 0 | 34 | 135 | 906 | 32 | 0.201 | 0.515 | 0.289 | 21.4 | 21.4 | 0.071 |
| scenario-headroom | 1107 | 100.0% | 1107 | 0 | 23 | 82 | 959 | 43 | 0.219 | 0.348 | 0.269 | 54.3 | 54.3 | 0.181 |

Paired median signed error (n=5; positive = optimistic): scenario-equal 36.6 min, current -5.1 min.

Against the pre-correction scan (n=8): scenario-equal 24.7 min, scenario-equal-original 25.2 min; paired median change in absolute error -0.5 min (n=8, negative = the correction lands closer).

##### age 2-5 min

n: 1380 records, 154 window lifecycles, 18 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 154 | 100.0% | 154 | 0 | 6 | 17 | 125 | 6 | 0.261 | 0.500 | 0.343 | 0.4 | 5.1 | 0.017 |
| scenario-equal | 154 | 100.0% | 154 | 0 | 7 | 13 | 129 | 5 | 0.350 | 0.583 | 0.438 | 29.1 | 29.1 | 0.097 |
| scenario-equal-original | 154 | 100.0% | 154 | 0 | 7 | 12 | 130 | 5 | 0.368 | 0.583 | 0.452 | 30.6 | 30.6 | 0.102 |
| scenario-headroom | 154 | 100.0% | 154 | 0 | 5 | 5 | 137 | 7 | 0.500 | 0.417 | 0.455 | 56.7 | 56.7 | 0.189 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 154 | 0 | 0 | 0 | 0 | 154 |
| scenario-equal | 154 | 0 | 0 | 0 | 0 | 154 |
| scenario-equal-original | 154 | 0 | 0 | 0 | 0 | 154 |
| scenario-headroom | 154 | 0 | 0 | 0 | 0 | 154 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 2 | 2 | 0.500 | 9.0 | 7 |
| current | 30m-2h | 4 | 4 | 0.500 | -5.1 | 9 |
| current | 2h-12h | 0 | 0 | — | — | 1 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 3 | 1 | 0.750 | 17.5 | 4 |
| scenario-equal | 30m-2h | 4 | 4 | 0.500 | 51.6 | 7 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 3 | 1 | 0.750 | 19.0 | 4 |
| scenario-equal-original | 30m-2h | 4 | 4 | 0.500 | 53.1 | 6 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 3 | 1 | 0.750 | 56.7 | 0 |
| scenario-headroom | 30m-2h | 2 | 6 | 0.250 | -10.1 | 5 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1380 | 100.0% | 1380 | 0 | 33 | 186 | 1144 | 17 | 0.151 | 0.660 | 0.245 | 2.2 | 10.0 | 0.033 |
| scenario-equal | 1380 | 100.0% | 1380 | 0 | 31 | 86 | 1244 | 19 | 0.265 | 0.620 | 0.371 | 17.5 | 17.5 | 0.058 |
| scenario-equal-original | 1380 | 100.0% | 1380 | 0 | 31 | 84 | 1246 | 19 | 0.270 | 0.620 | 0.376 | 19.0 | 19.0 | 0.063 |
| scenario-headroom | 1380 | 100.0% | 1380 | 0 | 16 | 36 | 1294 | 34 | 0.308 | 0.320 | 0.314 | 63.6 | 63.6 | 0.212 |

Paired median signed error (n=4; positive = optimistic): scenario-equal 17.5 min, current 3.8 min.

Against the pre-correction scan (n=7): scenario-equal 29.1 min, scenario-equal-original 30.6 min; paired median change in absolute error -1.5 min (n=7, negative = the correction lands closer).

##### age 5-10 min

n: 451 records, 87 window lifecycles, 9 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 87 | 100.0% | 87 | 0 | 1 | 7 | 77 | 2 | 0.125 | 0.333 | 0.182 | 27.5 | 27.5 | 0.092 |
| scenario-equal | 87 | 100.0% | 87 | 0 | 2 | 3 | 81 | 1 | 0.400 | 0.667 | 0.500 | 18.3 | 18.3 | 0.061 |
| scenario-equal-original | 87 | 100.0% | 87 | 0 | 2 | 3 | 81 | 1 | 0.400 | 0.667 | 0.500 | 22.8 | 22.8 | 0.076 |
| scenario-headroom | 87 | 100.0% | 87 | 0 | 2 | 1 | 83 | 1 | 0.667 | 0.667 | 0.667 | 33.7 | 33.7 | 0.112 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 87 | 0 | 0 | 0 | 0 | 87 |
| scenario-equal | 87 | 0 | 0 | 0 | 0 | 87 |
| scenario-equal-original | 87 | 0 | 0 | 0 | 0 | 87 |
| scenario-headroom | 87 | 0 | 0 | 0 | 0 | 87 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 5 |
| current | 30m-2h | 1 | 1 | 0.500 | 27.5 | 2 |
| current | 2h-12h | 0 | 1 | 0.000 | — | 0 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 0 | 0 | — | — | 1 |
| scenario-equal | 30m-2h | 2 | 0 | 1.000 | 18.3 | 2 |
| scenario-equal | 2h-12h | 0 | 1 | 0.000 | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 1 |
| scenario-equal-original | 30m-2h | 2 | 0 | 1.000 | 22.8 | 2 |
| scenario-equal-original | 2h-12h | 0 | 1 | 0.000 | — | 0 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 0 | 0 | — | — | 1 |
| scenario-headroom | 30m-2h | 2 | 0 | 1.000 | 33.7 | 0 |
| scenario-headroom | 2h-12h | 0 | 1 | 0.000 | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 451 | 100.0% | 451 | 0 | 1 | 24 | 423 | 3 | 0.040 | 0.250 | 0.069 | 27.5 | 27.5 | 0.092 |
| scenario-equal | 451 | 100.0% | 451 | 0 | 2 | 7 | 440 | 2 | 0.222 | 0.500 | 0.308 | 18.3 | 18.3 | 0.061 |
| scenario-equal-original | 451 | 100.0% | 451 | 0 | 2 | 7 | 440 | 2 | 0.222 | 0.500 | 0.308 | 22.8 | 22.8 | 0.076 |
| scenario-headroom | 451 | 100.0% | 451 | 0 | 2 | 4 | 443 | 2 | 0.333 | 0.500 | 0.400 | 33.7 | 33.7 | 0.112 |

Paired median signed error (n=1; positive = optimistic): scenario-equal 18.3 min, current 27.5 min.

Against the pre-correction scan (n=2): scenario-equal 18.3 min, scenario-equal-original 22.8 min; paired median change in absolute error -4.5 min (n=2, negative = the correction lands closer).

##### age >= 10 min

n: 13 records, 10 window lifecycles, 2 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-equal | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-equal-original | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-headroom | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal-original | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-headroom | 10 | 0 | 0 | 0 | 0 | 10 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 13 | 100.0% | 13 | 0 | 0 | 0 | 13 | 0 | — | — | — | — | — | — |
| scenario-equal | 13 | 100.0% | 13 | 0 | 0 | 0 | 13 | 0 | — | — | — | — | — | — |
| scenario-equal-original | 13 | 100.0% | 13 | 0 | 0 | 0 | 13 | 0 | — | — | — | — | — | — |
| scenario-headroom | 13 | 100.0% | 13 | 0 | 0 | 0 | 13 | 0 | — | — | — | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

Against the pre-correction scan (n=0): scenario-equal — min, scenario-equal-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### age unknown (null)

n: 7781 records, 402 window lifecycles, 36 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 402 | 100.0% | 402 | 0 | 16 | 28 | 351 | 7 | 0.364 | 0.696 | 0.478 | -3.6 | 15.6 | 0.052 |
| scenario-equal | 402 | 100.0% | 402 | 0 | 14 | 13 | 366 | 9 | 0.519 | 0.609 | 0.560 | 13.9 | 19.1 | 0.064 |
| scenario-equal-original | 402 | 100.0% | 402 | 0 | 14 | 13 | 366 | 9 | 0.519 | 0.609 | 0.560 | 14.8 | 21.0 | 0.070 |
| scenario-headroom | 402 | 100.0% | 402 | 0 | 9 | 4 | 375 | 14 | 0.692 | 0.391 | 0.500 | 51.5 | 51.5 | 0.172 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 402 | 0 | 0 | 0 | 0 | 402 |
| scenario-equal | 402 | 0 | 0 | 0 | 0 | 402 |
| scenario-equal-original | 402 | 0 | 0 | 0 | 0 | 402 |
| scenario-headroom | 402 | 0 | 0 | 0 | 0 | 402 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 2 | 0 | 1.000 | -12.4 | 4 |
| current | 30m-2h | 14 | 7 | 0.667 | 8.9 | 24 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 2 | 0 | 1.000 | 0.1 | 2 |
| scenario-equal | 30m-2h | 12 | 9 | 0.571 | 14.5 | 11 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | <30m | 2 | 0 | 1.000 | 1.0 | 2 |
| scenario-equal-original | 30m-2h | 12 | 9 | 0.571 | 15.4 | 11 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 2 | 0 | 1.000 | 81.8 | 0 |
| scenario-headroom | 30m-2h | 7 | 14 | 0.333 | 51.5 | 4 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 7781 | 100.0% | 7781 | 0 | 174 | 591 | 6920 | 96 | 0.227 | 0.644 | 0.336 | 0.2 | 16.2 | 0.054 |
| scenario-equal | 7781 | 100.0% | 7781 | 0 | 153 | 250 | 7261 | 117 | 0.380 | 0.567 | 0.455 | 10.8 | 20.7 | 0.069 |
| scenario-equal-original | 7781 | 100.0% | 7781 | 0 | 151 | 245 | 7266 | 119 | 0.381 | 0.559 | 0.453 | 11.8 | 20.7 | 0.069 |
| scenario-headroom | 7781 | 100.0% | 7781 | 0 | 99 | 151 | 7360 | 171 | 0.396 | 0.367 | 0.381 | 46.7 | 51.5 | 0.172 |

Paired median signed error (n=13; positive = optimistic): scenario-equal 14.5 min, current -4.8 min.

Against the pre-correction scan (n=14): scenario-equal 13.9 min, scenario-equal-original 14.8 min; paired median change in absolute error -0.9 min (n=14, negative = the correction lands closer).

#### seven_day

Reconciliation: 0 + 525 + 1166 + 567 + 44 + 12166 = 14468 of 14468 eligible records.

##### age future (< 0)

n: 0 records, 0 window lifecycles, 0 episodes.

No records in this cohort.

##### age 0-2 min

n: 525 records, 10 window lifecycles, 1 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 10 | 100.0% | 10 | 0 | 0 | 8 | 2 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 10 | 100.0% | 10 | 0 | 0 | 8 | 2 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 10 | 100.0% | 10 | 0 | 0 | 8 | 2 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 10 | 100.0% | 10 | 0 | 0 | 5 | 5 | 0 | 0.000 | — | 0.000 | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal-original | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-headroom | 10 | 0 | 0 | 0 | 0 | 10 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 3 |
| current | 12h-48h | 0 | 0 | — | — | 3 |
| current | >48h | 0 | 0 | — | — | 2 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 4 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-equal | >48h | 0 | 0 | — | — | 1 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 4 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 1 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 1 |
| scenario-headroom | >48h | 0 | 0 | — | — | 4 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 525 | 100.0% | 525 | 0 | 0 | 449 | 76 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 525 | 100.0% | 525 | 0 | 0 | 461 | 64 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 525 | 100.0% | 525 | 0 | 0 | 461 | 64 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 525 | 100.0% | 525 | 0 | 0 | 348 | 177 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

Against the pre-correction scan (n=0): scenario-equal — min, scenario-equal-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### age 2-5 min

n: 1166 records, 10 window lifecycles, 1 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 10 | 100.0% | 10 | 0 | 0 | 9 | 1 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 10 | 100.0% | 10 | 0 | 0 | 9 | 1 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 10 | 100.0% | 10 | 0 | 0 | 9 | 1 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 10 | 100.0% | 10 | 0 | 0 | 6 | 4 | 0 | 0.000 | — | 0.000 | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal-original | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-headroom | 10 | 0 | 0 | 0 | 0 | 10 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 3 |
| current | 12h-48h | 0 | 0 | — | — | 3 |
| current | >48h | 0 | 0 | — | — | 3 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 3 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-equal | >48h | 0 | 0 | — | — | 2 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 3 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 2 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 4 |
| scenario-headroom | >48h | 0 | 0 | — | — | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1166 | 100.0% | 1166 | 0 | 0 | 931 | 235 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 1166 | 100.0% | 1166 | 0 | 0 | 965 | 201 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 1166 | 100.0% | 1166 | 0 | 0 | 965 | 201 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 1166 | 100.0% | 1166 | 0 | 0 | 689 | 477 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

Against the pre-correction scan (n=0): scenario-equal — min, scenario-equal-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### age 5-10 min

n: 567 records, 10 window lifecycles, 0 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 10 | 100.0% | 10 | 0 | 0 | 7 | 3 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 10 | 100.0% | 10 | 0 | 0 | 8 | 2 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 10 | 100.0% | 10 | 0 | 0 | 8 | 2 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 10 | 100.0% | 10 | 0 | 0 | 4 | 6 | 0 | 0.000 | — | 0.000 | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal-original | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-headroom | 10 | 0 | 0 | 0 | 0 | 10 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 3 |
| current | 12h-48h | 0 | 0 | — | — | 2 |
| current | >48h | 0 | 0 | — | — | 2 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 2 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 3 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-equal | >48h | 0 | 0 | — | — | 1 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 2 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 3 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 1 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-headroom | >48h | 0 | 0 | — | — | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 567 | 100.0% | 567 | 0 | 0 | 335 | 232 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 567 | 100.0% | 567 | 0 | 0 | 343 | 224 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 567 | 100.0% | 567 | 0 | 0 | 342 | 225 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 567 | 100.0% | 567 | 0 | 0 | 236 | 331 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

Against the pre-correction scan (n=0): scenario-equal — min, scenario-equal-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### age >= 10 min

n: 44 records, 7 window lifecycles, 0 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 7 | 100.0% | 7 | 0 | 0 | 6 | 1 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 7 | 100.0% | 7 | 0 | 0 | 6 | 1 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 7 | 100.0% | 7 | 0 | 0 | 6 | 1 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 7 | 100.0% | 7 | 0 | 0 | 5 | 2 | 0 | 0.000 | — | 0.000 | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-equal | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-equal-original | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-headroom | 7 | 0 | 0 | 0 | 0 | 7 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 1 |
| current | 12h-48h | 0 | 0 | — | — | 3 |
| current | >48h | 0 | 0 | — | — | 2 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-equal | >48h | 0 | 0 | — | — | 2 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-equal-original | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-equal-original | >48h | 0 | 0 | — | — | 2 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-headroom | >48h | 0 | 0 | — | — | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 44 | 100.0% | 44 | 0 | 0 | 23 | 21 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 44 | 100.0% | 44 | 0 | 0 | 23 | 21 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 44 | 100.0% | 44 | 0 | 0 | 23 | 21 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 44 | 100.0% | 44 | 0 | 0 | 20 | 24 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

Against the pre-correction scan (n=0): scenario-equal — min, scenario-equal-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### age unknown (null)

n: 12166 records, 53 window lifecycles, 39 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 53 | 100.0% | 53 | 0 | 9 | 24 | 18 | 2 | 0.273 | 0.818 | 0.409 | -1610.6 | 1610.6 | 0.160 |
| scenario-equal | 53 | 100.0% | 53 | 0 | 10 | 24 | 18 | 1 | 0.294 | 0.909 | 0.444 | -1417.9 | 1402.2 | 0.139 |
| scenario-equal-original | 53 | 100.0% | 53 | 0 | 10 | 24 | 18 | 1 | 0.294 | 0.909 | 0.444 | -1417.9 | 1402.2 | 0.139 |
| scenario-headroom | 53 | 100.0% | 53 | 0 | 9 | 23 | 19 | 2 | 0.281 | 0.818 | 0.419 | -736.2 | 954.1 | 0.095 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 53 | 0 | 0 | 0 | 0 | 53 |
| scenario-equal | 53 | 0 | 0 | 0 | 0 | 53 |
| scenario-equal-original | 53 | 0 | 0 | 0 | 0 | 53 |
| scenario-headroom | 53 | 0 | 0 | 0 | 0 | 53 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 3 | 2 | 0.600 | 758.8 | 17 |
| current | >48h | 6 | 0 | 1.000 | -2515.9 | 7 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 4 | 1 | 0.800 | 5.0 | 19 |
| scenario-equal | >48h | 6 | 0 | 1.000 | -2196.3 | 5 |
| scenario-equal-original | <30m | 0 | 0 | — | — | 0 |
| scenario-equal-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal-original | 12h-48h | 4 | 1 | 0.800 | 1.8 | 19 |
| scenario-equal-original | >48h | 6 | 0 | 1.000 | -2196.3 | 5 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 3 | 2 | 0.600 | 758.8 | 15 |
| scenario-headroom | >48h | 6 | 0 | 1.000 | -1360.3 | 8 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 12166 | 100.0% | 12166 | 0 | 2738 | 5027 | 3843 | 558 | 0.353 | 0.831 | 0.495 | -265.1 | 1318.6 | 0.131 |
| scenario-equal | 12166 | 100.0% | 12166 | 0 | 2930 | 5312 | 3558 | 366 | 0.355 | 0.889 | 0.508 | -545.4 | 1132.1 | 0.112 |
| scenario-equal-original | 12166 | 100.0% | 12166 | 0 | 2930 | 5312 | 3558 | 366 | 0.355 | 0.889 | 0.508 | -545.4 | 1132.1 | 0.112 |
| scenario-headroom | 12166 | 100.0% | 12166 | 0 | 2604 | 4635 | 4235 | 692 | 0.360 | 0.790 | 0.494 | -122.0 | 1019.7 | 0.101 |

Paired median signed error (n=9; positive = optimistic): scenario-equal -1417.9 min, current -1610.6 min.

Against the pre-correction scan (n=10): scenario-equal -1417.9 min, scenario-equal-original -1417.9 min; paired median change in absolute error 0.0 min (n=10, negative = the correction lands closer).

### Identity on lag-free class-instants

Over the records whose whole class-instant is lag-free — no pooled window of the class carries a lag at that instant — this counts how many the two equal-split models answered differently: a different exhausts/does-not-exhaust verdict, or a different ETA instant. Lag-free is a property of the class-instant rather than of the window, because a peer's lag moves the peer's death and with it this window's share and its ETA; a window's own zero lag therefore does not admit it. A window whose anchor sits ahead of the instant carries the zero `observationLagMs` clamps it to, and enters the population like any other zero.

n=20801 eligible records, 0 of which the two models answered differently. Eligible records span `2026-07-01T00:00:00.000Z` to `2026-09-05T07:20:00.000Z`.

The population is not filtered by estimator path. The now-anchored paths carry no anchor lag at all, so an instant at which every pooled window of a class reads from one of them is lag-free through them alone.

### Lag shift

How far the correction moved each ETA, over the records where both models committed to a date and the record's own window carries a lag. `shift` is `original ETA − corrected ETA`; `excess` is that shift minus the window's own lag.

The split is a property of the record, decided before any ETA is compared. A record enters the first row when, in BOTH scans, its own projected exhaustion precedes both any other projected exhaustion still ahead of the instant and the reset of any class window already at 100 %, and no other window of its class was filled inside ITS own lag while this window is still projecting past the instant. The exhaustions it compares against are the class's first-cycle projected ones, beside the resets of the windows already at 100 % at the instant. Both halves of that predicate do work. The two-scan half: a peer the correction fills inside its own lag dies at the instant in the corrected scan and is alive at it in the pre-correction one, so a window can be the first event of one scan and not of the other. The died-in-lag half: a death applied AT the instant orders ahead of nothing, so it leaves the first-event flag standing while re-splitting the class from the instant on. The second row is every other record with a positive lag and a date in both scans, over the same columns.

| split | n | median shift (min) | median excess (min) | p10 excess | p90 excess | within 1 s of own lag |
|---|---:|---:|---:|---:|---:|---:|
| eligible first events in both scans | 1731 | 2.83 | 0.00 | 0.00 | 0.00 | 100.0% |
| every other lagged record | 3474 | 4.16 | 0.27 | -1.26 | 2.44 | 7.0% |

### Parity with the current model on lone accounts

The point of deriving the lag per estimator path. Where an account is the only pooled member of its class, its scenario slope IS its own measured slope, and the lag is derived from the same anchor the current model uses, so wherever that anchor was recoverable and sits behind the replayed instant the two scans project the window from one anchor. The column is the share of records whose corrected ETA sits within 1 s of the current model's, over the first-event records of lone accounts where both models committed to a date, split by the estimator path the reading came from; `other` collects the now-anchored paths, which carry no lag for the correction to advance over. The population also holds the records whose anchor sits AHEAD of the replayed instant: `observationLagMs` clamps those to zero lag, so the corrected scan schedules them from the instant while the current model still anchors its ETA to that future instant.

One exclusion applies even on a lone account: a record whose OWN corrected exhaustion is still ahead of the instant while another window of its class was filled inside ITS lag. The correction applies that window's death at the instant, so the account is idle until that window's reset and this projection carries a dead span the current model does not model at all. A record whose own exhaustion the correction moved to the instant is not excluded by this predicate: it is not projecting past the instant, so no dead span stands ahead of it.

| estimator path | n | within 1 s of the current model |
|---|---:|---:|
| regression | 27 | 100.0% |
| lifetime-primary | 270 | 100.0% |
| other | 2554 | 99.6% |

### Fixed paired-ETA subset

Median signed ETA error of the three models on ONE fixed set of records: lifecycle-balanced instants where all three committed to a date and the window's exhaustion was observed. The set is the same for every row, so the rows differ only in which model produced the ETA and not in which records it was medianed over.

| cohort | model | n | median signed error (min) |
|---|---|---:|---:|
| Overall | current | 27 | -12.4 |
| Overall | scenario-equal | 27 | 14.1 |
| Overall | scenario-equal-original | 27 | 14.8 |
| Any transition | current | 16 | -3.6 |
| Any transition | scenario-equal | 16 | 14.1 |
| Any transition | scenario-equal-original | 16 | 14.6 |

### Lag population by estimator path

Which paths the correction touched and by how much, over one model's records (the lag is a property of the reading, so every model's record at an instant carries the same one). `sample − observation` is the delay between a reading being observed and being stored, on the rows that carry both instants.

`no anchor` counts the records of a path whose lag could not be derived at all, and the median and p90 beside it are taken over the remaining ones. The regression path anchors its fit by back-solving the ETA it states, so a fit with NO ETA — a flat or falling six-hour fit, which is what an idle account inside a live window produces — has no recoverable anchor. Such a window is scheduled from the replayed instant in BOTH scans and is advanced by nothing, exactly as it was before the correction existed; the column separates that absence from a lag genuinely measured at zero.

| estimator path | records | no anchor | median lag (min) | p90 lag (min) | rows with both instants | median sample − observation (min) | p90 |
|---|---:|---:|---:|---:|---:|---:|---:|
| lifetime-average | 25724 | 0 | 0.00 | 0.00 | 21 | 0.38 | 1.31 |
| lifetime-primary | 5713 | 0 | 3.81 | 8.77 | 5713 | 1.48 | 2.64 |
| no-usage | 3435 | 0 | 0.00 | 0.00 | 168 | 1.28 | 2.59 |
| regression | 23540 | 11183 | 1.18 | 3.66 | 6292 | 1.30 | 2.57 |
| unstarted | 37 | 0 | 0.00 | 0.00 | 37 | 1.80 | 2.83 |

## Prediction churn

How much each model's answer MOVES between one instant and the next, over adjacent usable instants of the same window lifecycle. Accuracy says nothing about stability: an estimator that alternates between "out in 40 minutes" and "not this cycle" every grid step is unusable at any F1.

Lifecycle-balanced the same way the score tables are: the median (and p90) is taken WITHIN a lifecycle first, then across lifecycles. `flip rate` is the fraction of adjacent pairs where the yes/no verdict changed. A pair is two instants EXACTLY one grid step apart, both usable for that model: nothing bridges a skipped instant or one the model could not answer, so a hole in the series does not read as churn.

Each model is measured on its OWN usable instants, over every replay record rather than the common cohort the score tables use: another model abstaining, or an outcome nobody observed, does not make a model's two consecutive answers unmeasurable. Each row of a cohort is therefore an honest statement about one model, and not a like-for-like comparison the way the scores are.

Not a `BacktestStatistic`: that vocabulary is a function of an unordered bag of records, churn is a function of an ordered sequence inside a lifecycle, and `BacktestRecord` carries no lifecycle id to group by. There is therefore no bootstrap CI on these numbers.

| cohort | model | lifecycles | pairs | median abs ETA change (min) | p90 abs ETA change (min) | median flip rate |
|---|---|---:|---:|---:|---:|---:|
| Overall | current | 617 | 24471 | 11.1 | 19.7 | 0.000 |
| Overall | scenario-equal | 767 | 41666 | 12.2 | 32.7 | 0.000 |
| Overall | scenario-equal-original | 767 | 41666 | 11.7 | 32.7 | 0.000 |
| Overall | scenario-headroom | 767 | 41666 | 13.5 | 27.5 | 0.000 |
| Any transition | current | 165 | 4016 | 11.5 | 18.7 | 0.000 |
| Any transition | scenario-equal | 198 | 6506 | 11.7 | 24.9 | 0.000 |
| Any transition | scenario-equal-original | 198 | 6506 | 11.7 | 24.9 | 0.000 |
| Any transition | scenario-headroom | 198 | 6506 | 12.8 | 24.2 | 0.000 |

## Pool calibration (all-out within 14 d)

The pool-level claim, scored against the observed grid. What the table can say is how often a predicted pool-out was followed by a horizon with no observed all-out tick and at most 5 % of its ticks censored.

- `anthropic`: all-out `2026-07-02T12:00:00.000Z`–`2026-07-02T12:20:00.000Z` (`2` ticks)
- `codex`: all-out `2026-07-02T14:20:00.000Z`–`2026-07-02T14:30:00.000Z` (`1` ticks)
- `codex`: all-out `2026-08-04T20:40:00.000Z`–`2026-08-04T22:00:00.000Z` (`8` ticks)

These intervals are the positives behind the `observed out` column; pool-level recall and F1 are not stated here because per-window scores decide the verdict.

Only instants whose full 14-day horizon fits inside the replay interval are calibrated.

| class | model | instants | abstained | predicted out | observed out | observed non-outage | censored | false-alarm rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic | current | 7627 | 1019 | 2882 | 217 | 7410 | 0 | 0.989 |
| anthropic | scenario-equal | 7627 | 1010 | 5188 | 217 | 7410 | 0 | 0.997 |
| anthropic | scenario-equal-original | 7627 | 1010 | 5188 | 217 | 7410 | 0 | 0.997 |
| anthropic | scenario-headroom | 7627 | 1010 | 5295 | 217 | 7410 | 0 | 0.997 |
| codex | current | 5868 | 1020 | 2594 | 2213 | 1398 | 2257 | 0.274 |
| codex | scenario-equal | 5868 | 1020 | 2594 | 2213 | 1398 | 2257 | 0.274 |
| codex | scenario-equal-original | 5868 | 1020 | 2594 | 2213 | 1398 | 2257 | 0.274 |
| codex | scenario-headroom | 5868 | 1020 | 2594 | 2213 | 1398 | 2257 | 0.274 |

## Verdict

```
MODELS. `scenario-equal` is the demand-conserving scan that ADVANCES each
   reading over its observation lag; `scenario-equal-original` is the same
   equal split with the pre-correction scan, which schedules every window
   from the instant of the replay however old its reading is. Both are
   scored on the COMMON cohort: every model usable, truth observed.

A. NOT MORE OPTIMISTIC ON TRANSITIONS. On the any-transition cohort,
   lifecycle-balanced: max(paired median signed error of scenario-equal, 0)
   <= max(paired median signed error of current, 0), AND recall of
   scenario-equal >= recall of current. (Positive signed error = predicted
   later than observed = optimistic; a model that is EARLY is not rewarded
   for it, which is why both sides are clamped at 0.)
B. BETTER AT TRANSITIONS. On the same cohort, F1 of scenario-equal >= F1 of
   current.
C. NO SIGNIFICANT OVERALL LOSS. On the overall cohort, the block-bootstrap
   95% CI of F1(scenario-equal) - F1(current) is not entirely below zero
   (p97.5 >= 0). Read from the entry whose BASELINE is the current model.
D. NOT WORSE THAN THE ORIGINAL SCENARIO. On the any-transition common
   cohort, lifecycle-balanced: F1(scenario-equal) >= F1(scenario-equal-
   original), AND the paired median of |error of scenario-equal| - |error
   of scenario-equal-original| <= 0 over the records both models dated.
   Recall of both is printed beside D and is NOT judged: the correction
   can change the ORDER of a class's events, and with it which windows are
   dated before their reset at all, in EITHER direction.

replace = A and B and C and D. keep-scenario = any criterion FALSE.
insufficient-evidence = no criterion false, at least one indeterminate.
The verdict basis is the EQUAL share rule, pre-declared; the headroom rule
is reported beside it and is never the basis.
```

**A. not more optimistic on transitions: FAIL**

| value | number |
|---|---:|
| paired median signed error, scenario-equal (min) | 14.106 |
| paired median signed error, current (min) | -3.643 |
| paired n | 16 |
| recall, scenario-equal | 0.750 |
| recall, current | 0.643 |

**B. better at transitions: PASS**

| value | number |
|---|---:|
| F1, scenario-equal | 0.568 |
| F1, current | 0.474 |

**C. no significant overall loss: PASS**

| value | number |
|---|---:|
| F1 delta p2.5 | -0.007 |
| F1 delta p50 | 0.070 |
| F1 delta p97.5 | 0.145 |
| resamples | 1000 |

**D. not worse than the original scenario: PASS**

| value | number |
|---|---:|
| F1, scenario-equal | 0.568 |
| F1, scenario-equal-original | 0.568 |
| paired median |error| change vs original (min) | 0.000 |
| paired n | 21 |
| recall, scenario-equal | 0.750 |
| recall, scenario-equal-original | 0.750 |

| cohort | records | lifecycles | episodes |
|---|---:|---:|---:|
| Overall | 25200 | 619 | 57 |
| Any transition | 4280 | 171 | 57 |

Coverage of the two equal-split scans: scenario-equal 42975 usable records, scenario-equal-original 42975.

**Verdict: keep-scenario**

PROVISIONAL: the peer-exhaustion (codex), add (codex), upgrade (codex) pairs hold no usable, uncensored weekly record common to all models, and each carries at least one tagged weekly window still pending at the label horizon, so their weekly half is unlabelled. Re-run the reproduce command above with a later `--to` once those windows have reset, and re-read the verdict.

What step 4 does with this:

- `replace`: the scenario becomes the headline runway, with the current model kept beside it for one release.
- `keep-scenario`: the scenario stays a labelled second line and exclusion keeps the headline.
- `insufficient-evidence`: nothing ships; the run repeats when the missing windows have completed.

## Known limits

- Pause and removal cannot be replayed: `usage_snapshots` rows cascade-delete with their account, so no removed account has history, and `accounts.paused` keeps none. The scenario's `presence: "demand-only"` path is covered by its unit tests only.
- Snapshots before 2026-08-24 carry no `plan_tier`/`rate_limit_tier` and no `observed_at`. Tiers there are today's, marked `assumed`; without an observation instant the weekly full-confidence path is unavailable to BOTH models, so the two are still compared like for like.
- No reset-credit bank is modelled, and no live usage point is injected — the replay only has what the sampler stored.
- The headroom share rule is reported, never used as the verdict basis. The verdict basis is the equal split, pre-declared.
- IF a survivor's own lookback already contains the traffic it absorbed, the scenario would be adding that demand a second time. Whether it does is a hypothesis this replay reports on (the peer-exhaustion cohort and the survivor slope table) rather than a property these measurements establish; nothing here corrects for it.
- The observation-lag advance never rewinds the scan clock below the instant being replayed: a window that fills inside its lag dies AT that instant, though the projection it records carries the true, earlier one. Any redistribution such a death causes therefore starts at the instant, not at the fill.
- A reading whose row carries no `observed_at` and whose estimator is the now-anchored lifetime average has no derivable lag and is advanced by nothing. That is a real absence, not a measured zero, and the mechanism section reports those records under `unknown` rather than folding them into the fresh bucket.
- A regression fit that states no ETA — a flat or falling six-hour fit, which an idle account inside a live window produces — has no recoverable anchor either: the fit's anchor is back-solved from the ETA. Such a window is scheduled from the replayed instant in BOTH scans, which is pre-existing behaviour and not something the correction introduced, and the lag-population table counts those records apart from the lags it medians.
- Pending at this run (tag and servable class): peer-exhaustion (codex), add (codex), upgrade (codex). Those pairs hold no usable, uncensored weekly record common to all models, and each carries at least one tagged weekly window still pending at the label horizon, so their weekly half is unlabelled and the verdict is provisional.
- Positive counts (all records, per model) — current: 3686 actual positives of 25200 scored; scenario-equal: 5826 actual positives of 42295 scored; scenario-equal-original: 5826 actual positives of 42295 scored; scenario-headroom: 5826 actual positives of 42295 scored.

## Notes

- Placeholder windows skipped: 233.
- Replay took 10.1 s over 9648 instants; scoring and bootstrap 3.1 s.
- Grid step 10 min; rows loaded 8 days either side of the replay interval.
