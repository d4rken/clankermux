# ClankerMux runway redistribution backtest

Generated: 2026-09-06T17:18:29.927Z

Reproduce with:

```
bun scripts/redistribution-backtest.ts --db=/home/darken/.config/clankermux/clankermux.db --from=2026-07-01T00:00:00Z --to=2026-09-06T00:00:00Z --out=docs/prediction-backtest-redistribution.md --records-out=/tmp/claude-1000/redistribution-records.jsonl
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
| usage_snapshots rows | 193135 |
| accounts | 7 |
| providers | anthropic, codex |
| first sample | 2026-06-02T12:48:00.294Z |
| last sample | 2026-09-06T17:17:37.736Z |
| replay interval | `[2026-07-01T00:00:00.000Z, 2026-09-06T00:00:00.000Z)` |
| grid instants | 9648 |

## Methodology

Fixed-grid joint-roster replay. At every instant of the grid the roster is
rebuilt from recorded snapshots and BOTH models are fed the same window
inputs; nothing reads a row after the instant it is replaying.

- Reading: the newest row per account no older than 10 min (production's projection freshness bar, not the wider display bar). A window whose recorded reset had already passed is dropped, as production's `projectableWindows` does.
- Five-hour prediction: the production OLS over a 6 h lookback, reconstructed WITHOUT the live point (the replay has none). Weekly: no prediction at all, because production emits none — the lifetime average is that window's primary estimator.
- Burn anchors are reconstructed from the revision drops observed up to the instant, and never from later ones. Tiers come from the row's own `plan_tier`/`rate_limit_tier` when it has them (`recorded`), else from today's account row (`assumed`).
- No reset-credit bank is modelled: the credit ledger is not reconstructible per instant, so both models run without it.
- Truth is PER WINDOW, from the same `deriveOutcome` the per-window backtests use: exhausted at the first observed 100 %, survived only on positive evidence, censored otherwise. Placeholder windows (codex's one-sample 5 h artefacts) are skipped.
- Truth-grid membership at a tick is every account of the class with a loaded snapshot on both sides of it (first loaded row ≤ tick ≤ last loaded row). Outside that loaded span, the account is absent. Inside it, a reading older than 10 minutes censors the tick.
- Current model: account-level learning, the strict rule that ships — ONE learning window makes the whole account unprojectable.
- Transition tagging: class-wide, 24 h after the event, except a peer exhaustion whose shadow ends at the dying window's own reset. The dying account is excluded from its own event.
- ETA parity: the current model's beyond-reset ETA is recorded as no prediction, which is the same statement the scenario makes when it projects no exhaustion this cycle.
- Aggregation: the verdict is scored on ONE record per window lifecycle (the median instant), because instants inside one window are not independent draws. Per-record tables are reported beside it.
- Sign convention: signed ETA error is `predicted − observed`, so POSITIVE is predicted-later-than-observed, i.e. OPTIMISTIC.

Verdict rule, declared before the run:

```
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
   (p97.5 >= 0).

replace = A and B and C. keep-scenario = any criterion FALSE.
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
| scenario-equal | 619 | 100.0% | 619 | 0 | 32 | 54 | 518 | 15 | 0.372 | 0.681 | 0.481 | 14.6 | 36.9 | 0.104 |
| scenario-headroom | 619 | 100.0% | 619 | 0 | 23 | 38 | 534 | 24 | 0.377 | 0.489 | 0.426 | 49.1 | 82.7 | 0.139 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-equal | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-headroom | 619 | 0 | 0 | 0 | 0 | 619 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 3 | 1 | 0.750 | -3.6 | 11 |
| current | 30m-2h | 20 | 12 | 0.625 | 0.4 | 35 |
| current | 2h-12h | 0 | 0 | — | — | 3 |
| current | 12h-48h | 3 | 2 | 0.600 | 758.8 | 19 |
| current | >48h | 6 | 0 | 1.000 | -2515.9 | 9 |
| scenario-equal | <30m | 4 | 0 | 1.000 | 1.0 | 7 |
| scenario-equal | 30m-2h | 18 | 14 | 0.563 | 21.0 | 18 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 4 | 1 | 0.800 | 1.8 | 23 |
| scenario-equal | >48h | 6 | 0 | 1.000 | -2196.3 | 6 |
| scenario-headroom | <30m | 4 | 0 | 1.000 | 67.5 | 1 |
| scenario-headroom | 30m-2h | 10 | 22 | 0.313 | 49.1 | 9 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 3 | 2 | 0.600 | 758.8 | 18 |
| scenario-headroom | >48h | 6 | 0 | 1.000 | -1360.3 | 10 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 25200 | 100.0% | 25200 | 0 | 2992 | 7726 | 13788 | 694 | 0.279 | 0.812 | 0.415 | -70.4 | 1205.8 | 0.123 |
| scenario-equal | 25200 | 100.0% | 25200 | 0 | 3148 | 7574 | 13940 | 538 | 0.294 | 0.854 | 0.437 | -401.8 | 1049.7 | 0.110 |
| scenario-headroom | 25200 | 100.0% | 25200 | 0 | 2744 | 6195 | 15319 | 942 | 0.307 | 0.744 | 0.435 | -13.0 | 965.6 | 0.103 |

Paired median signed error (n=27; positive = optimistic): scenario-equal 14.8 min, current -12.4 min.

### Any transition

n: 4280 records, 171 window lifecycles, 57 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 171 | 100.0% | 171 | 0 | 18 | 30 | 113 | 10 | 0.375 | 0.643 | 0.474 | -0.4 | 29.5 | 0.048 |
| scenario-equal | 171 | 100.0% | 171 | 0 | 21 | 25 | 118 | 7 | 0.457 | 0.750 | 0.568 | 14.6 | 53.1 | 0.075 |
| scenario-headroom | 171 | 100.0% | 171 | 0 | 17 | 22 | 121 | 11 | 0.436 | 0.607 | 0.507 | 37.2 | 82.7 | 0.137 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 171 | 0 | 0 | 0 | 0 | 171 |
| scenario-equal | 171 | 0 | 0 | 0 | 0 | 171 |
| scenario-headroom | 171 | 0 | 0 | 0 | 0 | 171 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 3 | 2 | 0.600 | 13.1 | 4 |
| current | 30m-2h | 8 | 6 | 0.571 | 0.4 | 13 |
| current | 2h-12h | 2 | 0 | 1.000 | 50.3 | 2 |
| current | 12h-48h | 1 | 2 | 0.333 | -442.1 | 7 |
| current | >48h | 4 | 0 | 1.000 | -5678.0 | 4 |
| scenario-equal | <30m | 4 | 1 | 0.800 | 1.0 | 4 |
| scenario-equal | 30m-2h | 9 | 5 | 0.643 | 21.0 | 8 |
| scenario-equal | 2h-12h | 2 | 0 | 1.000 | 59.5 | 1 |
| scenario-equal | 12h-48h | 2 | 1 | 0.667 | -758.3 | 10 |
| scenario-equal | >48h | 4 | 0 | 1.000 | -3934.5 | 2 |
| scenario-headroom | <30m | 4 | 1 | 0.800 | 20.1 | 2 |
| scenario-headroom | 30m-2h | 6 | 8 | 0.429 | 37.2 | 7 |
| scenario-headroom | 2h-12h | 2 | 0 | 1.000 | 130.9 | 0 |
| scenario-headroom | 12h-48h | 1 | 2 | 0.333 | -400.3 | 10 |
| scenario-headroom | >48h | 4 | 0 | 1.000 | -1762.8 | 3 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 4280 | 100.0% | 4280 | 0 | 468 | 1490 | 2075 | 247 | 0.239 | 0.655 | 0.350 | -369.8 | 538.5 | 0.083 |
| scenario-equal | 4280 | 100.0% | 4280 | 0 | 588 | 1557 | 2008 | 127 | 0.274 | 0.822 | 0.411 | -321.2 | 636.0 | 0.085 |
| scenario-headroom | 4280 | 100.0% | 4280 | 0 | 482 | 1413 | 2152 | 233 | 0.254 | 0.674 | 0.369 | -134.2 | 721.1 | 0.112 |

Paired median signed error (n=16; positive = optimistic): scenario-equal 14.6 min, current -3.6 min.

### peer-exhaustion

n: 2245 records, 116 window lifecycles, 51 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 116 | 100.0% | 116 | 0 | 14 | 24 | 71 | 7 | 0.368 | 0.667 | 0.475 | -3.6 | 66.9 | 0.052 |
| scenario-equal | 116 | 100.0% | 116 | 0 | 18 | 22 | 73 | 3 | 0.450 | 0.857 | 0.590 | 1.0 | 29.6 | 0.070 |
| scenario-headroom | 116 | 100.0% | 116 | 0 | 16 | 19 | 76 | 5 | 0.457 | 0.762 | 0.571 | 29.2 | 67.5 | 0.111 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 116 | 0 | 0 | 0 | 0 | 116 |
| scenario-equal | 116 | 0 | 0 | 0 | 0 | 116 |
| scenario-headroom | 116 | 0 | 0 | 0 | 0 | 116 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 4 | 2 | 0.667 | 13.1 | 3 |
| current | 30m-2h | 5 | 3 | 0.625 | 15.8 | 8 |
| current | 2h-12h | 0 | 0 | — | — | 3 |
| current | 12h-48h | 1 | 2 | 0.333 | -442.1 | 4 |
| current | >48h | 4 | 0 | 1.000 | -5641.6 | 6 |
| scenario-equal | <30m | 5 | 1 | 0.833 | 20.1 | 5 |
| scenario-equal | 30m-2h | 7 | 1 | 0.875 | 21.0 | 6 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-equal | 12h-48h | 2 | 1 | 0.667 | -758.3 | 5 |
| scenario-equal | >48h | 4 | 0 | 1.000 | -4331.2 | 4 |
| scenario-headroom | <30m | 5 | 1 | 0.833 | 67.5 | 3 |
| scenario-headroom | 30m-2h | 6 | 2 | 0.750 | 37.2 | 7 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 1 | 2 | 0.333 | -400.3 | 3 |
| scenario-headroom | >48h | 4 | 0 | 1.000 | -3292.9 | 6 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 2245 | 100.0% | 2245 | 0 | 321 | 651 | 1137 | 136 | 0.330 | 0.702 | 0.449 | -827.6 | 827.6 | 0.098 |
| scenario-equal | 2245 | 100.0% | 2245 | 0 | 445 | 669 | 1119 | 12 | 0.399 | 0.974 | 0.567 | -540.7 | 618.4 | 0.084 |
| scenario-headroom | 2245 | 100.0% | 2245 | 0 | 363 | 629 | 1159 | 94 | 0.366 | 0.794 | 0.501 | -263.1 | 589.8 | 0.085 |

Paired median signed error (n=14; positive = optimistic): scenario-equal 14.6 min, current -3.6 min.

### add

n: 974 records, 37 window lifecycles, 8 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 37 | 100.0% | 37 | 0 | 3 | 7 | 25 | 2 | 0.300 | 0.600 | 0.400 | 50.3 | 50.3 | 0.005 |
| scenario-equal | 37 | 100.0% | 37 | 0 | 4 | 6 | 26 | 1 | 0.400 | 0.800 | 0.533 | 47.3 | 59.5 | 0.006 |
| scenario-headroom | 37 | 100.0% | 37 | 0 | 4 | 5 | 27 | 1 | 0.444 | 0.800 | 0.571 | 130.9 | 787.8 | 0.078 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 37 | 0 | 0 | 0 | 0 | 37 |
| scenario-equal | 37 | 0 | 0 | 0 | 0 | 37 |
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
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 1 | 0.000 | — | 0 |
| scenario-headroom | 2h-12h | 3 | 0 | 1.000 | 787.8 | 0 |
| scenario-headroom | 12h-48h | 1 | 0 | 1.000 | -1195.8 | 5 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 974 | 100.0% | 974 | 0 | 79 | 260 | 538 | 97 | 0.233 | 0.449 | 0.307 | 74.3 | 84.6 | 0.009 |
| scenario-equal | 974 | 100.0% | 974 | 0 | 159 | 299 | 499 | 17 | 0.347 | 0.903 | 0.502 | 22.4 | 245.4 | 0.024 |
| scenario-headroom | 974 | 100.0% | 974 | 0 | 112 | 220 | 578 | 64 | 0.337 | 0.636 | 0.441 | 202.5 | 821.7 | 0.102 |

Paired median signed error (n=3; positive = optimistic): scenario-equal 59.5 min, current 50.3 min.

### upgrade

n: 23 records, 1 window lifecycles, 2 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1 | 100.0% | 1 | 0 | 0 | 0 | 1 | 0 | — | — | — | — | — | — |
| scenario-equal | 1 | 100.0% | 1 | 0 | 0 | 0 | 1 | 0 | — | — | — | — | — | — |
| scenario-headroom | 1 | 100.0% | 1 | 0 | 0 | 0 | 1 | 0 | — | — | — | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 1 | 0 | 0 | 0 | 0 | 1 |
| scenario-equal | 1 | 0 | 0 | 0 | 0 | 1 |
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
| scenario-headroom | 23 | 100.0% | 23 | 0 | 0 | 0 | 23 | 0 | — | — | — | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

### gift-reset

n: 1714 records, 68 window lifecycles, 20 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 68 | 100.0% | 68 | 0 | 7 | 14 | 42 | 5 | 0.333 | 0.583 | 0.424 | -0.4 | 4.8 | 0.016 |
| scenario-equal | 68 | 100.0% | 68 | 0 | 7 | 11 | 45 | 5 | 0.389 | 0.583 | 0.467 | 21.0 | 53.1 | 0.177 |
| scenario-headroom | 68 | 100.0% | 68 | 0 | 4 | 9 | 47 | 8 | 0.308 | 0.333 | 0.320 | -33.2 | 53.3 | 0.178 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 68 | 0 | 0 | 0 | 0 | 68 |
| scenario-equal | 68 | 0 | 0 | 0 | 0 | 68 |
| scenario-headroom | 68 | 0 | 0 | 0 | 0 | 68 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 1 |
| current | 30m-2h | 6 | 4 | 0.600 | -0.4 | 5 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 1 | 0.000 | — | 7 |
| current | >48h | 1 | 0 | 1.000 | -6519.4 | 1 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 6 | 4 | 0.600 | 21.0 | 3 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-equal | 12h-48h | 0 | 1 | 0.000 | — | 7 |
| scenario-equal | >48h | 1 | 0 | 1.000 | -7011.8 | 0 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 3 | 7 | 0.300 | 53.3 | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-headroom | 12h-48h | 0 | 1 | 0.000 | — | 7 |
| scenario-headroom | >48h | 1 | 0 | 1.000 | -6880.8 | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1714 | 100.0% | 1714 | 0 | 143 | 736 | 733 | 102 | 0.163 | 0.584 | 0.254 | -5260.7 | 5260.7 | 0.522 |
| scenario-equal | 1714 | 100.0% | 1714 | 0 | 140 | 753 | 716 | 105 | 0.157 | 0.571 | 0.246 | -5341.2 | 5332.5 | 0.529 |
| scenario-headroom | 1714 | 100.0% | 1714 | 0 | 113 | 712 | 757 | 132 | 0.137 | 0.461 | 0.211 | -5665.0 | 5665.0 | 0.562 |

Paired median signed error (n=5; positive = optimistic): scenario-equal 21.0 min, current -4.8 min.

### Peer exhaustion by time since death

The scenario adds the dead peer's fill demand on top of a survivor whose own lookback ALREADY contains the traffic it absorbed, so it is expected to read pessimistic the longer the peer has been dead. Disclosed here, not corrected.

Buckets are fine (30 min at the start) because a five-hour window is only 300 minutes long: at the three coarse buckets this replaced, one bucket held a whole five-hour lifecycle. Reported combined and split by window kind, because the two kinds absorb a death on completely different timescales.

#### combined

##### since death 0-30m

n: 308 records, 85 window lifecycles, 49 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 85 | 100.0% | 85 | 0 | 9 | 17 | 50 | 9 | 0.346 | 0.500 | 0.409 | -887.9 | 887.9 | 0.088 |
| scenario-equal | 85 | 100.0% | 85 | 0 | 15 | 26 | 41 | 3 | 0.366 | 0.833 | 0.508 | 7.6 | 63.2 | 0.114 |
| scenario-headroom | 85 | 100.0% | 85 | 0 | 12 | 22 | 45 | 6 | 0.353 | 0.667 | 0.462 | -11.1 | 109.9 | 0.089 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 85 | 0 | 0 | 0 | 0 | 85 |
| scenario-equal | 85 | 0 | 0 | 0 | 0 | 85 |
| scenario-headroom | 85 | 0 | 0 | 0 | 0 | 85 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 2 | 1 | 0.667 | 7.8 | 3 |
| current | 30m-2h | 1 | 5 | 0.167 | 8.2 | 4 |
| current | 2h-12h | 1 | 1 | 0.500 | 70.9 | 2 |
| current | 12h-48h | 2 | 1 | 0.667 | -1780.6 | 4 |
| current | >48h | 3 | 1 | 0.750 | -5878.0 | 4 |
| scenario-equal | <30m | 3 | 0 | 1.000 | 15.7 | 4 |
| scenario-equal | 30m-2h | 4 | 2 | 0.667 | 41.7 | 6 |
| scenario-equal | 2h-12h | 2 | 0 | 1.000 | -11.1 | 8 |
| scenario-equal | 12h-48h | 2 | 1 | 0.667 | -1557.0 | 4 |
| scenario-equal | >48h | 4 | 0 | 1.000 | -4291.2 | 4 |
| scenario-headroom | <30m | 3 | 0 | 1.000 | 69.5 | 2 |
| scenario-headroom | 30m-2h | 2 | 4 | 0.333 | -14.5 | 8 |
| scenario-headroom | 2h-12h | 2 | 0 | 1.000 | -11.1 | 4 |
| scenario-headroom | 12h-48h | 2 | 1 | 0.667 | -895.2 | 2 |
| scenario-headroom | >48h | 3 | 1 | 0.750 | -2712.3 | 6 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 308 | 100.0% | 308 | 0 | 42 | 81 | 160 | 25 | 0.341 | 0.627 | 0.442 | -887.9 | 875.8 | 0.089 |
| scenario-equal | 308 | 100.0% | 308 | 0 | 60 | 103 | 138 | 7 | 0.368 | 0.896 | 0.522 | -9.4 | 87.7 | 0.102 |
| scenario-headroom | 308 | 100.0% | 308 | 0 | 51 | 91 | 150 | 16 | 0.359 | 0.761 | 0.488 | -9.4 | 235.9 | 0.067 |

Paired median signed error (n=9; positive = optimistic): scenario-equal -1075.2 min, current -887.9 min.

##### since death 30-60m

n: 267 records, 77 window lifecycles, 47 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 77 | 100.0% | 77 | 0 | 11 | 21 | 40 | 5 | 0.344 | 0.688 | 0.458 | -36.6 | 53.9 | 0.104 |
| scenario-equal | 77 | 100.0% | 77 | 0 | 14 | 21 | 40 | 2 | 0.400 | 0.875 | 0.549 | 0.3 | 30.6 | 0.102 |
| scenario-headroom | 77 | 100.0% | 77 | 0 | 12 | 16 | 45 | 4 | 0.429 | 0.750 | 0.545 | 0.3 | 111.5 | 0.085 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 77 | 0 | 0 | 0 | 0 | 77 |
| scenario-equal | 77 | 0 | 0 | 0 | 0 | 77 |
| scenario-headroom | 77 | 0 | 0 | 0 | 0 | 77 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 2 | 2 | 0.500 | 25.3 | 3 |
| current | 30m-2h | 4 | 2 | 0.667 | -1.3 | 6 |
| current | 2h-12h | 0 | 0 | — | — | 4 |
| current | 12h-48h | 2 | 0 | 1.000 | -1809.7 | 5 |
| current | >48h | 3 | 1 | 0.750 | -4879.7 | 3 |
| scenario-equal | <30m | 3 | 1 | 0.750 | 3.9 | 5 |
| scenario-equal | 30m-2h | 5 | 1 | 0.833 | 29.6 | 6 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 4 |
| scenario-equal | 12h-48h | 2 | 0 | 1.000 | -1573.7 | 2 |
| scenario-equal | >48h | 4 | 0 | 1.000 | -2518.8 | 4 |
| scenario-headroom | <30m | 2 | 2 | 0.500 | 0.3 | 2 |
| scenario-headroom | 30m-2h | 4 | 2 | 0.667 | 6.9 | 7 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-headroom | 12h-48h | 2 | 0 | 1.000 | -903.2 | 1 |
| scenario-headroom | >48h | 4 | 0 | 1.000 | -2476.7 | 5 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 267 | 100.0% | 267 | 0 | 45 | 73 | 133 | 16 | 0.381 | 0.738 | 0.503 | -1646.3 | 1646.3 | 0.180 |
| scenario-equal | 267 | 100.0% | 267 | 0 | 57 | 78 | 128 | 4 | 0.422 | 0.934 | 0.582 | -1061.0 | 1131.2 | 0.118 |
| scenario-headroom | 267 | 100.0% | 267 | 0 | 50 | 70 | 136 | 11 | 0.417 | 0.820 | 0.552 | -771.9 | 887.4 | 0.116 |

Paired median signed error (n=11; positive = optimistic): scenario-equal 3.9 min, current -36.6 min.

##### since death 1-2h

n: 403 records, 66 window lifecycles, 42 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 66 | 100.0% | 66 | 0 | 13 | 16 | 34 | 3 | 0.448 | 0.813 | 0.578 | -0.5 | 16.6 | 0.053 |
| scenario-equal | 66 | 100.0% | 66 | 0 | 15 | 13 | 37 | 1 | 0.536 | 0.938 | 0.682 | 1.0 | 25.2 | 0.084 |
| scenario-headroom | 66 | 100.0% | 66 | 0 | 14 | 13 | 37 | 2 | 0.519 | 0.875 | 0.651 | 28.0 | 82.7 | 0.130 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 66 | 0 | 0 | 0 | 0 | 66 |
| scenario-equal | 66 | 0 | 0 | 0 | 0 | 66 |
| scenario-headroom | 66 | 0 | 0 | 0 | 0 | 66 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 4 | 0 | 1.000 | -0.5 | 3 |
| current | 30m-2h | 4 | 2 | 0.667 | 15.8 | 7 |
| current | 2h-12h | 0 | 0 | — | — | 1 |
| current | 12h-48h | 0 | 0 | — | — | 3 |
| current | >48h | 5 | 1 | 0.833 | -2561.3 | 2 |
| scenario-equal | <30m | 4 | 0 | 1.000 | 10.9 | 5 |
| scenario-equal | 30m-2h | 5 | 1 | 0.833 | 18.0 | 3 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 4 |
| scenario-equal | >48h | 6 | 0 | 1.000 | -2243.0 | 1 |
| scenario-headroom | <30m | 3 | 1 | 0.750 | 67.5 | 3 |
| scenario-headroom | 30m-2h | 5 | 1 | 0.833 | 36.2 | 5 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-headroom | >48h | 6 | 0 | 1.000 | -1398.7 | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 403 | 100.0% | 403 | 0 | 83 | 105 | 199 | 16 | 0.441 | 0.838 | 0.578 | -815.6 | 815.6 | 0.092 |
| scenario-equal | 403 | 100.0% | 403 | 0 | 98 | 105 | 199 | 1 | 0.483 | 0.990 | 0.649 | -1096.6 | 1084.9 | 0.114 |
| scenario-headroom | 403 | 100.0% | 403 | 0 | 97 | 92 | 212 | 2 | 0.513 | 0.980 | 0.674 | -23.2 | 615.4 | 0.130 |

Paired median signed error (n=13; positive = optimistic): scenario-equal 1.0 min, current -0.5 min.

##### since death 2-3h

n: 198 records, 42 window lifecycles, 27 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 42 | 100.0% | 42 | 0 | 4 | 9 | 27 | 2 | 0.308 | 0.667 | 0.421 | -5736.9 | 2538.2 | 0.252 |
| scenario-equal | 42 | 100.0% | 42 | 0 | 6 | 8 | 28 | 0 | 0.429 | 1.000 | 0.600 | -2187.0 | 2142.4 | 0.213 |
| scenario-headroom | 42 | 100.0% | 42 | 0 | 6 | 5 | 31 | 0 | 0.545 | 1.000 | 0.706 | -1233.4 | 1172.4 | 0.116 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 42 | 0 | 0 | 0 | 0 | 42 |
| scenario-equal | 42 | 0 | 0 | 0 | 0 | 42 |
| scenario-headroom | 42 | 0 | 0 | 0 | 0 | 42 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 1 | 0.000 | — | 3 |
| current | 30m-2h | 0 | 0 | — | — | 2 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 1 | 0.000 | — | 2 |
| current | >48h | 4 | 0 | 1.000 | -5736.9 | 2 |
| scenario-equal | <30m | 1 | 0 | 1.000 | 1.7 | 2 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 1 | 0 | 1.000 | -1233.4 | 4 |
| scenario-equal | >48h | 4 | 0 | 1.000 | -3459.4 | 1 |
| scenario-headroom | <30m | 1 | 0 | 1.000 | 1.7 | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 1 | 0 | 1.000 | -1233.4 | 3 |
| scenario-headroom | >48h | 4 | 0 | 1.000 | -3401.4 | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 198 | 100.0% | 198 | 0 | 32 | 45 | 114 | 7 | 0.416 | 0.821 | 0.552 | -5611.4 | 5589.1 | 0.554 |
| scenario-equal | 198 | 100.0% | 198 | 0 | 39 | 45 | 114 | 0 | 0.464 | 1.000 | 0.634 | -2187.0 | 2187.0 | 0.217 |
| scenario-headroom | 198 | 100.0% | 198 | 0 | 39 | 38 | 121 | 0 | 0.506 | 1.000 | 0.672 | -1246.0 | 1246.0 | 0.124 |

Paired median signed error (n=4; positive = optimistic): scenario-equal -3459.4 min, current -5736.9 min.

##### since death 3-4h

n: 85 records, 17 window lifecycles, 15 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 17 | 100.0% | 17 | 0 | 3 | 3 | 10 | 1 | 0.500 | 0.750 | 0.600 | -5594.0 | 5594.0 | 0.555 |
| scenario-equal | 17 | 100.0% | 17 | 0 | 4 | 3 | 10 | 0 | 0.571 | 1.000 | 0.727 | -3811.0 | 2164.9 | 0.215 |
| scenario-headroom | 17 | 100.0% | 17 | 0 | 4 | 3 | 10 | 0 | 0.571 | 1.000 | 0.727 | -3784.8 | 1158.2 | 0.115 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-equal | 17 | 0 | 0 | 0 | 0 | 17 |
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
| scenario-headroom | 85 | 100.0% | 85 | 0 | 18 | 21 | 46 | 0 | 0.462 | 1.000 | 0.632 | -1158.2 | 1145.7 | 0.114 |

Paired median signed error (n=3; positive = optimistic): scenario-equal -3811.0 min, current -5594.0 min.

##### since death 4-6h

n: 144 records, 16 window lifecycles, 9 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 16 | 100.0% | 16 | 0 | 2 | 5 | 8 | 1 | 0.286 | 0.667 | 0.400 | -2406.5 | 2140.4 | 0.212 |
| scenario-equal | 16 | 100.0% | 16 | 0 | 3 | 4 | 9 | 0 | 0.429 | 1.000 | 0.600 | -1916.7 | 1916.7 | 0.190 |
| scenario-headroom | 16 | 100.0% | 16 | 0 | 3 | 4 | 9 | 0 | 0.429 | 1.000 | 0.600 | -986.9 | 986.9 | 0.098 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 16 | 0 | 0 | 0 | 0 | 16 |
| scenario-equal | 16 | 0 | 0 | 0 | 0 | 16 |
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
| scenario-headroom | 144 | 100.0% | 144 | 0 | 28 | 42 | 74 | 0 | 0.400 | 1.000 | 0.571 | -537.6 | 688.5 | 0.068 |

Paired median signed error (n=2; positive = optimistic): scenario-equal -2037.8 min, current -2406.5 min.

##### since death 6-12h

n: 328 records, 18 window lifecycles, 12 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 18 | 100.0% | 18 | 0 | 1 | 4 | 12 | 1 | 0.200 | 0.500 | 0.286 | -369.8 | 369.8 | 0.037 |
| scenario-equal | 18 | 100.0% | 18 | 0 | 2 | 4 | 12 | 0 | 0.333 | 1.000 | 0.500 | -688.4 | 289.3 | 0.029 |
| scenario-headroom | 18 | 100.0% | 18 | 0 | 1 | 4 | 12 | 1 | 0.200 | 0.500 | 0.286 | -325.4 | 325.4 | 0.032 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-equal | 18 | 0 | 0 | 0 | 0 | 18 |
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
| scenario-headroom | 328 | 100.0% | 328 | 0 | 42 | 124 | 157 | 5 | 0.253 | 0.894 | 0.394 | -337.9 | 325.4 | 0.032 |

Paired median signed error (n=1; positive = optimistic): scenario-equal -688.4 min, current -369.8 min.

##### since death 12-24h

n: 512 records, 24 window lifecycles, 11 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 24 | 100.0% | 24 | 0 | 2 | 5 | 16 | 1 | 0.286 | 0.667 | 0.400 | 109.2 | 109.2 | 0.011 |
| scenario-equal | 24 | 100.0% | 24 | 0 | 3 | 5 | 16 | 0 | 0.375 | 1.000 | 0.545 | 27.5 | 82.2 | 0.008 |
| scenario-headroom | 24 | 100.0% | 24 | 0 | 2 | 5 | 16 | 1 | 0.286 | 0.667 | 0.400 | 464.2 | 464.2 | 0.046 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 24 | 0 | 0 | 0 | 0 | 24 |
| scenario-equal | 24 | 0 | 0 | 0 | 0 | 24 |
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
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-headroom | 2h-12h | 2 | 0 | 1.000 | 464.2 | 1 |
| scenario-headroom | 12h-48h | 0 | 1 | 0.000 | — | 1 |
| scenario-headroom | >48h | 0 | 0 | — | — | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 512 | 100.0% | 512 | 0 | 38 | 152 | 262 | 60 | 0.200 | 0.388 | 0.264 | -33.5 | 151.3 | 0.015 |
| scenario-equal | 512 | 100.0% | 512 | 0 | 98 | 151 | 263 | 0 | 0.394 | 1.000 | 0.565 | -97.7 | 125.3 | 0.012 |
| scenario-headroom | 512 | 100.0% | 512 | 0 | 38 | 151 | 263 | 60 | 0.201 | 0.388 | 0.265 | 425.8 | 425.8 | 0.042 |

Paired median signed error (n=2; positive = optimistic): scenario-equal -82.2 min, current 109.2 min.

#### five_hour

##### since death 0-30m

n: 180 records, 58 window lifecycles, 47 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 58 | 100.0% | 58 | 0 | 2 | 7 | 42 | 7 | 0.222 | 0.222 | 0.222 | 7.8 | 7.8 | 0.026 |
| scenario-equal | 58 | 100.0% | 58 | 0 | 7 | 16 | 33 | 2 | 0.304 | 0.778 | 0.438 | 15.7 | 15.7 | 0.052 |
| scenario-headroom | 58 | 100.0% | 58 | 0 | 5 | 14 | 35 | 4 | 0.263 | 0.556 | 0.357 | 39.2 | 39.2 | 0.131 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 58 | 0 | 0 | 0 | 0 | 58 |
| scenario-equal | 58 | 0 | 0 | 0 | 0 | 58 |
| scenario-headroom | 58 | 0 | 0 | 0 | 0 | 58 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 1 | 1 | 0.500 | 7.8 | 3 |
| current | 30m-2h | 1 | 5 | 0.167 | 8.2 | 4 |
| current | 2h-12h | 0 | 1 | 0.000 | — | 0 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 2 | 0 | 1.000 | 7.6 | 4 |
| scenario-equal | 30m-2h | 4 | 2 | 0.667 | 41.7 | 6 |
| scenario-equal | 2h-12h | 1 | 0 | 1.000 | -11.1 | 6 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 2 | 0 | 1.000 | 39.2 | 2 |
| scenario-headroom | 30m-2h | 2 | 4 | 0.333 | -14.5 | 8 |
| scenario-headroom | 2h-12h | 1 | 0 | 1.000 | -11.1 | 4 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 180 | 100.0% | 180 | 0 | 4 | 34 | 125 | 17 | 0.105 | 0.190 | 0.136 | 8.2 | 8.2 | 0.027 |
| scenario-equal | 180 | 100.0% | 180 | 0 | 16 | 53 | 106 | 5 | 0.232 | 0.762 | 0.356 | 20.1 | 20.1 | 0.067 |
| scenario-headroom | 180 | 100.0% | 180 | 0 | 10 | 49 | 110 | 11 | 0.169 | 0.476 | 0.250 | 20.1 | 20.1 | 0.067 |

Paired median signed error (n=2; positive = optimistic): scenario-equal 7.6 min, current 7.8 min.

##### since death 30-60m

n: 161 records, 54 window lifecycles, 46 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 54 | 100.0% | 54 | 0 | 5 | 11 | 34 | 4 | 0.313 | 0.556 | 0.400 | 14.9 | 25.3 | 0.084 |
| scenario-equal | 54 | 100.0% | 54 | 0 | 7 | 12 | 33 | 2 | 0.368 | 0.778 | 0.500 | 6.9 | 17.5 | 0.058 |
| scenario-headroom | 54 | 100.0% | 54 | 0 | 5 | 9 | 36 | 4 | 0.357 | 0.556 | 0.435 | 3.9 | 6.9 | 0.023 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 54 | 0 | 0 | 0 | 0 | 54 |
| scenario-equal | 54 | 0 | 0 | 0 | 0 | 54 |
| scenario-headroom | 54 | 0 | 0 | 0 | 0 | 54 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 2 | 2 | 0.500 | 25.3 | 3 |
| current | 30m-2h | 3 | 2 | 0.600 | -1.3 | 6 |
| current | 2h-12h | 0 | 0 | — | — | 2 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 3 | 1 | 0.750 | 3.9 | 5 |
| scenario-equal | 30m-2h | 4 | 1 | 0.800 | 6.9 | 6 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 2 | 2 | 0.500 | 0.3 | 2 |
| scenario-headroom | 30m-2h | 3 | 2 | 0.600 | 6.9 | 7 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 161 | 100.0% | 161 | 0 | 14 | 35 | 102 | 10 | 0.286 | 0.583 | 0.384 | 15.7 | 16.9 | 0.056 |
| scenario-equal | 161 | 100.0% | 161 | 0 | 20 | 40 | 97 | 4 | 0.333 | 0.833 | 0.476 | 6.5 | 14.8 | 0.049 |
| scenario-headroom | 161 | 100.0% | 161 | 0 | 14 | 34 | 103 | 10 | 0.292 | 0.583 | 0.389 | 0.9 | 7.5 | 0.025 |

Paired median signed error (n=5; positive = optimistic): scenario-equal 17.5 min, current 14.9 min.

##### since death 1-2h

n: 230 records, 48 window lifecycles, 41 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 48 | 100.0% | 48 | 0 | 7 | 11 | 28 | 2 | 0.389 | 0.778 | 0.519 | 10.0 | 10.0 | 0.033 |
| scenario-equal | 48 | 100.0% | 48 | 0 | 8 | 8 | 31 | 1 | 0.500 | 0.889 | 0.640 | 14.6 | 15.3 | 0.051 |
| scenario-headroom | 48 | 100.0% | 48 | 0 | 7 | 8 | 31 | 2 | 0.467 | 0.778 | 0.583 | 49.1 | 49.1 | 0.164 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 48 | 0 | 0 | 0 | 0 | 48 |
| scenario-equal | 48 | 0 | 0 | 0 | 0 | 48 |
| scenario-headroom | 48 | 0 | 0 | 0 | 0 | 48 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 4 | 0 | 1.000 | -0.5 | 3 |
| current | 30m-2h | 3 | 2 | 0.600 | 15.8 | 7 |
| current | 2h-12h | 0 | 0 | — | — | 1 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 4 | 0 | 1.000 | 10.9 | 5 |
| scenario-equal | 30m-2h | 4 | 1 | 0.800 | 14.6 | 3 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 3 | 1 | 0.750 | 67.5 | 3 |
| scenario-headroom | 30m-2h | 4 | 1 | 0.800 | 28.0 | 5 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 230 | 100.0% | 230 | 0 | 26 | 55 | 140 | 9 | 0.321 | 0.743 | 0.448 | 8.2 | 9.2 | 0.031 |
| scenario-equal | 230 | 100.0% | 230 | 0 | 34 | 48 | 147 | 1 | 0.415 | 0.971 | 0.581 | 12.4 | 15.4 | 0.051 |
| scenario-headroom | 230 | 100.0% | 230 | 0 | 33 | 35 | 160 | 2 | 0.485 | 0.943 | 0.641 | 37.2 | 37.2 | 0.124 |

Paired median signed error (n=7; positive = optimistic): scenario-equal 14.6 min, current 10.0 min.

##### since death 2-3h

n: 106 records, 28 window lifecycles, 25 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 28 | 100.0% | 28 | 0 | 0 | 5 | 22 | 1 | 0.000 | 0.000 | 0.000 | — | — | — |
| scenario-equal | 28 | 100.0% | 28 | 0 | 1 | 3 | 24 | 0 | 0.250 | 1.000 | 0.400 | 1.7 | 1.7 | 0.006 |
| scenario-headroom | 28 | 100.0% | 28 | 0 | 1 | 0 | 27 | 0 | 1.000 | 1.000 | 1.000 | 1.7 | 1.7 | 0.006 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 28 | 0 | 0 | 0 | 0 | 28 |
| scenario-equal | 28 | 0 | 0 | 0 | 0 | 28 |
| scenario-headroom | 28 | 0 | 0 | 0 | 0 | 28 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 1 | 0.000 | — | 3 |
| current | 30m-2h | 0 | 0 | — | — | 2 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 1 | 0 | 1.000 | 1.7 | 2 |
| scenario-equal | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 1 | 0 | 1.000 | 1.7 | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 106 | 100.0% | 106 | 0 | 1 | 13 | 91 | 1 | 0.071 | 0.500 | 0.125 | -5.5 | 5.5 | 0.018 |
| scenario-equal | 106 | 100.0% | 106 | 0 | 2 | 7 | 97 | 0 | 0.222 | 1.000 | 0.364 | -5.4 | 1.7 | 0.006 |
| scenario-headroom | 106 | 100.0% | 106 | 0 | 2 | 0 | 104 | 0 | 1.000 | 1.000 | 1.000 | -5.4 | 1.7 | 0.006 |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

##### since death 3-4h

n: 46 records, 10 window lifecycles, 12 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-equal | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-headroom | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal | 10 | 0 | 0 | 0 | 0 | 10 |
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
| scenario-headroom | 46 | 100.0% | 46 | 0 | 0 | 0 | 46 | 0 | — | — | — | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

##### since death 4-6h

n: 76 records, 10 window lifecycles, 9 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 10 | 100.0% | 10 | 0 | 0 | 2 | 8 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 10 | 100.0% | 10 | 0 | 0 | 1 | 9 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 10 | 100.0% | 10 | 0 | 0 | 1 | 9 | 0 | 0.000 | — | 0.000 | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal | 10 | 0 | 0 | 0 | 0 | 10 |
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
| scenario-headroom | 76 | 100.0% | 76 | 0 | 0 | 2 | 74 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

##### since death 6-12h

n: 162 records, 12 window lifecycles, 9 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 12 | 100.0% | 12 | 0 | 0 | 0 | 12 | 0 | — | — | — | — | — | — |
| scenario-equal | 12 | 100.0% | 12 | 0 | 0 | 0 | 12 | 0 | — | — | — | — | — | — |
| scenario-headroom | 12 | 100.0% | 12 | 0 | 0 | 0 | 12 | 0 | — | — | — | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 12 | 0 | 0 | 0 | 0 | 12 |
| scenario-equal | 12 | 0 | 0 | 0 | 0 | 12 |
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
| scenario-headroom | 162 | 100.0% | 162 | 0 | 0 | 5 | 157 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

##### since death 12-24h

n: 266 records, 17 window lifecycles, 11 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 17 | 100.0% | 17 | 0 | 0 | 1 | 16 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 17 | 100.0% | 17 | 0 | 0 | 1 | 16 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 17 | 100.0% | 17 | 0 | 0 | 1 | 16 | 0 | 0.000 | — | 0.000 | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-equal | 17 | 0 | 0 | 0 | 0 | 17 |
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
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 266 | 100.0% | 266 | 0 | 0 | 4 | 262 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 266 | 100.0% | 266 | 0 | 0 | 3 | 263 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 266 | 100.0% | 266 | 0 | 0 | 3 | 263 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

#### seven_day

##### since death 0-30m

n: 128 records, 27 window lifecycles, 34 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 27 | 100.0% | 27 | 0 | 7 | 10 | 8 | 2 | 0.412 | 0.778 | 0.538 | -1737.3 | 1737.3 | 0.172 |
| scenario-equal | 27 | 100.0% | 27 | 0 | 8 | 10 | 8 | 1 | 0.444 | 0.889 | 0.593 | -1145.2 | 1145.2 | 0.114 |
| scenario-headroom | 27 | 100.0% | 27 | 0 | 7 | 8 | 10 | 2 | 0.467 | 0.778 | 0.583 | -895.2 | 895.2 | 0.089 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 27 | 0 | 0 | 0 | 0 | 27 |
| scenario-equal | 27 | 0 | 0 | 0 | 0 | 27 |
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
| scenario-equal | 2h-12h | 1 | 0 | 1.000 | 44.6 | 2 |
| scenario-equal | 12h-48h | 2 | 1 | 0.667 | -1557.0 | 4 |
| scenario-equal | >48h | 4 | 0 | 1.000 | -4291.2 | 4 |
| scenario-headroom | <30m | 1 | 0 | 1.000 | 246.3 | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 1 | 0 | 1.000 | 109.9 | 0 |
| scenario-headroom | 12h-48h | 2 | 1 | 0.667 | -895.2 | 2 |
| scenario-headroom | >48h | 3 | 1 | 0.750 | -2712.3 | 6 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 128 | 100.0% | 128 | 0 | 38 | 47 | 35 | 8 | 0.447 | 0.826 | 0.580 | -983.2 | 899.9 | 0.089 |
| scenario-equal | 128 | 100.0% | 128 | 0 | 44 | 50 | 32 | 2 | 0.468 | 0.957 | 0.629 | -995.8 | 1075.2 | 0.107 |
| scenario-headroom | 128 | 100.0% | 128 | 0 | 41 | 42 | 40 | 5 | 0.494 | 0.891 | 0.636 | -187.4 | 614.6 | 0.061 |

Paired median signed error (n=7; positive = optimistic): scenario-equal -1145.2 min, current -1737.3 min.

##### since death 30-60m

n: 106 records, 23 window lifecycles, 32 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 23 | 100.0% | 23 | 0 | 6 | 10 | 6 | 1 | 0.375 | 0.857 | 0.522 | -1907.7 | 1809.7 | 0.180 |
| scenario-equal | 23 | 100.0% | 23 | 0 | 7 | 9 | 7 | 0 | 0.438 | 1.000 | 0.609 | -1318.0 | 1318.0 | 0.131 |
| scenario-headroom | 23 | 100.0% | 23 | 0 | 7 | 7 | 9 | 0 | 0.500 | 1.000 | 0.667 | -903.2 | 1363.2 | 0.135 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 23 | 0 | 0 | 0 | 0 | 23 |
| scenario-equal | 23 | 0 | 0 | 0 | 0 | 23 |
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
| scenario-equal | >48h | 4 | 0 | 1.000 | -2518.8 | 4 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 1 | 0 | 1.000 | 111.5 | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-headroom | 12h-48h | 2 | 0 | 1.000 | -903.2 | 1 |
| scenario-headroom | >48h | 4 | 0 | 1.000 | -2476.7 | 5 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 106 | 100.0% | 106 | 0 | 31 | 38 | 31 | 6 | 0.449 | 0.838 | 0.585 | -2069.2 | 2069.2 | 0.205 |
| scenario-equal | 106 | 100.0% | 106 | 0 | 37 | 38 | 31 | 0 | 0.493 | 1.000 | 0.661 | -1573.7 | 1573.7 | 0.156 |
| scenario-headroom | 106 | 100.0% | 106 | 0 | 36 | 36 | 33 | 1 | 0.500 | 0.973 | 0.661 | -1346.2 | 1358.7 | 0.135 |

Paired median signed error (n=6; positive = optimistic): scenario-equal -1573.7 min, current -1907.7 min.

##### since death 1-2h

n: 173 records, 18 window lifecycles, 30 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 18 | 100.0% | 18 | 0 | 6 | 5 | 6 | 1 | 0.545 | 0.857 | 0.667 | -2561.3 | 2090.4 | 0.207 |
| scenario-equal | 18 | 100.0% | 18 | 0 | 7 | 5 | 6 | 0 | 0.583 | 1.000 | 0.737 | -2164.0 | 2164.0 | 0.215 |
| scenario-headroom | 18 | 100.0% | 18 | 0 | 7 | 5 | 6 | 0 | 0.583 | 1.000 | 0.737 | -1308.6 | 1308.6 | 0.130 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-equal | 18 | 0 | 0 | 0 | 0 | 18 |
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
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 1 | 0 | 1.000 | 180.5 | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-headroom | >48h | 6 | 0 | 1.000 | -1398.7 | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 173 | 100.0% | 173 | 0 | 57 | 50 | 59 | 7 | 0.533 | 0.891 | 0.667 | -2545.2 | 2545.2 | 0.252 |
| scenario-equal | 173 | 100.0% | 173 | 0 | 64 | 57 | 52 | 0 | 0.529 | 1.000 | 0.692 | -2243.0 | 2210.0 | 0.219 |
| scenario-headroom | 173 | 100.0% | 173 | 0 | 64 | 57 | 52 | 0 | 0.529 | 1.000 | 0.692 | -1308.6 | 1308.6 | 0.130 |

Paired median signed error (n=6; positive = optimistic): scenario-equal -2243.0 min, current -2561.3 min.

##### since death 2-3h

n: 92 records, 14 window lifecycles, 24 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 14 | 100.0% | 14 | 0 | 4 | 4 | 5 | 1 | 0.500 | 0.800 | 0.615 | -5736.9 | 2538.2 | 0.252 |
| scenario-equal | 14 | 100.0% | 14 | 0 | 5 | 5 | 4 | 0 | 0.500 | 1.000 | 0.667 | -2187.0 | 2187.0 | 0.217 |
| scenario-headroom | 14 | 100.0% | 14 | 0 | 5 | 5 | 4 | 0 | 0.500 | 1.000 | 0.667 | -1233.4 | 1233.4 | 0.122 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 14 | 0 | 0 | 0 | 0 | 14 |
| scenario-equal | 14 | 0 | 0 | 0 | 0 | 14 |
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
| scenario-headroom | 92 | 100.0% | 92 | 0 | 37 | 38 | 17 | 0 | 0.493 | 1.000 | 0.661 | -1258.5 | 1258.5 | 0.125 |

Paired median signed error (n=4; positive = optimistic): scenario-equal -3459.4 min, current -5736.9 min.

##### since death 3-4h

n: 39 records, 7 window lifecycles, 15 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 7 | 100.0% | 7 | 0 | 3 | 3 | 0 | 1 | 0.500 | 0.750 | 0.600 | -5594.0 | 5594.0 | 0.555 |
| scenario-equal | 7 | 100.0% | 7 | 0 | 4 | 3 | 0 | 0 | 0.571 | 1.000 | 0.727 | -3811.0 | 2164.9 | 0.215 |
| scenario-headroom | 7 | 100.0% | 7 | 0 | 4 | 3 | 0 | 0 | 0.571 | 1.000 | 0.727 | -3784.8 | 1158.2 | 0.115 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-equal | 7 | 0 | 0 | 0 | 0 | 7 |
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
| scenario-headroom | 39 | 100.0% | 39 | 0 | 18 | 21 | 0 | 0 | 0.462 | 1.000 | 0.632 | -1158.2 | 1145.7 | 0.114 |

Paired median signed error (n=3; positive = optimistic): scenario-equal -3811.0 min, current -5594.0 min.

##### since death 4-6h

n: 68 records, 6 window lifecycles, 9 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 6 | 100.0% | 6 | 0 | 2 | 3 | 0 | 1 | 0.400 | 0.667 | 0.500 | -2406.5 | 2140.4 | 0.212 |
| scenario-equal | 6 | 100.0% | 6 | 0 | 3 | 3 | 0 | 0 | 0.500 | 1.000 | 0.667 | -1916.7 | 1916.7 | 0.190 |
| scenario-headroom | 6 | 100.0% | 6 | 0 | 3 | 3 | 0 | 0 | 0.500 | 1.000 | 0.667 | -986.9 | 986.9 | 0.098 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-equal | 6 | 0 | 0 | 0 | 0 | 6 |
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
| scenario-headroom | 68 | 100.0% | 68 | 0 | 28 | 40 | 0 | 0 | 0.412 | 1.000 | 0.583 | -537.6 | 688.5 | 0.068 |

Paired median signed error (n=2; positive = optimistic): scenario-equal -2037.8 min, current -2406.5 min.

##### since death 6-12h

n: 166 records, 6 window lifecycles, 12 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 6 | 100.0% | 6 | 0 | 1 | 4 | 0 | 1 | 0.200 | 0.500 | 0.286 | -369.8 | 369.8 | 0.037 |
| scenario-equal | 6 | 100.0% | 6 | 0 | 2 | 4 | 0 | 0 | 0.333 | 1.000 | 0.500 | -688.4 | 289.3 | 0.029 |
| scenario-headroom | 6 | 100.0% | 6 | 0 | 1 | 4 | 0 | 1 | 0.200 | 0.500 | 0.286 | -325.4 | 325.4 | 0.032 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-equal | 6 | 0 | 0 | 0 | 0 | 6 |
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
| scenario-headroom | 166 | 100.0% | 166 | 0 | 42 | 119 | 0 | 5 | 0.261 | 0.894 | 0.404 | -337.9 | 325.4 | 0.032 |

Paired median signed error (n=1; positive = optimistic): scenario-equal -688.4 min, current -369.8 min.

##### since death 12-24h

n: 246 records, 7 window lifecycles, 11 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 7 | 100.0% | 7 | 0 | 2 | 4 | 0 | 1 | 0.333 | 0.667 | 0.444 | 109.2 | 109.2 | 0.011 |
| scenario-equal | 7 | 100.0% | 7 | 0 | 3 | 4 | 0 | 0 | 0.429 | 1.000 | 0.600 | 27.5 | 82.2 | 0.008 |
| scenario-headroom | 7 | 100.0% | 7 | 0 | 2 | 4 | 0 | 1 | 0.333 | 0.667 | 0.444 | 464.2 | 464.2 | 0.046 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-equal | 7 | 0 | 0 | 0 | 0 | 7 |
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
| scenario-headroom | 246 | 100.0% | 246 | 0 | 38 | 148 | 0 | 60 | 0.204 | 0.388 | 0.268 | 425.8 | 425.8 | 0.042 |

Paired median signed error (n=2; positive = optimistic): scenario-equal -82.2 min, current 109.2 min.

### Survivor slope trajectory after a death

The survivor's OWN fitted burn slope, expressed against its slope just after the peer died: `slope(t) / slope(t_death+)`. Above 1 means the inherited traffic has already entered the survivor's lookback, which is exactly the demand the scenario then adds a second time; near 1 means it has not arrived yet.

Median within a (window lifecycle × death) first, then across them, so a lifecycle that happens to be sampled more often does not outvote one that is not. `t_death+` is the earliest instant at or after the death that has a fitted slope at all, not the literal first instant: a survivor is often still learning when its peer dies, and requiring a slope there would discard the lifecycles this table is about. Instants with no slope enter no bucket, and a lifecycle whose baseline slope is zero is dropped rather than imputed.

Unlike the scored buckets above, this table reads every peer-exhaustion instant of the replay, not only the ones where all three models are comparable and the window's fate was observed. The slope belongs to the survivor's own reading, so a model abstaining or an unobserved outcome is no reason to move the baseline off the earliest post-death reading there is.

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
| scenario-equal | 548 | 100.0% | 548 | 0 | 21 | 24 | 489 | 14 | 0.467 | 0.600 | 0.525 | 15.6 | 23.7 | 0.079 |
| scenario-headroom | 548 | 100.0% | 548 | 0 | 13 | 10 | 503 | 22 | 0.565 | 0.371 | 0.448 | 53.3 | 53.3 | 0.178 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 548 | 0 | 0 | 0 | 0 | 548 |
| scenario-equal | 548 | 0 | 0 | 0 | 0 | 548 |
| scenario-headroom | 548 | 0 | 0 | 0 | 0 | 548 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 3 | 1 | 0.750 | -3.6 | 11 |
| current | 30m-2h | 19 | 12 | 0.613 | 0.4 | 34 |
| current | 2h-12h | 0 | 0 | — | — | 1 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 4 | 0 | 1.000 | 1.0 | 7 |
| scenario-equal | 30m-2h | 17 | 14 | 0.548 | 21.0 | 17 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 4 | 0 | 1.000 | 67.5 | 1 |
| scenario-headroom | 30m-2h | 9 | 22 | 0.290 | 52.3 | 9 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 10515 | 100.0% | 10515 | 0 | 236 | 928 | 9215 | 136 | 0.203 | 0.634 | 0.307 | 0.2 | 15.6 | 0.052 |
| scenario-equal | 10515 | 100.0% | 10515 | 0 | 200 | 446 | 9697 | 172 | 0.310 | 0.538 | 0.393 | 15.4 | 21.6 | 0.072 |
| scenario-headroom | 10515 | 100.0% | 10515 | 0 | 122 | 263 | 9880 | 250 | 0.317 | 0.328 | 0.322 | 58.2 | 58.2 | 0.194 |

Paired median signed error (n=17; positive = optimistic): scenario-equal 15.6 min, current -3.6 min.

#### anthropic/seven_day

n: 9472 records, 38 window lifecycles, 38 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 38 | 100.0% | 38 | 0 | 7 | 18 | 11 | 2 | 0.280 | 0.778 | 0.412 | -2031.1 | 2031.1 | 0.202 |
| scenario-equal | 38 | 100.0% | 38 | 0 | 8 | 17 | 12 | 1 | 0.320 | 0.889 | 0.471 | -1835.7 | 1417.9 | 0.141 |
| scenario-headroom | 38 | 100.0% | 38 | 0 | 7 | 16 | 13 | 2 | 0.304 | 0.778 | 0.438 | -954.1 | 954.1 | 0.095 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 38 | 0 | 0 | 0 | 0 | 38 |
| scenario-equal | 38 | 0 | 0 | 0 | 0 | 38 |
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
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 1 | 2 | 0.333 | -954.1 | 11 |
| scenario-headroom | >48h | 6 | 0 | 1.000 | -1360.3 | 5 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 9472 | 100.0% | 9472 | 0 | 2159 | 4774 | 2149 | 390 | 0.311 | 0.847 | 0.455 | -1055.5 | 1309.6 | 0.130 |
| scenario-equal | 9472 | 100.0% | 9472 | 0 | 2351 | 5113 | 1810 | 198 | 0.315 | 0.922 | 0.470 | -941.6 | 1071.5 | 0.106 |
| scenario-headroom | 9472 | 100.0% | 9472 | 0 | 2025 | 3938 | 2985 | 524 | 0.340 | 0.794 | 0.476 | -525.0 | 911.1 | 0.090 |

Paired median signed error (n=7; positive = optimistic): scenario-equal -1835.7 min, current -2031.1 min.

#### codex/five_hour

n: 217 records, 13 window lifecycles, 2 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 13 | 100.0% | 13 | 0 | 1 | 1 | 11 | 0 | 0.500 | 1.000 | 0.667 | 35.6 | 35.6 | 0.119 |
| scenario-equal | 13 | 100.0% | 13 | 0 | 1 | 1 | 11 | 0 | 0.500 | 1.000 | 0.667 | 36.9 | 36.9 | 0.123 |
| scenario-headroom | 13 | 100.0% | 13 | 0 | 1 | 0 | 12 | 0 | 1.000 | 1.000 | 1.000 | 36.9 | 36.9 | 0.123 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 13 | 0 | 0 | 0 | 0 | 13 |
| scenario-equal | 13 | 0 | 0 | 0 | 0 | 13 |
| scenario-headroom | 13 | 0 | 0 | 0 | 0 | 13 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 1 | 0 | 1.000 | 35.6 | 1 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 1 | 0 | 1.000 | 36.9 | 1 |
| scenario-equal | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-equal | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-equal | >48h | 0 | 0 | — | — | 0 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 1 | 0 | 1.000 | 36.9 | 0 |
| scenario-headroom | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-headroom | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-headroom | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 217 | 100.0% | 217 | 0 | 18 | 33 | 166 | 0 | 0.353 | 1.000 | 0.522 | -0.9 | 15.0 | 0.050 |
| scenario-equal | 217 | 100.0% | 217 | 0 | 18 | 25 | 174 | 0 | 0.419 | 1.000 | 0.590 | 1.4 | 15.4 | 0.051 |
| scenario-headroom | 217 | 100.0% | 217 | 0 | 18 | 4 | 195 | 0 | 0.818 | 1.000 | 0.900 | 1.4 | 15.4 | 0.051 |

Paired median signed error (n=1; positive = optimistic): scenario-equal 36.9 min, current 35.6 min.

#### codex/seven_day

n: 4996 records, 20 window lifecycles, 2 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 20 | 100.0% | 20 | 0 | 2 | 12 | 6 | 0 | 0.143 | 1.000 | 0.250 | 758.8 | 758.8 | 0.075 |
| scenario-equal | 20 | 100.0% | 20 | 0 | 2 | 12 | 6 | 0 | 0.143 | 1.000 | 0.250 | 758.8 | 758.8 | 0.075 |
| scenario-headroom | 20 | 100.0% | 20 | 0 | 2 | 12 | 6 | 0 | 0.143 | 1.000 | 0.250 | 758.8 | 758.8 | 0.075 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 20 | 0 | 0 | 0 | 0 | 20 |
| scenario-equal | 20 | 0 | 0 | 0 | 0 | 20 |
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
| scenario-headroom | 4996 | 100.0% | 4996 | 0 | 579 | 1990 | 2259 | 168 | 0.225 | 0.775 | 0.349 | 1340.0 | 1340.0 | 0.133 |

Paired median signed error (n=2; positive = optimistic): scenario-equal 758.8 min, current 758.8 min.

### Scenario-only cohort (instants the current model withholds)

n: 17095 records, 619 window lifecycles, 45 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 619 | 0.0% | 0 | 0 | 0 | 0 | 0 | 0 | — | — | — | — | — | — |
| scenario-equal | 619 | 100.0% | 619 | 0 | 13 | 30 | 555 | 21 | 0.302 | 0.382 | 0.338 | -1033.0 | 1033.0 | 0.199 |
| scenario-headroom | 619 | 100.0% | 619 | 0 | 11 | 26 | 559 | 23 | 0.297 | 0.324 | 0.310 | -1033.0 | 1033.0 | 0.155 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 0 | 0 | 619 | 0 | 0 | 619 |
| scenario-equal | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-headroom | 619 | 0 | 0 | 0 | 0 | 619 |

| estimator | lead-time bucket | TP | FN | recall | median signed err (min) | FP predicted in bucket |
|---|---|---:|---:|---:|---:|---:|
| current | <30m | 0 | 0 | — | — | 0 |
| current | 30m-2h | 0 | 0 | — | — | 0 |
| current | 2h-12h | 0 | 0 | — | — | 0 |
| current | 12h-48h | 0 | 0 | — | — | 0 |
| current | >48h | 0 | 0 | — | — | 0 |
| scenario-equal | <30m | 0 | 0 | — | — | 0 |
| scenario-equal | 30m-2h | 3 | 6 | 0.333 | 79.8 | 2 |
| scenario-equal | 2h-12h | 2 | 14 | 0.125 | -33.5 | 14 |
| scenario-equal | 12h-48h | 5 | 1 | 0.833 | -1819.1 | 12 |
| scenario-equal | >48h | 3 | 0 | 1.000 | -2004.0 | 2 |
| scenario-headroom | <30m | 0 | 0 | — | — | 0 |
| scenario-headroom | 30m-2h | 2 | 7 | 0.222 | -23.3 | 2 |
| scenario-headroom | 2h-12h | 1 | 15 | 0.063 | -29.3 | 12 |
| scenario-headroom | 12h-48h | 5 | 1 | 0.833 | -1033.0 | 9 |
| scenario-headroom | >48h | 3 | 0 | 1.000 | -1615.4 | 3 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 17095 | 0.0% | 0 | 0 | 0 | 0 | 0 | 0 | — | — | — | — | — | — |
| scenario-equal | 17095 | 100.0% | 17095 | 0 | 1969 | 7586 | 7369 | 171 | 0.206 | 0.920 | 0.337 | -1439.6 | 1488.6 | 0.151 |
| scenario-headroom | 17095 | 100.0% | 17095 | 0 | 1779 | 5333 | 9622 | 361 | 0.250 | 0.831 | 0.385 | -826.1 | 1125.5 | 0.113 |

Paired median signed error (n=0; positive = optimistic): scenario-equal — min, current — min.

### Bootstrap

Block bootstrap of `scenario-equal − current`, resampling blocks rather than instants (window lifecycles overall, episodes on transitions).

| cohort | statistic | p2.5 | p50 | p97.5 | resamples |
|---|---|---:|---:|---:|---:|
| Overall (block = window lifecycle) | f1 | -0.007 | 0.070 | 0.145 | 1000 |
| Overall (block = window lifecycle) | medianAbsErrorMinutes | -35.629 | 12.879 | 46.668 | 1000 |
| Overall (block = window lifecycle) | medianSignedErrorMinutes | 2.778 | 18.448 | 37.079 | 1000 |
| Any transition (block = episode) | f1 | 0.013 | 0.091 | 0.181 | 1000 |
| Any transition (block = episode) | medianAbsErrorMinutes | -220.541 | 8.659 | 171.271 | 1000 |
| Any transition (block = episode) | medianSignedErrorMinutes | -87.925 | 6.959 | 320.561 | 1000 |

## Prediction churn

How much each model's answer MOVES between one instant and the next, over adjacent usable instants of the same window lifecycle. Accuracy says nothing about stability: an estimator that alternates between "out in 40 minutes" and "not this cycle" every grid step is unusable at any F1.

Lifecycle-balanced the same way the score tables are: the median (and p90) is taken WITHIN a lifecycle first, then across lifecycles. `flip rate` is the fraction of adjacent pairs where the yes/no verdict changed. A pair is two instants EXACTLY one grid step apart, both usable for that model: nothing bridges a skipped instant or one the model could not answer, so a hole in the series does not read as churn.

Each model is measured on its OWN usable instants, over every replay record rather than the common cohort the score tables use: another model abstaining, or an outcome nobody observed, does not make a model's two consecutive answers unmeasurable. The three rows of a cohort are therefore each an honest statement about one model, and not a like-for-like comparison the way the scores are.

Not a `BacktestStatistic`: that vocabulary is a function of an unordered bag of records, churn is a function of an ordered sequence inside a lifecycle, and `BacktestRecord` carries no lifecycle id to group by. There is therefore no bootstrap CI on these numbers — resampling blocks with replacement would destroy the adjacency they are defined on.

| cohort | model | lifecycles | pairs | median abs ETA change (min) | p90 abs ETA change (min) | median flip rate |
|---|---|---:|---:|---:|---:|---:|
| Overall | current | 617 | 24471 | 11.1 | 19.7 | 0.000 |
| Overall | scenario-equal | 767 | 41666 | 11.7 | 32.7 | 0.000 |
| Overall | scenario-headroom | 767 | 41666 | 12.8 | 27.0 | 0.000 |
| Any transition | current | 165 | 4016 | 11.5 | 18.7 | 0.000 |
| Any transition | scenario-equal | 198 | 6506 | 11.7 | 24.9 | 0.000 |
| Any transition | scenario-headroom | 198 | 6506 | 12.8 | 24.2 | 0.000 |

## Pool calibration (all-out within 14 d)

The pool-level claim, scored against the observed grid. What the table can say is how often a predicted pool-out was followed by 14 days with no outage.

- `anthropic`: all-out `2026-07-02T12:00:00.000Z`–`2026-07-02T12:20:00.000Z` (`2` ticks)
- `codex`: all-out `2026-07-02T14:20:00.000Z`–`2026-07-02T14:30:00.000Z` (`1` ticks)
- `codex`: all-out `2026-08-04T20:40:00.000Z`–`2026-08-04T22:00:00.000Z` (`8` ticks)

These intervals are the positives behind the `observed out` column; pool-level recall and F1 are not stated here because per-window scores decide the verdict.

Only instants whose full 14-day horizon fits inside the replay interval are calibrated.

| class | model | instants | abstained | predicted out | observed out | observed non-outage | censored | false-alarm rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic | current | 7627 | 1019 | 2882 | 217 | 7410 | 0 | 0.989 |
| anthropic | scenario-equal | 7627 | 1010 | 5188 | 217 | 7410 | 0 | 0.997 |
| anthropic | scenario-headroom | 7627 | 1010 | 5295 | 217 | 7410 | 0 | 0.997 |
| codex | current | 5868 | 1020 | 2594 | 2213 | 1398 | 2257 | 0.274 |
| codex | scenario-equal | 5868 | 1020 | 2594 | 2213 | 1398 | 2257 | 0.274 |
| codex | scenario-headroom | 5868 | 1020 | 2594 | 2213 | 1398 | 2257 | 0.274 |

## Verdict

```
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
   (p97.5 >= 0).

replace = A and B and C. keep-scenario = any criterion FALSE.
insufficient-evidence = no criterion false, at least one indeterminate.
The verdict basis is the EQUAL share rule, pre-declared; the headroom rule
is reported beside it and is never the basis.
```

**A. not more optimistic on transitions: FAIL**

| value | number |
|---|---:|
| paired median signed error, scenario-equal (min) | 14.567 |
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

| cohort | records | lifecycles | episodes |
|---|---:|---:|---:|
| Overall | 25200 | 619 | 57 |
| Any transition | 4280 | 171 | 57 |

**Verdict: keep-scenario**

PROVISIONAL: the peer-exhaustion (codex), add (codex), upgrade (codex) cohorts have no completed weekly window inside the replay interval, so their weekly half is unlabelled and the verdict rests on five-hour evidence there. Re-run the reproduce command above with a later `--to` once those windows have reset, and re-read the verdict.

What step 4 does with this:

- `replace`: the scenario becomes the headline runway, with the current model kept beside it for one release.
- `keep-scenario`: the scenario stays a labelled second line and exclusion keeps the headline.
- `insufficient-evidence`: nothing ships; the run repeats when the missing windows have completed.

## Known limits

- Pause and removal cannot be replayed: `usage_snapshots` rows cascade-delete with their account, so no removed account has history, and `accounts.paused` keeps none. The scenario's `presence: "demand-only"` path is covered by its unit tests only.
- Snapshots before 2026-08-24 carry no `plan_tier`/`rate_limit_tier` and no `observed_at`. Tiers there are today's, marked `assumed`; without an observation instant the weekly full-confidence path is unavailable to BOTH models, so the two are still compared like for like.
- No reset-credit bank is modelled, and no live usage point is injected — the replay only has what the sampler stored.
- The headroom share rule is reported, never used as the verdict basis. The verdict basis is the equal split, pre-declared.
- The scenario double-counts a dead peer's demand while the survivor's own lookback already contains the traffic it absorbed. That is a property of the model, disclosed in the peer-exhaustion cohort rather than corrected here.
- Pending at this run (tag and servable class): peer-exhaustion (codex), add (codex), upgrade (codex). No weekly window of those classes carrying those tags had completed by the end of the replay interval, so the cohort carries five-hour evidence only and the verdict is provisional.
- Positive counts (all records, per model) — current: 3686 actual positives of 25200 scored; scenario-equal: 5826 actual positives of 42295 scored; scenario-headroom: 5826 actual positives of 42295 scored.

## Notes

- Placeholder windows skipped: 233.
- Replay took 12.5 s over 9648 instants; scoring and bootstrap 1.7 s.
- Grid step 10 min; rows loaded 8 days either side of the replay interval.
