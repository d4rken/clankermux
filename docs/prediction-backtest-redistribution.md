# ClankerMux runway redistribution backtest

Generated: 2026-09-07T15:23:24.797Z

Reproduce with:

```
bun scripts/redistribution-backtest.ts --db=/home/darken/.config/clankermux/clankermux.db --from=2026-07-01T00:00:00Z --to=2026-09-06T00:00:00Z --out=docs/prediction-backtest-redistribution.md --records-out=/tmp/claude-1000/redistribution-records-basis.jsonl
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
| usage_snapshots rows | 196184 |
| accounts | 7 |
| providers | anthropic, codex |
| first sample | 2026-06-02T12:48:00.294Z |
| last sample | 2026-09-07T15:21:46.885Z |
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
- Observation lag: `scenario-equal`, `scenario-proportional` and `scenario-headroom` advance each reading over the gap between the instant its estimator measured to and the instant being replayed, at the share slope the first assignment gives it. The lag is taken per estimator path from the same anchor the current model uses: the fit's own last point on the regression path, the observation instant on the observation-anchored lifetime path, and nothing on the now-anchored paths, which carry none. An anchor ahead of the replayed instant clamps to zero lag, while the current model keeps anchoring its own ETA to that future instant, so the two part company there. On a lone account, wherever the anchor was recoverable and sits behind the instant, this projects the window from the same anchor the current model projects it from; a window there can still land elsewhere whenever another window of the class exhausts while this one is still projecting — including a death the correction applies AT the replayed instant — because that suspends the account's burn and the ETA then carries the span it spends dead, which is the scenario's own semantics rather than the redistribution. `scenario-equal-original` is the same equal split with that advance switched off, and `scenario-proportional-original` is the proportional rule with it switched off: each is the control its OWN rule's criterion D is measured against, and the equal pair is additionally the subject of the mechanism checks below.

Verdict rule, declared before the run:

```
MODELS. `scenario-proportional` is the demand-conserving scan that splits
   each class's demand across the accounts alive at an instant in
   proportion to their own measured burn, and ADVANCES each reading over
   its observation lag; `scenario-proportional-original` is the same
   proportional rule with the pre-correction scan, which schedules every
   window from the instant of the replay however old its reading is. Both
   are scored on the COMMON cohort: every model usable, truth observed.

A. NOT MORE OPTIMISTIC ON TRANSITIONS. On the any-transition cohort,
   lifecycle-balanced: max(paired median signed error of scenario-
   proportional, 0) <= max(paired median signed error of current, 0), AND
   recall of scenario-proportional >= recall of current. (Positive signed
   error = predicted later than observed = optimistic; a model that is
   EARLY is not rewarded for it, which is why both sides are clamped at 0.)
B. BETTER AT TRANSITIONS. On the same cohort, F1 of scenario-proportional
   >= F1 of current.
C. NO SIGNIFICANT OVERALL LOSS. On the overall cohort, the block-bootstrap
   95% CI of F1(scenario-proportional) - F1(current) is not entirely below
   zero (p97.5 >= 0). Read from the entry whose BASELINE is the current
   model.
D. NOT WORSE THAN THE ORIGINAL SCENARIO. On the any-transition common
   cohort, lifecycle-balanced: F1(scenario-proportional) >= F1(scenario-
   proportional-original), AND the paired median of |error of scenario-
   proportional| - |error of scenario-proportional-original| <= 0 over the
   records both models dated. Recall of both is printed beside D and is NOT
   judged: the correction can change the ORDER of a class's events, and
   with it which windows are dated before their reset at all, in EITHER
   direction.

replace = A and B and C and D. keep-scenario = any criterion FALSE.
insufficient-evidence = no criterion false, at least one indeterminate.
The verdict basis is the PROPORTIONAL share rule, re-declared on 2026-09-07
after it was scored as a candidate beside the equal split, which had been
the basis through v2026.9.19. The equal split and the headroom rule are
scored beside it and never enter the verdict.
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
| scenario-proportional | 619 | 100.0% | 619 | 0 | 38 | 82 | 490 | 9 | 0.317 | 0.809 | 0.455 | -11.9 | 24.0 | 0.068 |
| scenario-proportional-original | 619 | 100.0% | 619 | 0 | 38 | 81 | 491 | 9 | 0.319 | 0.809 | 0.458 | -10.4 | 23.9 | 0.061 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-equal | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-equal-original | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-headroom | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-proportional | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-proportional-original | 619 | 0 | 0 | 0 | 0 | 619 |

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
| scenario-proportional | <30m | 4 | 0 | 1.000 | -5.0 | 13 |
| scenario-proportional | 30m-2h | 24 | 8 | 0.750 | -5.1 | 38 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 4 |
| scenario-proportional | 12h-48h | 4 | 1 | 0.800 | 278.3 | 20 |
| scenario-proportional | >48h | 6 | 0 | 1.000 | -2653.4 | 7 |
| scenario-proportional-original | <30m | 4 | 0 | 1.000 | -4.1 | 12 |
| scenario-proportional-original | 30m-2h | 24 | 8 | 0.750 | -4.0 | 38 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 4 |
| scenario-proportional-original | 12h-48h | 4 | 1 | 0.800 | 274.3 | 20 |
| scenario-proportional-original | >48h | 6 | 0 | 1.000 | -2653.4 | 7 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 25200 | 100.0% | 25200 | 0 | 2992 | 7726 | 13788 | 694 | 0.279 | 0.812 | 0.415 | -70.4 | 1205.8 | 0.123 |
| scenario-equal | 25200 | 100.0% | 25200 | 0 | 3150 | 7582 | 13932 | 536 | 0.294 | 0.855 | 0.437 | -401.3 | 1048.3 | 0.110 |
| scenario-equal-original | 25200 | 100.0% | 25200 | 0 | 3148 | 7574 | 13940 | 538 | 0.294 | 0.854 | 0.437 | -401.8 | 1049.7 | 0.110 |
| scenario-headroom | 25200 | 100.0% | 25200 | 0 | 2744 | 6201 | 15313 | 942 | 0.307 | 0.744 | 0.434 | -14.3 | 965.6 | 0.103 |
| scenario-proportional | 25200 | 100.0% | 25200 | 0 | 3219 | 8324 | 13190 | 467 | 0.279 | 0.873 | 0.423 | -469.2 | 1170.8 | 0.120 |
| scenario-proportional-original | 25200 | 100.0% | 25200 | 0 | 3219 | 8308 | 13206 | 467 | 0.279 | 0.873 | 0.423 | -469.2 | 1170.8 | 0.121 |

Paired median signed error (n=32; positive = optimistic): scenario-proportional -12.4 min, current -4.8 min.

Against its own pre-correction scan (n=38): scenario-proportional -11.9 min, scenario-proportional-original -10.4 min; paired median change in absolute error 0.0 min (n=38, negative = the correction lands closer).

### Any transition

n: 4280 records, 171 window lifecycles, 57 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 171 | 100.0% | 171 | 0 | 18 | 30 | 113 | 10 | 0.375 | 0.643 | 0.474 | -0.4 | 29.5 | 0.048 |
| scenario-equal | 171 | 100.0% | 171 | 0 | 21 | 25 | 118 | 7 | 0.457 | 0.750 | 0.568 | 14.1 | 51.6 | 0.066 |
| scenario-equal-original | 171 | 100.0% | 171 | 0 | 21 | 25 | 118 | 7 | 0.457 | 0.750 | 0.568 | 14.6 | 53.1 | 0.075 |
| scenario-headroom | 171 | 100.0% | 171 | 0 | 17 | 22 | 121 | 11 | 0.436 | 0.607 | 0.507 | 36.4 | 81.8 | 0.137 |
| scenario-proportional | 171 | 100.0% | 171 | 0 | 24 | 38 | 105 | 4 | 0.387 | 0.857 | 0.533 | -5.0 | 19.2 | 0.040 |
| scenario-proportional-original | 171 | 100.0% | 171 | 0 | 24 | 36 | 107 | 4 | 0.400 | 0.857 | 0.545 | -4.1 | 18.4 | 0.038 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 171 | 0 | 0 | 0 | 0 | 171 |
| scenario-equal | 171 | 0 | 0 | 0 | 0 | 171 |
| scenario-equal-original | 171 | 0 | 0 | 0 | 0 | 171 |
| scenario-headroom | 171 | 0 | 0 | 0 | 0 | 171 |
| scenario-proportional | 171 | 0 | 0 | 0 | 0 | 171 |
| scenario-proportional-original | 171 | 0 | 0 | 0 | 0 | 171 |

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
| scenario-proportional | <30m | 4 | 1 | 0.800 | -4.2 | 6 |
| scenario-proportional | 30m-2h | 12 | 2 | 0.857 | -11.9 | 17 |
| scenario-proportional | 2h-12h | 2 | 0 | 1.000 | 69.6 | 2 |
| scenario-proportional | 12h-48h | 2 | 1 | 0.667 | -752.7 | 10 |
| scenario-proportional | >48h | 4 | 0 | 1.000 | -5700.6 | 3 |
| scenario-proportional-original | <30m | 4 | 1 | 0.800 | -2.4 | 6 |
| scenario-proportional-original | 30m-2h | 12 | 2 | 0.857 | -11.5 | 16 |
| scenario-proportional-original | 2h-12h | 2 | 0 | 1.000 | 69.2 | 1 |
| scenario-proportional-original | 12h-48h | 2 | 1 | 0.667 | -752.7 | 10 |
| scenario-proportional-original | >48h | 4 | 0 | 1.000 | -5700.6 | 3 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 4280 | 100.0% | 4280 | 0 | 468 | 1490 | 2075 | 247 | 0.239 | 0.655 | 0.350 | -369.8 | 538.5 | 0.083 |
| scenario-equal | 4280 | 100.0% | 4280 | 0 | 589 | 1558 | 2007 | 126 | 0.274 | 0.824 | 0.412 | -314.3 | 636.0 | 0.085 |
| scenario-equal-original | 4280 | 100.0% | 4280 | 0 | 588 | 1557 | 2008 | 127 | 0.274 | 0.822 | 0.411 | -321.2 | 636.0 | 0.085 |
| scenario-headroom | 4280 | 100.0% | 4280 | 0 | 482 | 1416 | 2149 | 233 | 0.254 | 0.674 | 0.369 | -134.2 | 721.1 | 0.112 |
| scenario-proportional | 4280 | 100.0% | 4280 | 0 | 594 | 1677 | 1888 | 121 | 0.262 | 0.831 | 0.398 | -216.1 | 458.1 | 0.068 |
| scenario-proportional-original | 4280 | 100.0% | 4280 | 0 | 594 | 1673 | 1892 | 121 | 0.262 | 0.831 | 0.398 | -216.1 | 458.1 | 0.067 |

Paired median signed error (n=18; positive = optimistic): scenario-proportional -11.9 min, current -0.4 min.

Against its own pre-correction scan (n=24): scenario-proportional -5.0 min, scenario-proportional-original -4.1 min; paired median change in absolute error 0.0 min (n=24, negative = the correction lands closer).

### peer-exhaustion

n: 2245 records, 116 window lifecycles, 51 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 116 | 100.0% | 116 | 0 | 14 | 24 | 71 | 7 | 0.368 | 0.667 | 0.475 | -3.6 | 66.9 | 0.052 |
| scenario-equal | 116 | 100.0% | 116 | 0 | 18 | 22 | 73 | 3 | 0.450 | 0.857 | 0.590 | 0.1 | 29.6 | 0.064 |
| scenario-equal-original | 116 | 100.0% | 116 | 0 | 18 | 22 | 73 | 3 | 0.450 | 0.857 | 0.590 | 1.0 | 29.6 | 0.070 |
| scenario-headroom | 116 | 100.0% | 116 | 0 | 16 | 19 | 76 | 5 | 0.457 | 0.762 | 0.571 | 28.3 | 63.0 | 0.115 |
| scenario-proportional | 116 | 100.0% | 116 | 0 | 19 | 29 | 66 | 2 | 0.396 | 0.905 | 0.551 | -11.9 | 19.2 | 0.046 |
| scenario-proportional-original | 116 | 100.0% | 116 | 0 | 19 | 28 | 67 | 2 | 0.404 | 0.905 | 0.559 | -11.5 | 18.4 | 0.043 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 116 | 0 | 0 | 0 | 0 | 116 |
| scenario-equal | 116 | 0 | 0 | 0 | 0 | 116 |
| scenario-equal-original | 116 | 0 | 0 | 0 | 0 | 116 |
| scenario-headroom | 116 | 0 | 0 | 0 | 0 | 116 |
| scenario-proportional | 116 | 0 | 0 | 0 | 0 | 116 |
| scenario-proportional-original | 116 | 0 | 0 | 0 | 0 | 116 |

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
| scenario-proportional | <30m | 5 | 1 | 0.833 | -3.3 | 6 |
| scenario-proportional | 30m-2h | 8 | 0 | 1.000 | -13.7 | 10 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 3 |
| scenario-proportional | 12h-48h | 2 | 1 | 0.667 | -752.7 | 6 |
| scenario-proportional | >48h | 4 | 0 | 1.000 | -5476.3 | 4 |
| scenario-proportional-original | <30m | 5 | 1 | 0.833 | 0.6 | 6 |
| scenario-proportional-original | 30m-2h | 8 | 0 | 1.000 | -12.8 | 10 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-proportional-original | 12h-48h | 2 | 1 | 0.667 | -752.7 | 6 |
| scenario-proportional-original | >48h | 4 | 0 | 1.000 | -5477.2 | 4 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 2245 | 100.0% | 2245 | 0 | 321 | 651 | 1137 | 136 | 0.330 | 0.702 | 0.449 | -827.6 | 827.6 | 0.098 |
| scenario-equal | 2245 | 100.0% | 2245 | 0 | 445 | 670 | 1118 | 12 | 0.399 | 0.974 | 0.566 | -540.7 | 618.4 | 0.084 |
| scenario-equal-original | 2245 | 100.0% | 2245 | 0 | 445 | 669 | 1119 | 12 | 0.399 | 0.974 | 0.567 | -540.7 | 618.4 | 0.084 |
| scenario-headroom | 2245 | 100.0% | 2245 | 0 | 363 | 632 | 1156 | 94 | 0.365 | 0.794 | 0.500 | -263.1 | 589.8 | 0.086 |
| scenario-proportional | 2245 | 100.0% | 2245 | 0 | 444 | 739 | 1049 | 13 | 0.375 | 0.972 | 0.541 | -502.3 | 523.4 | 0.072 |
| scenario-proportional-original | 2245 | 100.0% | 2245 | 0 | 444 | 737 | 1051 | 13 | 0.376 | 0.972 | 0.542 | -502.3 | 523.4 | 0.072 |

Paired median signed error (n=14; positive = optimistic): scenario-proportional -18.1 min, current -3.6 min.

Against its own pre-correction scan (n=19): scenario-proportional -11.9 min, scenario-proportional-original -11.5 min; paired median change in absolute error 0.0 min (n=19, negative = the correction lands closer).

### add

n: 974 records, 37 window lifecycles, 8 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 37 | 100.0% | 37 | 0 | 3 | 7 | 25 | 2 | 0.300 | 0.600 | 0.400 | 50.3 | 50.3 | 0.005 |
| scenario-equal | 37 | 100.0% | 37 | 0 | 4 | 6 | 26 | 1 | 0.400 | 0.800 | 0.533 | 47.3 | 59.5 | 0.006 |
| scenario-equal-original | 37 | 100.0% | 37 | 0 | 4 | 6 | 26 | 1 | 0.400 | 0.800 | 0.533 | 47.3 | 59.5 | 0.006 |
| scenario-headroom | 37 | 100.0% | 37 | 0 | 4 | 5 | 27 | 1 | 0.444 | 0.800 | 0.571 | 130.9 | 787.4 | 0.078 |
| scenario-proportional | 37 | 100.0% | 37 | 0 | 4 | 9 | 23 | 1 | 0.308 | 0.800 | 0.444 | 33.1 | 69.6 | 0.007 |
| scenario-proportional-original | 37 | 100.0% | 37 | 0 | 4 | 9 | 23 | 1 | 0.308 | 0.800 | 0.444 | 33.1 | 69.2 | 0.007 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 37 | 0 | 0 | 0 | 0 | 37 |
| scenario-equal | 37 | 0 | 0 | 0 | 0 | 37 |
| scenario-equal-original | 37 | 0 | 0 | 0 | 0 | 37 |
| scenario-headroom | 37 | 0 | 0 | 0 | 0 | 37 |
| scenario-proportional | 37 | 0 | 0 | 0 | 0 | 37 |
| scenario-proportional-original | 37 | 0 | 0 | 0 | 0 | 37 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 1 | 0.000 | — | 4 |
| scenario-proportional | 2h-12h | 3 | 0 | 1.000 | 69.6 | 3 |
| scenario-proportional | 12h-48h | 1 | 0 | 1.000 | -1195.8 | 2 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 1 | 0.000 | — | 4 |
| scenario-proportional-original | 2h-12h | 3 | 0 | 1.000 | 69.2 | 3 |
| scenario-proportional-original | 12h-48h | 1 | 0 | 1.000 | -1195.8 | 2 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 974 | 100.0% | 974 | 0 | 79 | 260 | 538 | 97 | 0.233 | 0.449 | 0.307 | 74.3 | 84.6 | 0.009 |
| scenario-equal | 974 | 100.0% | 974 | 0 | 160 | 299 | 499 | 16 | 0.349 | 0.909 | 0.504 | 22.4 | 239.4 | 0.024 |
| scenario-equal-original | 974 | 100.0% | 974 | 0 | 159 | 299 | 499 | 17 | 0.347 | 0.903 | 0.502 | 22.4 | 245.4 | 0.024 |
| scenario-headroom | 974 | 100.0% | 974 | 0 | 112 | 220 | 578 | 64 | 0.337 | 0.636 | 0.441 | 201.7 | 821.2 | 0.102 |
| scenario-proportional | 974 | 100.0% | 974 | 0 | 142 | 323 | 475 | 34 | 0.305 | 0.807 | 0.443 | 45.3 | 231.8 | 0.027 |
| scenario-proportional-original | 974 | 100.0% | 974 | 0 | 142 | 322 | 476 | 34 | 0.306 | 0.807 | 0.444 | 45.3 | 231.8 | 0.027 |

Paired median signed error (n=3; positive = optimistic): scenario-proportional 69.6 min, current 50.3 min.

Against its own pre-correction scan (n=4): scenario-proportional 33.1 min, scenario-proportional-original 33.1 min; paired median change in absolute error 0.0 min (n=4, negative = the correction lands closer).

### upgrade

n: 23 records, 1 window lifecycles, 2 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1 | 100.0% | 1 | 0 | 0 | 0 | 1 | 0 | — | — | — | — | — | — |
| scenario-equal | 1 | 100.0% | 1 | 0 | 0 | 0 | 1 | 0 | — | — | — | — | — | — |
| scenario-equal-original | 1 | 100.0% | 1 | 0 | 0 | 0 | 1 | 0 | — | — | — | — | — | — |
| scenario-headroom | 1 | 100.0% | 1 | 0 | 0 | 0 | 1 | 0 | — | — | — | — | — | — |
| scenario-proportional | 1 | 100.0% | 1 | 0 | 0 | 0 | 1 | 0 | — | — | — | — | — | — |
| scenario-proportional-original | 1 | 100.0% | 1 | 0 | 0 | 0 | 1 | 0 | — | — | — | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 1 | 0 | 0 | 0 | 0 | 1 |
| scenario-equal | 1 | 0 | 0 | 0 | 0 | 1 |
| scenario-equal-original | 1 | 0 | 0 | 0 | 0 | 1 |
| scenario-headroom | 1 | 0 | 0 | 0 | 0 | 1 |
| scenario-proportional | 1 | 0 | 0 | 0 | 0 | 1 |
| scenario-proportional-original | 1 | 0 | 0 | 0 | 0 | 1 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 23 | 100.0% | 23 | 0 | 0 | 5 | 18 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 23 | 100.0% | 23 | 0 | 0 | 1 | 22 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 23 | 100.0% | 23 | 0 | 0 | 1 | 22 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 23 | 100.0% | 23 | 0 | 0 | 0 | 23 | 0 | — | — | — | — | — | — |
| scenario-proportional | 23 | 100.0% | 23 | 0 | 0 | 5 | 18 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional-original | 23 | 100.0% | 23 | 0 | 0 | 5 | 18 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-proportional — min, current — min.

Against its own pre-correction scan (n=0): scenario-proportional — min, scenario-proportional-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

### gift-reset

n: 1714 records, 68 window lifecycles, 20 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 68 | 100.0% | 68 | 0 | 7 | 14 | 42 | 5 | 0.333 | 0.583 | 0.424 | -0.4 | 4.8 | 0.016 |
| scenario-equal | 68 | 100.0% | 68 | 0 | 7 | 11 | 45 | 5 | 0.389 | 0.583 | 0.467 | 19.1 | 51.6 | 0.172 |
| scenario-equal-original | 68 | 100.0% | 68 | 0 | 7 | 11 | 45 | 5 | 0.389 | 0.583 | 0.467 | 21.0 | 53.1 | 0.177 |
| scenario-headroom | 68 | 100.0% | 68 | 0 | 4 | 9 | 47 | 8 | 0.308 | 0.333 | 0.320 | -34.5 | 51.5 | 0.172 |
| scenario-proportional | 68 | 100.0% | 68 | 0 | 10 | 14 | 42 | 2 | 0.417 | 0.833 | 0.556 | -16.1 | 16.1 | 0.054 |
| scenario-proportional-original | 68 | 100.0% | 68 | 0 | 10 | 13 | 43 | 2 | 0.435 | 0.833 | 0.571 | -14.6 | 14.6 | 0.049 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 68 | 0 | 0 | 0 | 0 | 68 |
| scenario-equal | 68 | 0 | 0 | 0 | 0 | 68 |
| scenario-equal-original | 68 | 0 | 0 | 0 | 0 | 68 |
| scenario-headroom | 68 | 0 | 0 | 0 | 0 | 68 |
| scenario-proportional | 68 | 0 | 0 | 0 | 0 | 68 |
| scenario-proportional-original | 68 | 0 | 0 | 0 | 0 | 68 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 1 |
| scenario-proportional | 30m-2h | 9 | 1 | 0.900 | -0.4 | 5 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-proportional | 12h-48h | 0 | 1 | 0.000 | — | 6 |
| scenario-proportional | >48h | 1 | 0 | 1.000 | -6745.6 | 1 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 1 |
| scenario-proportional-original | 30m-2h | 9 | 1 | 0.900 | 1.1 | 4 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-proportional-original | 12h-48h | 0 | 1 | 0.000 | — | 6 |
| scenario-proportional-original | >48h | 1 | 0 | 1.000 | -6745.7 | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1714 | 100.0% | 1714 | 0 | 143 | 736 | 733 | 102 | 0.163 | 0.584 | 0.254 | -5260.7 | 5260.7 | 0.522 |
| scenario-equal | 1714 | 100.0% | 1714 | 0 | 140 | 753 | 716 | 105 | 0.157 | 0.571 | 0.246 | -5341.2 | 5332.5 | 0.529 |
| scenario-equal-original | 1714 | 100.0% | 1714 | 0 | 140 | 753 | 716 | 105 | 0.157 | 0.571 | 0.246 | -5341.2 | 5332.5 | 0.529 |
| scenario-headroom | 1714 | 100.0% | 1714 | 0 | 113 | 712 | 757 | 132 | 0.137 | 0.461 | 0.211 | -5665.0 | 5665.0 | 0.562 |
| scenario-proportional | 1714 | 100.0% | 1714 | 0 | 163 | 786 | 683 | 82 | 0.172 | 0.665 | 0.273 | -56.7 | 110.7 | 0.326 |
| scenario-proportional-original | 1714 | 100.0% | 1714 | 0 | 163 | 785 | 684 | 82 | 0.172 | 0.665 | 0.273 | -55.2 | 112.0 | 0.330 |

Paired median signed error (n=7; positive = optimistic): scenario-proportional -0.4 min, current -0.4 min.

Against its own pre-correction scan (n=10): scenario-proportional -16.1 min, scenario-proportional-original -14.6 min; paired median change in absolute error -0.7 min (n=10, negative = the correction lands closer).

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
| scenario-proportional | 85 | 100.0% | 85 | 0 | 15 | 32 | 35 | 3 | 0.319 | 0.833 | 0.462 | -16.1 | 63.6 | 0.065 |
| scenario-proportional-original | 85 | 100.0% | 85 | 0 | 15 | 31 | 36 | 3 | 0.326 | 0.833 | 0.469 | -14.5 | 63.2 | 0.060 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 85 | 0 | 0 | 0 | 0 | 85 |
| scenario-equal | 85 | 0 | 0 | 0 | 0 | 85 |
| scenario-equal-original | 85 | 0 | 0 | 0 | 0 | 85 |
| scenario-headroom | 85 | 0 | 0 | 0 | 0 | 85 |
| scenario-proportional | 85 | 0 | 0 | 0 | 0 | 85 |
| scenario-proportional-original | 85 | 0 | 0 | 0 | 0 | 85 |

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
| scenario-proportional | <30m | 3 | 0 | 1.000 | 1.0 | 5 |
| scenario-proportional | 30m-2h | 5 | 1 | 0.833 | -16.1 | 13 |
| scenario-proportional | 2h-12h | 2 | 0 | 1.000 | -12.5 | 6 |
| scenario-proportional | 12h-48h | 2 | 1 | 0.667 | -1286.6 | 5 |
| scenario-proportional | >48h | 3 | 1 | 0.750 | -5496.6 | 3 |
| scenario-proportional-original | <30m | 3 | 0 | 1.000 | 2.6 | 5 |
| scenario-proportional-original | 30m-2h | 5 | 1 | 0.833 | -14.5 | 13 |
| scenario-proportional-original | 2h-12h | 2 | 0 | 1.000 | -11.1 | 5 |
| scenario-proportional-original | 12h-48h | 2 | 1 | 0.667 | -1286.5 | 5 |
| scenario-proportional-original | >48h | 3 | 1 | 0.750 | -5497.5 | 3 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 308 | 100.0% | 308 | 0 | 42 | 81 | 160 | 25 | 0.341 | 0.627 | 0.442 | -887.9 | 875.8 | 0.089 |
| scenario-equal | 308 | 100.0% | 308 | 0 | 60 | 103 | 138 | 7 | 0.368 | 0.896 | 0.522 | -10.1 | 85.9 | 0.099 |
| scenario-equal-original | 308 | 100.0% | 308 | 0 | 60 | 103 | 138 | 7 | 0.368 | 0.896 | 0.522 | -9.4 | 87.7 | 0.102 |
| scenario-headroom | 308 | 100.0% | 308 | 0 | 51 | 91 | 150 | 16 | 0.359 | 0.761 | 0.488 | -10.1 | 235.9 | 0.064 |
| scenario-proportional | 308 | 100.0% | 308 | 0 | 58 | 118 | 123 | 9 | 0.330 | 0.866 | 0.477 | -19.4 | 67.4 | 0.053 |
| scenario-proportional-original | 308 | 100.0% | 308 | 0 | 58 | 117 | 124 | 9 | 0.331 | 0.866 | 0.479 | -17.9 | 67.1 | 0.048 |

Paired median signed error (n=9; positive = optimistic): scenario-proportional -1246.5 min, current -887.9 min.

Against its own pre-correction scan (n=15): scenario-proportional -16.1 min, scenario-proportional-original -14.5 min; paired median change in absolute error 0.1 min (n=15, negative = the correction lands closer).

##### since death 30-60m

n: 267 records, 77 window lifecycles, 47 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 77 | 100.0% | 77 | 0 | 11 | 21 | 40 | 5 | 0.344 | 0.688 | 0.458 | -36.6 | 53.9 | 0.104 |
| scenario-equal | 77 | 100.0% | 77 | 0 | 14 | 21 | 40 | 2 | 0.400 | 0.875 | 0.549 | -0.4 | 29.6 | 0.096 |
| scenario-equal-original | 77 | 100.0% | 77 | 0 | 14 | 21 | 40 | 2 | 0.400 | 0.875 | 0.549 | 0.3 | 30.6 | 0.102 |
| scenario-headroom | 77 | 100.0% | 77 | 0 | 12 | 16 | 45 | 4 | 0.429 | 0.750 | 0.545 | -0.4 | 111.5 | 0.089 |
| scenario-proportional | 77 | 100.0% | 77 | 0 | 14 | 26 | 35 | 2 | 0.350 | 0.875 | 0.500 | -33.0 | 26.7 | 0.089 |
| scenario-proportional-original | 77 | 100.0% | 77 | 0 | 14 | 26 | 35 | 2 | 0.350 | 0.875 | 0.500 | -32.1 | 25.4 | 0.085 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 77 | 0 | 0 | 0 | 0 | 77 |
| scenario-equal | 77 | 0 | 0 | 0 | 0 | 77 |
| scenario-equal-original | 77 | 0 | 0 | 0 | 0 | 77 |
| scenario-headroom | 77 | 0 | 0 | 0 | 0 | 77 |
| scenario-proportional | 77 | 0 | 0 | 0 | 0 | 77 |
| scenario-proportional-original | 77 | 0 | 0 | 0 | 0 | 77 |

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
| scenario-proportional | <30m | 3 | 1 | 0.750 | -0.4 | 5 |
| scenario-proportional | 30m-2h | 6 | 0 | 1.000 | -26.7 | 10 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 4 |
| scenario-proportional | 12h-48h | 2 | 0 | 1.000 | -1471.1 | 4 |
| scenario-proportional | >48h | 3 | 1 | 0.750 | -3760.1 | 3 |
| scenario-proportional-original | <30m | 3 | 1 | 0.750 | 0.3 | 5 |
| scenario-proportional-original | 30m-2h | 6 | 0 | 1.000 | -25.4 | 10 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 4 |
| scenario-proportional-original | 12h-48h | 2 | 0 | 1.000 | -1472.7 | 4 |
| scenario-proportional-original | >48h | 3 | 1 | 0.750 | -3761.0 | 3 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 267 | 100.0% | 267 | 0 | 45 | 73 | 133 | 16 | 0.381 | 0.738 | 0.503 | -1646.3 | 1646.3 | 0.180 |
| scenario-equal | 267 | 100.0% | 267 | 0 | 57 | 78 | 128 | 4 | 0.422 | 0.934 | 0.582 | -1061.0 | 1131.2 | 0.118 |
| scenario-equal-original | 267 | 100.0% | 267 | 0 | 57 | 78 | 128 | 4 | 0.422 | 0.934 | 0.582 | -1061.0 | 1131.2 | 0.118 |
| scenario-headroom | 267 | 100.0% | 267 | 0 | 50 | 71 | 135 | 11 | 0.413 | 0.820 | 0.549 | -772.0 | 887.6 | 0.116 |
| scenario-proportional | 267 | 100.0% | 267 | 0 | 57 | 92 | 114 | 4 | 0.383 | 0.934 | 0.543 | -1230.9 | 1230.9 | 0.123 |
| scenario-proportional-original | 267 | 100.0% | 267 | 0 | 57 | 92 | 114 | 4 | 0.383 | 0.934 | 0.543 | -1230.8 | 1230.8 | 0.123 |

Paired median signed error (n=11; positive = optimistic): scenario-proportional -36.6 min, current -36.6 min.

Against its own pre-correction scan (n=14): scenario-proportional -33.0 min, scenario-proportional-original -32.1 min; paired median change in absolute error 0.1 min (n=14, negative = the correction lands closer).

##### since death 1-2h

n: 403 records, 66 window lifecycles, 42 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 66 | 100.0% | 66 | 0 | 13 | 16 | 34 | 3 | 0.448 | 0.813 | 0.578 | -0.5 | 16.6 | 0.053 |
| scenario-equal | 66 | 100.0% | 66 | 0 | 15 | 13 | 37 | 1 | 0.536 | 0.938 | 0.682 | 0.1 | 24.7 | 0.082 |
| scenario-equal-original | 66 | 100.0% | 66 | 0 | 15 | 13 | 37 | 1 | 0.536 | 0.938 | 0.682 | 1.0 | 25.2 | 0.084 |
| scenario-headroom | 66 | 100.0% | 66 | 0 | 14 | 13 | 37 | 2 | 0.519 | 0.875 | 0.651 | 27.7 | 81.8 | 0.130 |
| scenario-proportional | 66 | 100.0% | 66 | 0 | 16 | 17 | 33 | 0 | 0.485 | 1.000 | 0.653 | -11.9 | 8.1 | 0.027 |
| scenario-proportional-original | 66 | 100.0% | 66 | 0 | 16 | 17 | 33 | 0 | 0.485 | 1.000 | 0.653 | -11.5 | 7.2 | 0.024 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 66 | 0 | 0 | 0 | 0 | 66 |
| scenario-equal | 66 | 0 | 0 | 0 | 0 | 66 |
| scenario-equal-original | 66 | 0 | 0 | 0 | 0 | 66 |
| scenario-headroom | 66 | 0 | 0 | 0 | 0 | 66 |
| scenario-proportional | 66 | 0 | 0 | 0 | 0 | 66 |
| scenario-proportional-original | 66 | 0 | 0 | 0 | 0 | 66 |

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
| scenario-proportional | <30m | 4 | 0 | 1.000 | -5.0 | 5 |
| scenario-proportional | 30m-2h | 6 | 0 | 1.000 | -7.7 | 7 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 4 |
| scenario-proportional | >48h | 6 | 0 | 1.000 | -3092.9 | 1 |
| scenario-proportional-original | <30m | 4 | 0 | 1.000 | -4.1 | 5 |
| scenario-proportional-original | 30m-2h | 6 | 0 | 1.000 | -7.2 | 7 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 4 |
| scenario-proportional-original | >48h | 6 | 0 | 1.000 | -3092.9 | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 403 | 100.0% | 403 | 0 | 83 | 105 | 199 | 16 | 0.441 | 0.838 | 0.578 | -815.6 | 815.6 | 0.092 |
| scenario-equal | 403 | 100.0% | 403 | 0 | 98 | 105 | 199 | 1 | 0.483 | 0.990 | 0.649 | -1096.6 | 1084.9 | 0.115 |
| scenario-equal-original | 403 | 100.0% | 403 | 0 | 98 | 105 | 199 | 1 | 0.483 | 0.990 | 0.649 | -1096.6 | 1084.9 | 0.114 |
| scenario-headroom | 403 | 100.0% | 403 | 0 | 97 | 93 | 211 | 2 | 0.511 | 0.980 | 0.671 | -24.5 | 615.4 | 0.130 |
| scenario-proportional | 403 | 100.0% | 403 | 0 | 99 | 124 | 180 | 0 | 0.444 | 1.000 | 0.615 | -1209.7 | 1209.7 | 0.121 |
| scenario-proportional-original | 403 | 100.0% | 403 | 0 | 99 | 124 | 180 | 0 | 0.444 | 1.000 | 0.615 | -1209.7 | 1209.7 | 0.121 |

Paired median signed error (n=13; positive = optimistic): scenario-proportional -11.9 min, current -0.5 min.

Against its own pre-correction scan (n=16): scenario-proportional -11.9 min, scenario-proportional-original -11.5 min; paired median change in absolute error 0.5 min (n=16, negative = the correction lands closer).

##### since death 2-3h

n: 198 records, 42 window lifecycles, 27 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 42 | 100.0% | 42 | 0 | 4 | 9 | 27 | 2 | 0.308 | 0.667 | 0.421 | -5736.9 | 2538.2 | 0.252 |
| scenario-equal | 42 | 100.0% | 42 | 0 | 6 | 8 | 28 | 0 | 0.429 | 1.000 | 0.600 | -2187.0 | 2142.4 | 0.213 |
| scenario-equal-original | 42 | 100.0% | 42 | 0 | 6 | 8 | 28 | 0 | 0.429 | 1.000 | 0.600 | -2187.0 | 2142.4 | 0.213 |
| scenario-headroom | 42 | 100.0% | 42 | 0 | 6 | 5 | 31 | 0 | 0.545 | 1.000 | 0.706 | -1233.4 | 1172.4 | 0.116 |
| scenario-proportional | 42 | 100.0% | 42 | 0 | 6 | 13 | 23 | 0 | 0.316 | 1.000 | 0.480 | -3091.2 | 2702.4 | 0.268 |
| scenario-proportional-original | 42 | 100.0% | 42 | 0 | 6 | 13 | 23 | 0 | 0.316 | 1.000 | 0.480 | -3091.2 | 2702.4 | 0.268 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 42 | 0 | 0 | 0 | 0 | 42 |
| scenario-equal | 42 | 0 | 0 | 0 | 0 | 42 |
| scenario-equal-original | 42 | 0 | 0 | 0 | 0 | 42 |
| scenario-headroom | 42 | 0 | 0 | 0 | 0 | 42 |
| scenario-proportional | 42 | 0 | 0 | 0 | 0 | 42 |
| scenario-proportional-original | 42 | 0 | 0 | 0 | 0 | 42 |

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
| scenario-proportional | <30m | 1 | 0 | 1.000 | 0.4 | 4 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 4 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 1 | 0 | 1.000 | -1233.4 | 4 |
| scenario-proportional | >48h | 4 | 0 | 1.000 | -5225.1 | 1 |
| scenario-proportional-original | <30m | 1 | 0 | 1.000 | 1.7 | 4 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 4 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 1 | 0 | 1.000 | -1233.4 | 4 |
| scenario-proportional-original | >48h | 4 | 0 | 1.000 | -5225.1 | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 198 | 100.0% | 198 | 0 | 32 | 45 | 114 | 7 | 0.416 | 0.821 | 0.552 | -5611.4 | 5589.1 | 0.554 |
| scenario-equal | 198 | 100.0% | 198 | 0 | 39 | 45 | 114 | 0 | 0.464 | 1.000 | 0.634 | -2187.0 | 2187.0 | 0.217 |
| scenario-equal-original | 198 | 100.0% | 198 | 0 | 39 | 45 | 114 | 0 | 0.464 | 1.000 | 0.634 | -2187.0 | 2187.0 | 0.217 |
| scenario-headroom | 198 | 100.0% | 198 | 0 | 39 | 38 | 121 | 0 | 0.506 | 1.000 | 0.672 | -1246.0 | 1246.0 | 0.124 |
| scenario-proportional | 198 | 100.0% | 198 | 0 | 39 | 57 | 102 | 0 | 0.406 | 1.000 | 0.578 | -3135.8 | 3135.8 | 0.311 |
| scenario-proportional-original | 198 | 100.0% | 198 | 0 | 39 | 57 | 102 | 0 | 0.406 | 1.000 | 0.578 | -3135.8 | 3135.8 | 0.311 |

Paired median signed error (n=4; positive = optimistic): scenario-proportional -5225.1 min, current -5736.9 min.

Against its own pre-correction scan (n=6): scenario-proportional -3091.2 min, scenario-proportional-original -3091.2 min; paired median change in absolute error 0.0 min (n=6, negative = the correction lands closer).

##### since death 3-4h

n: 85 records, 17 window lifecycles, 15 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 17 | 100.0% | 17 | 0 | 3 | 3 | 10 | 1 | 0.500 | 0.750 | 0.600 | -5594.0 | 5594.0 | 0.555 |
| scenario-equal | 17 | 100.0% | 17 | 0 | 4 | 3 | 10 | 0 | 0.571 | 1.000 | 0.727 | -3811.0 | 2164.9 | 0.215 |
| scenario-equal-original | 17 | 100.0% | 17 | 0 | 4 | 3 | 10 | 0 | 0.571 | 1.000 | 0.727 | -3811.0 | 2164.9 | 0.215 |
| scenario-headroom | 17 | 100.0% | 17 | 0 | 4 | 3 | 10 | 0 | 0.571 | 1.000 | 0.727 | -3784.8 | 1158.2 | 0.115 |
| scenario-proportional | 17 | 100.0% | 17 | 0 | 4 | 3 | 10 | 0 | 0.571 | 1.000 | 0.727 | -5539.2 | 2634.5 | 0.261 |
| scenario-proportional-original | 17 | 100.0% | 17 | 0 | 4 | 3 | 10 | 0 | 0.571 | 1.000 | 0.727 | -5540.0 | 2634.5 | 0.261 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-equal | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-equal-original | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-headroom | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-proportional | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-proportional-original | 17 | 0 | 0 | 0 | 0 | 17 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 1 | 0 | 1.000 | -1158.2 | 3 |
| scenario-proportional | >48h | 3 | 0 | 1.000 | -5539.2 | 0 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 1 | 0 | 1.000 | -1158.2 | 3 |
| scenario-proportional-original | >48h | 3 | 0 | 1.000 | -5540.0 | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 85 | 100.0% | 85 | 0 | 12 | 20 | 47 | 6 | 0.375 | 0.667 | 0.480 | -5594.0 | 2531.6 | 0.251 |
| scenario-equal | 85 | 100.0% | 85 | 0 | 18 | 21 | 46 | 0 | 0.462 | 1.000 | 0.632 | -2164.9 | 2164.1 | 0.215 |
| scenario-equal-original | 85 | 100.0% | 85 | 0 | 18 | 21 | 46 | 0 | 0.462 | 1.000 | 0.632 | -2164.9 | 2164.1 | 0.215 |
| scenario-headroom | 85 | 100.0% | 85 | 0 | 18 | 21 | 46 | 0 | 0.462 | 1.000 | 0.632 | -1158.2 | 1145.7 | 0.114 |
| scenario-proportional | 85 | 100.0% | 85 | 0 | 18 | 21 | 46 | 0 | 0.462 | 1.000 | 0.632 | -2634.5 | 2613.1 | 0.259 |
| scenario-proportional-original | 85 | 100.0% | 85 | 0 | 18 | 21 | 46 | 0 | 0.462 | 1.000 | 0.632 | -2634.5 | 2613.1 | 0.259 |

Paired median signed error (n=3; positive = optimistic): scenario-proportional -5539.2 min, current -5594.0 min.

Against its own pre-correction scan (n=4): scenario-proportional -5539.2 min, scenario-proportional-original -5540.0 min; paired median change in absolute error 0.0 min (n=4, negative = the correction lands closer).

##### since death 4-6h

n: 144 records, 16 window lifecycles, 9 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 16 | 100.0% | 16 | 0 | 2 | 5 | 8 | 1 | 0.286 | 0.667 | 0.400 | -2406.5 | 2140.4 | 0.212 |
| scenario-equal | 16 | 100.0% | 16 | 0 | 3 | 4 | 9 | 0 | 0.429 | 1.000 | 0.600 | -1916.7 | 1916.7 | 0.190 |
| scenario-equal-original | 16 | 100.0% | 16 | 0 | 3 | 4 | 9 | 0 | 0.429 | 1.000 | 0.600 | -1916.7 | 1916.7 | 0.190 |
| scenario-headroom | 16 | 100.0% | 16 | 0 | 3 | 4 | 9 | 0 | 0.429 | 1.000 | 0.600 | -986.9 | 986.9 | 0.098 |
| scenario-proportional | 16 | 100.0% | 16 | 0 | 3 | 5 | 8 | 0 | 0.375 | 1.000 | 0.545 | -2515.9 | 2515.9 | 0.250 |
| scenario-proportional-original | 16 | 100.0% | 16 | 0 | 3 | 5 | 8 | 0 | 0.375 | 1.000 | 0.545 | -2515.9 | 2515.9 | 0.250 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 16 | 0 | 0 | 0 | 0 | 16 |
| scenario-equal | 16 | 0 | 0 | 0 | 0 | 16 |
| scenario-equal-original | 16 | 0 | 0 | 0 | 0 | 16 |
| scenario-headroom | 16 | 0 | 0 | 0 | 0 | 16 |
| scenario-proportional | 16 | 0 | 0 | 0 | 0 | 16 |
| scenario-proportional-original | 16 | 0 | 0 | 0 | 0 | 16 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-proportional | 12h-48h | 1 | 0 | 1.000 | -1108.1 | 3 |
| scenario-proportional | >48h | 2 | 0 | 1.000 | -2985.8 | 0 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-proportional-original | 12h-48h | 1 | 0 | 1.000 | -1108.1 | 3 |
| scenario-proportional-original | >48h | 2 | 0 | 1.000 | -2985.8 | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 144 | 100.0% | 144 | 0 | 27 | 47 | 69 | 1 | 0.365 | 0.964 | 0.529 | -2265.4 | 2265.4 | 0.225 |
| scenario-equal | 144 | 100.0% | 144 | 0 | 28 | 42 | 74 | 0 | 0.400 | 1.000 | 0.571 | -1975.7 | 1955.9 | 0.194 |
| scenario-equal-original | 144 | 100.0% | 144 | 0 | 28 | 42 | 74 | 0 | 0.400 | 1.000 | 0.571 | -1975.7 | 1955.9 | 0.194 |
| scenario-headroom | 144 | 100.0% | 144 | 0 | 28 | 42 | 74 | 0 | 0.400 | 1.000 | 0.571 | -537.6 | 688.5 | 0.068 |
| scenario-proportional | 144 | 100.0% | 144 | 0 | 28 | 47 | 69 | 0 | 0.373 | 1.000 | 0.544 | -2535.0 | 2515.9 | 0.250 |
| scenario-proportional-original | 144 | 100.0% | 144 | 0 | 28 | 47 | 69 | 0 | 0.373 | 1.000 | 0.544 | -2535.0 | 2515.9 | 0.250 |

Paired median signed error (n=2; positive = optimistic): scenario-proportional -2985.8 min, current -2406.5 min.

Against its own pre-correction scan (n=3): scenario-proportional -2515.9 min, scenario-proportional-original -2515.9 min; paired median change in absolute error 0.0 min (n=3, negative = the correction lands closer).

##### since death 6-12h

n: 328 records, 18 window lifecycles, 12 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 18 | 100.0% | 18 | 0 | 1 | 4 | 12 | 1 | 0.200 | 0.500 | 0.286 | -369.8 | 369.8 | 0.037 |
| scenario-equal | 18 | 100.0% | 18 | 0 | 2 | 4 | 12 | 0 | 0.333 | 1.000 | 0.500 | -688.4 | 289.3 | 0.029 |
| scenario-equal-original | 18 | 100.0% | 18 | 0 | 2 | 4 | 12 | 0 | 0.333 | 1.000 | 0.500 | -688.4 | 289.3 | 0.029 |
| scenario-headroom | 18 | 100.0% | 18 | 0 | 1 | 4 | 12 | 1 | 0.200 | 0.500 | 0.286 | -325.4 | 325.4 | 0.032 |
| scenario-proportional | 18 | 100.0% | 18 | 0 | 2 | 4 | 12 | 0 | 0.333 | 1.000 | 0.500 | -684.0 | 269.8 | 0.027 |
| scenario-proportional-original | 18 | 100.0% | 18 | 0 | 2 | 4 | 12 | 0 | 0.333 | 1.000 | 0.500 | -684.0 | 269.8 | 0.027 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-equal | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-equal-original | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-headroom | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-proportional | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-proportional-original | 18 | 0 | 0 | 0 | 0 | 18 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 2 | 0 | 1.000 | -684.0 | 4 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 2 | 0 | 1.000 | -684.0 | 4 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 328 | 100.0% | 328 | 0 | 42 | 128 | 153 | 5 | 0.247 | 0.894 | 0.387 | -369.8 | 357.7 | 0.035 |
| scenario-equal | 328 | 100.0% | 328 | 0 | 47 | 124 | 157 | 0 | 0.275 | 1.000 | 0.431 | -665.0 | 665.0 | 0.066 |
| scenario-equal-original | 328 | 100.0% | 328 | 0 | 47 | 124 | 157 | 0 | 0.275 | 1.000 | 0.431 | -665.0 | 665.0 | 0.066 |
| scenario-headroom | 328 | 100.0% | 328 | 0 | 42 | 124 | 157 | 5 | 0.253 | 0.894 | 0.394 | -337.9 | 325.4 | 0.032 |
| scenario-proportional | 328 | 100.0% | 328 | 0 | 47 | 128 | 153 | 0 | 0.269 | 1.000 | 0.423 | -661.1 | 661.1 | 0.066 |
| scenario-proportional-original | 328 | 100.0% | 328 | 0 | 47 | 128 | 153 | 0 | 0.269 | 1.000 | 0.423 | -661.1 | 661.1 | 0.066 |

Paired median signed error (n=1; positive = optimistic): scenario-proportional -684.0 min, current -369.8 min.

Against its own pre-correction scan (n=2): scenario-proportional -684.0 min, scenario-proportional-original -684.0 min; paired median change in absolute error 0.0 min (n=2, negative = the correction lands closer).

##### since death 12-24h

n: 512 records, 24 window lifecycles, 11 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 24 | 100.0% | 24 | 0 | 2 | 5 | 16 | 1 | 0.286 | 0.667 | 0.400 | 109.2 | 109.2 | 0.011 |
| scenario-equal | 24 | 100.0% | 24 | 0 | 3 | 5 | 16 | 0 | 0.375 | 1.000 | 0.545 | 27.5 | 82.2 | 0.008 |
| scenario-equal-original | 24 | 100.0% | 24 | 0 | 3 | 5 | 16 | 0 | 0.375 | 1.000 | 0.545 | 27.5 | 82.2 | 0.008 |
| scenario-headroom | 24 | 100.0% | 24 | 0 | 2 | 5 | 16 | 1 | 0.286 | 0.667 | 0.400 | 464.2 | 464.2 | 0.046 |
| scenario-proportional | 24 | 100.0% | 24 | 0 | 3 | 5 | 16 | 0 | 0.375 | 1.000 | 0.545 | 132.1 | 132.1 | 0.013 |
| scenario-proportional-original | 24 | 100.0% | 24 | 0 | 3 | 5 | 16 | 0 | 0.375 | 1.000 | 0.545 | 132.1 | 132.1 | 0.013 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 24 | 0 | 0 | 0 | 0 | 24 |
| scenario-equal | 24 | 0 | 0 | 0 | 0 | 24 |
| scenario-equal-original | 24 | 0 | 0 | 0 | 0 | 24 |
| scenario-headroom | 24 | 0 | 0 | 0 | 0 | 24 |
| scenario-proportional | 24 | 0 | 0 | 0 | 0 | 24 |
| scenario-proportional-original | 24 | 0 | 0 | 0 | 0 | 24 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-proportional | 2h-12h | 2 | 0 | 1.000 | -57.1 | 1 |
| scenario-proportional | 12h-48h | 1 | 0 | 1.000 | 480.5 | 2 |
| scenario-proportional | >48h | 0 | 0 | — | — | 1 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-proportional-original | 2h-12h | 2 | 0 | 1.000 | -57.1 | 1 |
| scenario-proportional-original | 12h-48h | 1 | 0 | 1.000 | 480.5 | 2 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 512 | 100.0% | 512 | 0 | 38 | 152 | 262 | 60 | 0.200 | 0.388 | 0.264 | -33.5 | 151.3 | 0.015 |
| scenario-equal | 512 | 100.0% | 512 | 0 | 98 | 152 | 262 | 0 | 0.392 | 1.000 | 0.563 | -97.7 | 125.3 | 0.012 |
| scenario-equal-original | 512 | 100.0% | 512 | 0 | 98 | 151 | 263 | 0 | 0.394 | 1.000 | 0.565 | -97.7 | 125.3 | 0.012 |
| scenario-headroom | 512 | 100.0% | 512 | 0 | 38 | 152 | 262 | 60 | 0.200 | 0.388 | 0.264 | 425.8 | 425.8 | 0.042 |
| scenario-proportional | 512 | 100.0% | 512 | 0 | 98 | 152 | 262 | 0 | 0.392 | 1.000 | 0.563 | 132.1 | 250.7 | 0.025 |
| scenario-proportional-original | 512 | 100.0% | 512 | 0 | 98 | 151 | 263 | 0 | 0.394 | 1.000 | 0.565 | 132.1 | 250.7 | 0.025 |

Paired median signed error (n=2; positive = optimistic): scenario-proportional -57.1 min, current 109.2 min.

Against its own pre-correction scan (n=3): scenario-proportional 132.1 min, scenario-proportional-original 132.1 min; paired median change in absolute error 0.0 min (n=3, negative = the correction lands closer).

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
| scenario-proportional | 58 | 100.0% | 58 | 0 | 8 | 22 | 27 | 1 | 0.267 | 0.889 | 0.410 | -12.5 | 12.5 | 0.042 |
| scenario-proportional-original | 58 | 100.0% | 58 | 0 | 8 | 21 | 28 | 1 | 0.276 | 0.889 | 0.421 | -11.1 | 11.1 | 0.037 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 58 | 0 | 0 | 0 | 0 | 58 |
| scenario-equal | 58 | 0 | 0 | 0 | 0 | 58 |
| scenario-equal-original | 58 | 0 | 0 | 0 | 0 | 58 |
| scenario-headroom | 58 | 0 | 0 | 0 | 0 | 58 |
| scenario-proportional | 58 | 0 | 0 | 0 | 0 | 58 |
| scenario-proportional-original | 58 | 0 | 0 | 0 | 0 | 58 |

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
| scenario-proportional | <30m | 2 | 0 | 1.000 | -2.1 | 5 |
| scenario-proportional | 30m-2h | 5 | 1 | 0.833 | -16.1 | 13 |
| scenario-proportional | 2h-12h | 1 | 0 | 1.000 | -12.5 | 4 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 2 | 0 | 1.000 | -0.6 | 5 |
| scenario-proportional-original | 30m-2h | 5 | 1 | 0.833 | -14.5 | 13 |
| scenario-proportional-original | 2h-12h | 1 | 0 | 1.000 | -11.1 | 3 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 180 | 100.0% | 180 | 0 | 4 | 34 | 125 | 17 | 0.105 | 0.190 | 0.136 | 8.2 | 8.2 | 0.027 |
| scenario-equal | 180 | 100.0% | 180 | 0 | 16 | 53 | 106 | 5 | 0.232 | 0.762 | 0.356 | 19.2 | 19.2 | 0.064 |
| scenario-equal-original | 180 | 100.0% | 180 | 0 | 16 | 53 | 106 | 5 | 0.232 | 0.762 | 0.356 | 20.1 | 20.1 | 0.067 |
| scenario-headroom | 180 | 100.0% | 180 | 0 | 10 | 49 | 110 | 11 | 0.169 | 0.476 | 0.250 | 19.2 | 19.2 | 0.064 |
| scenario-proportional | 180 | 100.0% | 180 | 0 | 17 | 70 | 89 | 4 | 0.195 | 0.810 | 0.315 | -2.1 | 12.5 | 0.042 |
| scenario-proportional-original | 180 | 100.0% | 180 | 0 | 17 | 69 | 90 | 4 | 0.198 | 0.810 | 0.318 | -0.6 | 11.1 | 0.037 |

Paired median signed error (n=2; positive = optimistic): scenario-proportional -33.4 min, current 7.8 min.

Against its own pre-correction scan (n=8): scenario-proportional -12.5 min, scenario-proportional-original -11.1 min; paired median change in absolute error 1.3 min (n=8, negative = the correction lands closer).

##### since death 30-60m

n: 161 records, 54 window lifecycles, 46 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 54 | 100.0% | 54 | 0 | 5 | 11 | 34 | 4 | 0.313 | 0.556 | 0.400 | 14.9 | 25.3 | 0.084 |
| scenario-equal | 54 | 100.0% | 54 | 0 | 7 | 12 | 33 | 2 | 0.368 | 0.778 | 0.500 | 6.0 | 16.0 | 0.053 |
| scenario-equal-original | 54 | 100.0% | 54 | 0 | 7 | 12 | 33 | 2 | 0.368 | 0.778 | 0.500 | 6.9 | 17.5 | 0.058 |
| scenario-headroom | 54 | 100.0% | 54 | 0 | 5 | 9 | 36 | 4 | 0.357 | 0.556 | 0.435 | 3.0 | 6.0 | 0.020 |
| scenario-proportional | 54 | 100.0% | 54 | 0 | 8 | 16 | 29 | 1 | 0.333 | 0.889 | 0.485 | -23.7 | 14.6 | 0.049 |
| scenario-proportional-original | 54 | 100.0% | 54 | 0 | 8 | 16 | 29 | 1 | 0.333 | 0.889 | 0.485 | -21.9 | 13.1 | 0.044 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 54 | 0 | 0 | 0 | 0 | 54 |
| scenario-equal | 54 | 0 | 0 | 0 | 0 | 54 |
| scenario-equal-original | 54 | 0 | 0 | 0 | 0 | 54 |
| scenario-headroom | 54 | 0 | 0 | 0 | 0 | 54 |
| scenario-proportional | 54 | 0 | 0 | 0 | 0 | 54 |
| scenario-proportional-original | 54 | 0 | 0 | 0 | 0 | 54 |

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
| scenario-proportional | <30m | 3 | 1 | 0.750 | -0.4 | 5 |
| scenario-proportional | 30m-2h | 5 | 0 | 1.000 | -26.7 | 10 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 3 | 1 | 0.750 | 0.3 | 5 |
| scenario-proportional-original | 30m-2h | 5 | 0 | 1.000 | -25.4 | 10 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 161 | 100.0% | 161 | 0 | 14 | 35 | 102 | 10 | 0.286 | 0.583 | 0.384 | 15.7 | 16.9 | 0.056 |
| scenario-equal | 161 | 100.0% | 161 | 0 | 20 | 40 | 97 | 4 | 0.333 | 0.833 | 0.476 | 5.6 | 13.3 | 0.044 |
| scenario-equal-original | 161 | 100.0% | 161 | 0 | 20 | 40 | 97 | 4 | 0.333 | 0.833 | 0.476 | 6.5 | 14.8 | 0.049 |
| scenario-headroom | 161 | 100.0% | 161 | 0 | 14 | 35 | 102 | 10 | 0.286 | 0.583 | 0.384 | 0.1 | 8.4 | 0.028 |
| scenario-proportional | 161 | 100.0% | 161 | 0 | 23 | 51 | 86 | 1 | 0.311 | 0.958 | 0.469 | -14.6 | 17.4 | 0.058 |
| scenario-proportional-original | 161 | 100.0% | 161 | 0 | 23 | 51 | 86 | 1 | 0.311 | 0.958 | 0.469 | -13.1 | 16.1 | 0.054 |

Paired median signed error (n=5; positive = optimistic): scenario-proportional -23.7 min, current 14.9 min.

Against its own pre-correction scan (n=8): scenario-proportional -23.7 min, scenario-proportional-original -21.9 min; paired median change in absolute error 0.5 min (n=8, negative = the correction lands closer).

##### since death 1-2h

n: 230 records, 48 window lifecycles, 41 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 48 | 100.0% | 48 | 0 | 7 | 11 | 28 | 2 | 0.389 | 0.778 | 0.519 | 10.0 | 10.0 | 0.033 |
| scenario-equal | 48 | 100.0% | 48 | 0 | 8 | 8 | 31 | 1 | 0.500 | 0.889 | 0.640 | 13.4 | 14.1 | 0.047 |
| scenario-equal-original | 48 | 100.0% | 48 | 0 | 8 | 8 | 31 | 1 | 0.500 | 0.889 | 0.640 | 14.6 | 15.3 | 0.051 |
| scenario-headroom | 48 | 100.0% | 48 | 0 | 7 | 8 | 31 | 2 | 0.467 | 0.778 | 0.583 | 48.6 | 48.6 | 0.162 |
| scenario-proportional | 48 | 100.0% | 48 | 0 | 9 | 12 | 27 | 0 | 0.429 | 1.000 | 0.600 | -7.4 | 7.4 | 0.025 |
| scenario-proportional-original | 48 | 100.0% | 48 | 0 | 9 | 12 | 27 | 0 | 0.429 | 1.000 | 0.600 | -6.2 | 6.2 | 0.021 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 48 | 0 | 0 | 0 | 0 | 48 |
| scenario-equal | 48 | 0 | 0 | 0 | 0 | 48 |
| scenario-equal-original | 48 | 0 | 0 | 0 | 0 | 48 |
| scenario-headroom | 48 | 0 | 0 | 0 | 0 | 48 |
| scenario-proportional | 48 | 0 | 0 | 0 | 0 | 48 |
| scenario-proportional-original | 48 | 0 | 0 | 0 | 0 | 48 |

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
| scenario-proportional | <30m | 4 | 0 | 1.000 | -5.0 | 5 |
| scenario-proportional | 30m-2h | 5 | 0 | 1.000 | -7.7 | 7 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 4 | 0 | 1.000 | -4.1 | 5 |
| scenario-proportional-original | 30m-2h | 5 | 0 | 1.000 | -7.2 | 7 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 230 | 100.0% | 230 | 0 | 26 | 55 | 140 | 9 | 0.321 | 0.743 | 0.448 | 8.2 | 9.2 | 0.031 |
| scenario-equal | 230 | 100.0% | 230 | 0 | 34 | 48 | 147 | 1 | 0.415 | 0.971 | 0.581 | 10.9 | 15.8 | 0.053 |
| scenario-equal-original | 230 | 100.0% | 230 | 0 | 34 | 48 | 147 | 1 | 0.415 | 0.971 | 0.581 | 12.4 | 15.4 | 0.051 |
| scenario-headroom | 230 | 100.0% | 230 | 0 | 33 | 36 | 159 | 2 | 0.478 | 0.943 | 0.635 | 36.4 | 36.4 | 0.121 |
| scenario-proportional | 230 | 100.0% | 230 | 0 | 35 | 66 | 129 | 0 | 0.347 | 1.000 | 0.515 | -7.0 | 7.0 | 0.023 |
| scenario-proportional-original | 230 | 100.0% | 230 | 0 | 35 | 66 | 129 | 0 | 0.347 | 1.000 | 0.515 | -5.0 | 6.2 | 0.021 |

Paired median signed error (n=7; positive = optimistic): scenario-proportional -7.4 min, current 10.0 min.

Against its own pre-correction scan (n=9): scenario-proportional -7.4 min, scenario-proportional-original -6.2 min; paired median change in absolute error 0.9 min (n=9, negative = the correction lands closer).

##### since death 2-3h

n: 106 records, 28 window lifecycles, 25 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 28 | 100.0% | 28 | 0 | 0 | 5 | 22 | 1 | 0.000 | 0.000 | 0.000 | — | — | — |
| scenario-equal | 28 | 100.0% | 28 | 0 | 1 | 3 | 24 | 0 | 0.250 | 1.000 | 0.400 | 0.4 | 0.4 | 0.001 |
| scenario-equal-original | 28 | 100.0% | 28 | 0 | 1 | 3 | 24 | 0 | 0.250 | 1.000 | 0.400 | 1.7 | 1.7 | 0.006 |
| scenario-headroom | 28 | 100.0% | 28 | 0 | 1 | 0 | 27 | 0 | 1.000 | 1.000 | 1.000 | 0.4 | 0.4 | 0.001 |
| scenario-proportional | 28 | 100.0% | 28 | 0 | 1 | 8 | 19 | 0 | 0.111 | 1.000 | 0.200 | 0.4 | 0.4 | 0.001 |
| scenario-proportional-original | 28 | 100.0% | 28 | 0 | 1 | 8 | 19 | 0 | 0.111 | 1.000 | 0.200 | 1.7 | 1.7 | 0.006 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 28 | 0 | 0 | 0 | 0 | 28 |
| scenario-equal | 28 | 0 | 0 | 0 | 0 | 28 |
| scenario-equal-original | 28 | 0 | 0 | 0 | 0 | 28 |
| scenario-headroom | 28 | 0 | 0 | 0 | 0 | 28 |
| scenario-proportional | 28 | 0 | 0 | 0 | 0 | 28 |
| scenario-proportional-original | 28 | 0 | 0 | 0 | 0 | 28 |

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
| scenario-proportional | <30m | 1 | 0 | 1.000 | 0.4 | 4 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 4 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 1 | 0 | 1.000 | 1.7 | 4 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 4 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 106 | 100.0% | 106 | 0 | 1 | 13 | 91 | 1 | 0.071 | 0.500 | 0.125 | -5.5 | 5.5 | 0.018 |
| scenario-equal | 106 | 100.0% | 106 | 0 | 2 | 7 | 97 | 0 | 0.222 | 1.000 | 0.364 | -6.7 | 0.4 | 0.001 |
| scenario-equal-original | 106 | 100.0% | 106 | 0 | 2 | 7 | 97 | 0 | 0.222 | 1.000 | 0.364 | -5.4 | 1.7 | 0.006 |
| scenario-headroom | 106 | 100.0% | 106 | 0 | 2 | 0 | 104 | 0 | 1.000 | 1.000 | 1.000 | -6.7 | 0.4 | 0.001 |
| scenario-proportional | 106 | 100.0% | 106 | 0 | 2 | 19 | 85 | 0 | 0.095 | 1.000 | 0.174 | -6.7 | 0.4 | 0.001 |
| scenario-proportional-original | 106 | 100.0% | 106 | 0 | 2 | 19 | 85 | 0 | 0.095 | 1.000 | 0.174 | -5.4 | 1.7 | 0.006 |

Paired median signed error (n=0; positive = optimistic): scenario-proportional — min, current — min.

Against its own pre-correction scan (n=1): scenario-proportional 0.4 min, scenario-proportional-original 1.7 min; paired median change in absolute error -1.3 min (n=1, negative = the correction lands closer).

##### since death 3-4h

n: 46 records, 10 window lifecycles, 12 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-equal | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-equal-original | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-headroom | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-proportional | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-proportional-original | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal-original | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-headroom | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-proportional | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-proportional-original | 10 | 0 | 0 | 0 | 0 | 10 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 46 | 100.0% | 46 | 0 | 0 | 0 | 46 | 0 | — | — | — | — | — | — |
| scenario-equal | 46 | 100.0% | 46 | 0 | 0 | 0 | 46 | 0 | — | — | — | — | — | — |
| scenario-equal-original | 46 | 100.0% | 46 | 0 | 0 | 0 | 46 | 0 | — | — | — | — | — | — |
| scenario-headroom | 46 | 100.0% | 46 | 0 | 0 | 0 | 46 | 0 | — | — | — | — | — | — |
| scenario-proportional | 46 | 100.0% | 46 | 0 | 0 | 0 | 46 | 0 | — | — | — | — | — | — |
| scenario-proportional-original | 46 | 100.0% | 46 | 0 | 0 | 0 | 46 | 0 | — | — | — | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-proportional — min, current — min.

Against its own pre-correction scan (n=0): scenario-proportional — min, scenario-proportional-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### since death 4-6h

n: 76 records, 10 window lifecycles, 9 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 10 | 100.0% | 10 | 0 | 0 | 2 | 8 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 10 | 100.0% | 10 | 0 | 0 | 1 | 9 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 10 | 100.0% | 10 | 0 | 0 | 1 | 9 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 10 | 100.0% | 10 | 0 | 0 | 1 | 9 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional | 10 | 100.0% | 10 | 0 | 0 | 2 | 8 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional-original | 10 | 100.0% | 10 | 0 | 0 | 2 | 8 | 0 | 0.000 | — | 0.000 | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal-original | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-headroom | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-proportional | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-proportional-original | 10 | 0 | 0 | 0 | 0 | 10 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 76 | 100.0% | 76 | 0 | 0 | 7 | 69 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 76 | 100.0% | 76 | 0 | 0 | 2 | 74 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 76 | 100.0% | 76 | 0 | 0 | 2 | 74 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 76 | 100.0% | 76 | 0 | 0 | 2 | 74 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional | 76 | 100.0% | 76 | 0 | 0 | 7 | 69 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional-original | 76 | 100.0% | 76 | 0 | 0 | 7 | 69 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-proportional — min, current — min.

Against its own pre-correction scan (n=0): scenario-proportional — min, scenario-proportional-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### since death 6-12h

n: 162 records, 12 window lifecycles, 9 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 12 | 100.0% | 12 | 0 | 0 | 0 | 12 | 0 | — | — | — | — | — | — |
| scenario-equal | 12 | 100.0% | 12 | 0 | 0 | 0 | 12 | 0 | — | — | — | — | — | — |
| scenario-equal-original | 12 | 100.0% | 12 | 0 | 0 | 0 | 12 | 0 | — | — | — | — | — | — |
| scenario-headroom | 12 | 100.0% | 12 | 0 | 0 | 0 | 12 | 0 | — | — | — | — | — | — |
| scenario-proportional | 12 | 100.0% | 12 | 0 | 0 | 0 | 12 | 0 | — | — | — | — | — | — |
| scenario-proportional-original | 12 | 100.0% | 12 | 0 | 0 | 0 | 12 | 0 | — | — | — | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 12 | 0 | 0 | 0 | 0 | 12 |
| scenario-equal | 12 | 0 | 0 | 0 | 0 | 12 |
| scenario-equal-original | 12 | 0 | 0 | 0 | 0 | 12 |
| scenario-headroom | 12 | 0 | 0 | 0 | 0 | 12 |
| scenario-proportional | 12 | 0 | 0 | 0 | 0 | 12 |
| scenario-proportional-original | 12 | 0 | 0 | 0 | 0 | 12 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 162 | 100.0% | 162 | 0 | 0 | 9 | 153 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 162 | 100.0% | 162 | 0 | 0 | 5 | 157 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 162 | 100.0% | 162 | 0 | 0 | 5 | 157 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 162 | 100.0% | 162 | 0 | 0 | 5 | 157 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional | 162 | 100.0% | 162 | 0 | 0 | 9 | 153 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional-original | 162 | 100.0% | 162 | 0 | 0 | 9 | 153 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-proportional — min, current — min.

Against its own pre-correction scan (n=0): scenario-proportional — min, scenario-proportional-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### since death 12-24h

n: 266 records, 17 window lifecycles, 11 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 17 | 100.0% | 17 | 0 | 0 | 1 | 16 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 17 | 100.0% | 17 | 0 | 0 | 1 | 16 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 17 | 100.0% | 17 | 0 | 0 | 1 | 16 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 17 | 100.0% | 17 | 0 | 0 | 1 | 16 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional | 17 | 100.0% | 17 | 0 | 0 | 1 | 16 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional-original | 17 | 100.0% | 17 | 0 | 0 | 1 | 16 | 0 | 0.000 | — | 0.000 | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-equal | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-equal-original | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-headroom | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-proportional | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-proportional-original | 17 | 0 | 0 | 0 | 0 | 17 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 1 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 266 | 100.0% | 266 | 0 | 0 | 4 | 262 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 266 | 100.0% | 266 | 0 | 0 | 4 | 262 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 266 | 100.0% | 266 | 0 | 0 | 3 | 263 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 266 | 100.0% | 266 | 0 | 0 | 4 | 262 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional | 266 | 100.0% | 266 | 0 | 0 | 4 | 262 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional-original | 266 | 100.0% | 266 | 0 | 0 | 3 | 263 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-proportional — min, current — min.

Against its own pre-correction scan (n=0): scenario-proportional — min, scenario-proportional-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

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
| scenario-proportional | 27 | 100.0% | 27 | 0 | 7 | 10 | 8 | 2 | 0.412 | 0.778 | 0.538 | -1286.6 | 1286.6 | 0.128 |
| scenario-proportional-original | 27 | 100.0% | 27 | 0 | 7 | 10 | 8 | 2 | 0.412 | 0.778 | 0.538 | -1286.5 | 1286.5 | 0.128 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 27 | 0 | 0 | 0 | 0 | 27 |
| scenario-equal | 27 | 0 | 0 | 0 | 0 | 27 |
| scenario-equal-original | 27 | 0 | 0 | 0 | 0 | 27 |
| scenario-headroom | 27 | 0 | 0 | 0 | 0 | 27 |
| scenario-proportional | 27 | 0 | 0 | 0 | 0 | 27 |
| scenario-proportional-original | 27 | 0 | 0 | 0 | 0 | 27 |

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
| scenario-proportional | <30m | 1 | 0 | 1.000 | 76.6 | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 1 | 0 | 1.000 | 63.6 | 2 |
| scenario-proportional | 12h-48h | 2 | 1 | 0.667 | -1286.6 | 5 |
| scenario-proportional | >48h | 3 | 1 | 0.750 | -5496.6 | 3 |
| scenario-proportional-original | <30m | 1 | 0 | 1.000 | 77.0 | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 1 | 0 | 1.000 | 63.2 | 2 |
| scenario-proportional-original | 12h-48h | 2 | 1 | 0.667 | -1286.5 | 5 |
| scenario-proportional-original | >48h | 3 | 1 | 0.750 | -5497.5 | 3 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 128 | 100.0% | 128 | 0 | 38 | 47 | 35 | 8 | 0.447 | 0.826 | 0.580 | -983.2 | 899.9 | 0.089 |
| scenario-equal | 128 | 100.0% | 128 | 0 | 44 | 50 | 32 | 2 | 0.468 | 0.957 | 0.629 | -995.8 | 1075.2 | 0.107 |
| scenario-equal-original | 128 | 100.0% | 128 | 0 | 44 | 50 | 32 | 2 | 0.468 | 0.957 | 0.629 | -995.8 | 1075.2 | 0.107 |
| scenario-headroom | 128 | 100.0% | 128 | 0 | 41 | 42 | 40 | 5 | 0.494 | 0.891 | 0.636 | -186.4 | 614.7 | 0.061 |
| scenario-proportional | 128 | 100.0% | 128 | 0 | 41 | 48 | 34 | 5 | 0.461 | 0.891 | 0.607 | -1246.5 | 1246.5 | 0.124 |
| scenario-proportional-original | 128 | 100.0% | 128 | 0 | 41 | 48 | 34 | 5 | 0.461 | 0.891 | 0.607 | -1248.2 | 1248.2 | 0.124 |

Paired median signed error (n=7; positive = optimistic): scenario-proportional -1286.6 min, current -1737.3 min.

Against its own pre-correction scan (n=7): scenario-proportional -1286.6 min, scenario-proportional-original -1286.5 min; paired median change in absolute error -0.4 min (n=7, negative = the correction lands closer).

##### since death 30-60m

n: 106 records, 23 window lifecycles, 32 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 23 | 100.0% | 23 | 0 | 6 | 10 | 6 | 1 | 0.375 | 0.857 | 0.522 | -1907.7 | 1809.7 | 0.180 |
| scenario-equal | 23 | 100.0% | 23 | 0 | 7 | 9 | 7 | 0 | 0.438 | 1.000 | 0.609 | -1318.0 | 1318.0 | 0.131 |
| scenario-equal-original | 23 | 100.0% | 23 | 0 | 7 | 9 | 7 | 0 | 0.438 | 1.000 | 0.609 | -1318.0 | 1318.0 | 0.131 |
| scenario-headroom | 23 | 100.0% | 23 | 0 | 7 | 7 | 9 | 0 | 0.500 | 1.000 | 0.667 | -903.4 | 1363.1 | 0.135 |
| scenario-proportional | 23 | 100.0% | 23 | 0 | 6 | 10 | 6 | 1 | 0.375 | 0.857 | 0.522 | -2490.8 | 1471.1 | 0.146 |
| scenario-proportional-original | 23 | 100.0% | 23 | 0 | 6 | 10 | 6 | 1 | 0.375 | 0.857 | 0.522 | -2489.4 | 1472.7 | 0.146 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 23 | 0 | 0 | 0 | 0 | 23 |
| scenario-equal | 23 | 0 | 0 | 0 | 0 | 23 |
| scenario-equal-original | 23 | 0 | 0 | 0 | 0 | 23 |
| scenario-headroom | 23 | 0 | 0 | 0 | 0 | 23 |
| scenario-proportional | 23 | 0 | 0 | 0 | 0 | 23 |
| scenario-proportional-original | 23 | 0 | 0 | 0 | 0 | 23 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 1 | 0 | 1.000 | 1.0 | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 3 |
| scenario-proportional | 12h-48h | 2 | 0 | 1.000 | -1471.1 | 4 |
| scenario-proportional | >48h | 3 | 1 | 0.750 | -3760.1 | 3 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 1 | 0 | 1.000 | 1.0 | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 3 |
| scenario-proportional-original | 12h-48h | 2 | 0 | 1.000 | -1472.7 | 4 |
| scenario-proportional-original | >48h | 3 | 1 | 0.750 | -3761.0 | 3 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 106 | 100.0% | 106 | 0 | 31 | 38 | 31 | 6 | 0.449 | 0.838 | 0.585 | -2069.2 | 2069.2 | 0.205 |
| scenario-equal | 106 | 100.0% | 106 | 0 | 37 | 38 | 31 | 0 | 0.493 | 1.000 | 0.661 | -1573.7 | 1573.7 | 0.156 |
| scenario-equal-original | 106 | 100.0% | 106 | 0 | 37 | 38 | 31 | 0 | 0.493 | 1.000 | 0.661 | -1573.7 | 1573.7 | 0.156 |
| scenario-headroom | 106 | 100.0% | 106 | 0 | 36 | 36 | 33 | 1 | 0.500 | 0.973 | 0.661 | -1346.2 | 1358.7 | 0.135 |
| scenario-proportional | 106 | 100.0% | 106 | 0 | 34 | 41 | 28 | 3 | 0.453 | 0.919 | 0.607 | -2822.5 | 2490.8 | 0.247 |
| scenario-proportional-original | 106 | 100.0% | 106 | 0 | 34 | 41 | 28 | 3 | 0.453 | 0.919 | 0.607 | -2822.5 | 2489.4 | 0.247 |

Paired median signed error (n=6; positive = optimistic): scenario-proportional -2490.8 min, current -1907.7 min.

Against its own pre-correction scan (n=6): scenario-proportional -2490.8 min, scenario-proportional-original -2489.4 min; paired median change in absolute error -0.7 min (n=6, negative = the correction lands closer).

##### since death 1-2h

n: 173 records, 18 window lifecycles, 30 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 18 | 100.0% | 18 | 0 | 6 | 5 | 6 | 1 | 0.545 | 0.857 | 0.667 | -2561.3 | 2090.4 | 0.207 |
| scenario-equal | 18 | 100.0% | 18 | 0 | 7 | 5 | 6 | 0 | 0.583 | 1.000 | 0.737 | -2164.0 | 2164.0 | 0.215 |
| scenario-equal-original | 18 | 100.0% | 18 | 0 | 7 | 5 | 6 | 0 | 0.583 | 1.000 | 0.737 | -2164.0 | 2164.0 | 0.215 |
| scenario-headroom | 18 | 100.0% | 18 | 0 | 7 | 5 | 6 | 0 | 0.583 | 1.000 | 0.737 | -1308.6 | 1308.6 | 0.130 |
| scenario-proportional | 18 | 100.0% | 18 | 0 | 7 | 5 | 6 | 0 | 0.583 | 1.000 | 0.737 | -2746.4 | 2746.4 | 0.272 |
| scenario-proportional-original | 18 | 100.0% | 18 | 0 | 7 | 5 | 6 | 0 | 0.583 | 1.000 | 0.737 | -2746.4 | 2746.4 | 0.272 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-equal | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-equal-original | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-headroom | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-proportional | 18 | 0 | 0 | 0 | 0 | 18 |
| scenario-proportional-original | 18 | 0 | 0 | 0 | 0 | 18 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 1 | 0 | 1.000 | 2.5 | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 4 |
| scenario-proportional | >48h | 6 | 0 | 1.000 | -3092.9 | 1 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 1 | 0 | 1.000 | 2.5 | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 4 |
| scenario-proportional-original | >48h | 6 | 0 | 1.000 | -3092.9 | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 173 | 100.0% | 173 | 0 | 57 | 50 | 59 | 7 | 0.533 | 0.891 | 0.667 | -2545.2 | 2545.2 | 0.252 |
| scenario-equal | 173 | 100.0% | 173 | 0 | 64 | 57 | 52 | 0 | 0.529 | 1.000 | 0.692 | -2243.0 | 2210.0 | 0.219 |
| scenario-equal-original | 173 | 100.0% | 173 | 0 | 64 | 57 | 52 | 0 | 0.529 | 1.000 | 0.692 | -2243.0 | 2210.0 | 0.219 |
| scenario-headroom | 173 | 100.0% | 173 | 0 | 64 | 57 | 52 | 0 | 0.529 | 1.000 | 0.692 | -1308.6 | 1308.6 | 0.130 |
| scenario-proportional | 173 | 100.0% | 173 | 0 | 64 | 58 | 51 | 0 | 0.525 | 1.000 | 0.688 | -2784.6 | 2765.5 | 0.274 |
| scenario-proportional-original | 173 | 100.0% | 173 | 0 | 64 | 58 | 51 | 0 | 0.525 | 1.000 | 0.688 | -2784.6 | 2765.5 | 0.274 |

Paired median signed error (n=6; positive = optimistic): scenario-proportional -3092.9 min, current -2561.3 min.

Against its own pre-correction scan (n=7): scenario-proportional -2746.4 min, scenario-proportional-original -2746.4 min; paired median change in absolute error 0.0 min (n=7, negative = the correction lands closer).

##### since death 2-3h

n: 92 records, 14 window lifecycles, 24 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 14 | 100.0% | 14 | 0 | 4 | 4 | 5 | 1 | 0.500 | 0.800 | 0.615 | -5736.9 | 2538.2 | 0.252 |
| scenario-equal | 14 | 100.0% | 14 | 0 | 5 | 5 | 4 | 0 | 0.500 | 1.000 | 0.667 | -2187.0 | 2187.0 | 0.217 |
| scenario-equal-original | 14 | 100.0% | 14 | 0 | 5 | 5 | 4 | 0 | 0.500 | 1.000 | 0.667 | -2187.0 | 2187.0 | 0.217 |
| scenario-headroom | 14 | 100.0% | 14 | 0 | 5 | 5 | 4 | 0 | 0.500 | 1.000 | 0.667 | -1233.4 | 1233.4 | 0.122 |
| scenario-proportional | 14 | 100.0% | 14 | 0 | 5 | 5 | 4 | 0 | 0.500 | 1.000 | 0.667 | -3091.2 | 3091.2 | 0.307 |
| scenario-proportional-original | 14 | 100.0% | 14 | 0 | 5 | 5 | 4 | 0 | 0.500 | 1.000 | 0.667 | -3091.2 | 3091.2 | 0.307 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 14 | 0 | 0 | 0 | 0 | 14 |
| scenario-equal | 14 | 0 | 0 | 0 | 0 | 14 |
| scenario-equal-original | 14 | 0 | 0 | 0 | 0 | 14 |
| scenario-headroom | 14 | 0 | 0 | 0 | 0 | 14 |
| scenario-proportional | 14 | 0 | 0 | 0 | 0 | 14 |
| scenario-proportional-original | 14 | 0 | 0 | 0 | 0 | 14 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 1 | 0 | 1.000 | -1233.4 | 4 |
| scenario-proportional | >48h | 4 | 0 | 1.000 | -5225.1 | 1 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 1 | 0 | 1.000 | -1233.4 | 4 |
| scenario-proportional-original | >48h | 4 | 0 | 1.000 | -5225.1 | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 92 | 100.0% | 92 | 0 | 31 | 32 | 23 | 6 | 0.492 | 0.838 | 0.620 | -5611.4 | 5611.4 | 0.557 |
| scenario-equal | 92 | 100.0% | 92 | 0 | 37 | 38 | 17 | 0 | 0.493 | 1.000 | 0.661 | -2188.3 | 2188.3 | 0.217 |
| scenario-equal-original | 92 | 100.0% | 92 | 0 | 37 | 38 | 17 | 0 | 0.493 | 1.000 | 0.661 | -2188.3 | 2188.3 | 0.217 |
| scenario-headroom | 92 | 100.0% | 92 | 0 | 37 | 38 | 17 | 0 | 0.493 | 1.000 | 0.661 | -1258.5 | 1258.5 | 0.125 |
| scenario-proportional | 92 | 100.0% | 92 | 0 | 37 | 38 | 17 | 0 | 0.493 | 1.000 | 0.661 | -3141.4 | 3141.4 | 0.312 |
| scenario-proportional-original | 92 | 100.0% | 92 | 0 | 37 | 38 | 17 | 0 | 0.493 | 1.000 | 0.661 | -3141.4 | 3141.4 | 0.312 |

Paired median signed error (n=4; positive = optimistic): scenario-proportional -5225.1 min, current -5736.9 min.

Against its own pre-correction scan (n=5): scenario-proportional -3091.2 min, scenario-proportional-original -3091.2 min; paired median change in absolute error 0.0 min (n=5, negative = the correction lands closer).

##### since death 3-4h

n: 39 records, 7 window lifecycles, 15 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 7 | 100.0% | 7 | 0 | 3 | 3 | 0 | 1 | 0.500 | 0.750 | 0.600 | -5594.0 | 5594.0 | 0.555 |
| scenario-equal | 7 | 100.0% | 7 | 0 | 4 | 3 | 0 | 0 | 0.571 | 1.000 | 0.727 | -3811.0 | 2164.9 | 0.215 |
| scenario-equal-original | 7 | 100.0% | 7 | 0 | 4 | 3 | 0 | 0 | 0.571 | 1.000 | 0.727 | -3811.0 | 2164.9 | 0.215 |
| scenario-headroom | 7 | 100.0% | 7 | 0 | 4 | 3 | 0 | 0 | 0.571 | 1.000 | 0.727 | -3784.8 | 1158.2 | 0.115 |
| scenario-proportional | 7 | 100.0% | 7 | 0 | 4 | 3 | 0 | 0 | 0.571 | 1.000 | 0.727 | -5539.2 | 2634.5 | 0.261 |
| scenario-proportional-original | 7 | 100.0% | 7 | 0 | 4 | 3 | 0 | 0 | 0.571 | 1.000 | 0.727 | -5540.0 | 2634.5 | 0.261 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-equal | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-equal-original | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-headroom | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-proportional | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-proportional-original | 7 | 0 | 0 | 0 | 0 | 7 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 1 | 0 | 1.000 | -1158.2 | 3 |
| scenario-proportional | >48h | 3 | 0 | 1.000 | -5539.2 | 0 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 1 | 0 | 1.000 | -1158.2 | 3 |
| scenario-proportional-original | >48h | 3 | 0 | 1.000 | -5540.0 | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 39 | 100.0% | 39 | 0 | 12 | 20 | 1 | 6 | 0.375 | 0.667 | 0.480 | -5594.0 | 2531.6 | 0.251 |
| scenario-equal | 39 | 100.0% | 39 | 0 | 18 | 21 | 0 | 0 | 0.462 | 1.000 | 0.632 | -2164.9 | 2164.1 | 0.215 |
| scenario-equal-original | 39 | 100.0% | 39 | 0 | 18 | 21 | 0 | 0 | 0.462 | 1.000 | 0.632 | -2164.9 | 2164.1 | 0.215 |
| scenario-headroom | 39 | 100.0% | 39 | 0 | 18 | 21 | 0 | 0 | 0.462 | 1.000 | 0.632 | -1158.2 | 1145.7 | 0.114 |
| scenario-proportional | 39 | 100.0% | 39 | 0 | 18 | 21 | 0 | 0 | 0.462 | 1.000 | 0.632 | -2634.5 | 2613.1 | 0.259 |
| scenario-proportional-original | 39 | 100.0% | 39 | 0 | 18 | 21 | 0 | 0 | 0.462 | 1.000 | 0.632 | -2634.5 | 2613.1 | 0.259 |

Paired median signed error (n=3; positive = optimistic): scenario-proportional -5539.2 min, current -5594.0 min.

Against its own pre-correction scan (n=4): scenario-proportional -5539.2 min, scenario-proportional-original -5540.0 min; paired median change in absolute error 0.0 min (n=4, negative = the correction lands closer).

##### since death 4-6h

n: 68 records, 6 window lifecycles, 9 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 6 | 100.0% | 6 | 0 | 2 | 3 | 0 | 1 | 0.400 | 0.667 | 0.500 | -2406.5 | 2140.4 | 0.212 |
| scenario-equal | 6 | 100.0% | 6 | 0 | 3 | 3 | 0 | 0 | 0.500 | 1.000 | 0.667 | -1916.7 | 1916.7 | 0.190 |
| scenario-equal-original | 6 | 100.0% | 6 | 0 | 3 | 3 | 0 | 0 | 0.500 | 1.000 | 0.667 | -1916.7 | 1916.7 | 0.190 |
| scenario-headroom | 6 | 100.0% | 6 | 0 | 3 | 3 | 0 | 0 | 0.500 | 1.000 | 0.667 | -986.9 | 986.9 | 0.098 |
| scenario-proportional | 6 | 100.0% | 6 | 0 | 3 | 3 | 0 | 0 | 0.500 | 1.000 | 0.667 | -2515.9 | 2515.9 | 0.250 |
| scenario-proportional-original | 6 | 100.0% | 6 | 0 | 3 | 3 | 0 | 0 | 0.500 | 1.000 | 0.667 | -2515.9 | 2515.9 | 0.250 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-equal | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-equal-original | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-headroom | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-proportional | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-proportional-original | 6 | 0 | 0 | 0 | 0 | 6 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 1 | 0 | 1.000 | -1108.1 | 3 |
| scenario-proportional | >48h | 2 | 0 | 1.000 | -2985.8 | 0 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 1 | 0 | 1.000 | -1108.1 | 3 |
| scenario-proportional-original | >48h | 2 | 0 | 1.000 | -2985.8 | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 68 | 100.0% | 68 | 0 | 27 | 40 | 0 | 1 | 0.403 | 0.964 | 0.568 | -2265.4 | 2265.4 | 0.225 |
| scenario-equal | 68 | 100.0% | 68 | 0 | 28 | 40 | 0 | 0 | 0.412 | 1.000 | 0.583 | -1975.7 | 1955.9 | 0.194 |
| scenario-equal-original | 68 | 100.0% | 68 | 0 | 28 | 40 | 0 | 0 | 0.412 | 1.000 | 0.583 | -1975.7 | 1955.9 | 0.194 |
| scenario-headroom | 68 | 100.0% | 68 | 0 | 28 | 40 | 0 | 0 | 0.412 | 1.000 | 0.583 | -537.6 | 688.5 | 0.068 |
| scenario-proportional | 68 | 100.0% | 68 | 0 | 28 | 40 | 0 | 0 | 0.412 | 1.000 | 0.583 | -2535.0 | 2515.9 | 0.250 |
| scenario-proportional-original | 68 | 100.0% | 68 | 0 | 28 | 40 | 0 | 0 | 0.412 | 1.000 | 0.583 | -2535.0 | 2515.9 | 0.250 |

Paired median signed error (n=2; positive = optimistic): scenario-proportional -2985.8 min, current -2406.5 min.

Against its own pre-correction scan (n=3): scenario-proportional -2515.9 min, scenario-proportional-original -2515.9 min; paired median change in absolute error 0.0 min (n=3, negative = the correction lands closer).

##### since death 6-12h

n: 166 records, 6 window lifecycles, 12 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 6 | 100.0% | 6 | 0 | 1 | 4 | 0 | 1 | 0.200 | 0.500 | 0.286 | -369.8 | 369.8 | 0.037 |
| scenario-equal | 6 | 100.0% | 6 | 0 | 2 | 4 | 0 | 0 | 0.333 | 1.000 | 0.500 | -688.4 | 289.3 | 0.029 |
| scenario-equal-original | 6 | 100.0% | 6 | 0 | 2 | 4 | 0 | 0 | 0.333 | 1.000 | 0.500 | -688.4 | 289.3 | 0.029 |
| scenario-headroom | 6 | 100.0% | 6 | 0 | 1 | 4 | 0 | 1 | 0.200 | 0.500 | 0.286 | -325.4 | 325.4 | 0.032 |
| scenario-proportional | 6 | 100.0% | 6 | 0 | 2 | 4 | 0 | 0 | 0.333 | 1.000 | 0.500 | -684.0 | 269.8 | 0.027 |
| scenario-proportional-original | 6 | 100.0% | 6 | 0 | 2 | 4 | 0 | 0 | 0.333 | 1.000 | 0.500 | -684.0 | 269.8 | 0.027 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-equal | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-equal-original | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-headroom | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-proportional | 6 | 0 | 0 | 0 | 0 | 6 |
| scenario-proportional-original | 6 | 0 | 0 | 0 | 0 | 6 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 2 | 0 | 1.000 | -684.0 | 4 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 2 | 0 | 1.000 | -684.0 | 4 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 166 | 100.0% | 166 | 0 | 42 | 119 | 0 | 5 | 0.261 | 0.894 | 0.404 | -369.8 | 357.7 | 0.035 |
| scenario-equal | 166 | 100.0% | 166 | 0 | 47 | 119 | 0 | 0 | 0.283 | 1.000 | 0.441 | -665.0 | 665.0 | 0.066 |
| scenario-equal-original | 166 | 100.0% | 166 | 0 | 47 | 119 | 0 | 0 | 0.283 | 1.000 | 0.441 | -665.0 | 665.0 | 0.066 |
| scenario-headroom | 166 | 100.0% | 166 | 0 | 42 | 119 | 0 | 5 | 0.261 | 0.894 | 0.404 | -337.9 | 325.4 | 0.032 |
| scenario-proportional | 166 | 100.0% | 166 | 0 | 47 | 119 | 0 | 0 | 0.283 | 1.000 | 0.441 | -661.1 | 661.1 | 0.066 |
| scenario-proportional-original | 166 | 100.0% | 166 | 0 | 47 | 119 | 0 | 0 | 0.283 | 1.000 | 0.441 | -661.1 | 661.1 | 0.066 |

Paired median signed error (n=1; positive = optimistic): scenario-proportional -684.0 min, current -369.8 min.

Against its own pre-correction scan (n=2): scenario-proportional -684.0 min, scenario-proportional-original -684.0 min; paired median change in absolute error 0.0 min (n=2, negative = the correction lands closer).

##### since death 12-24h

n: 246 records, 7 window lifecycles, 11 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 7 | 100.0% | 7 | 0 | 2 | 4 | 0 | 1 | 0.333 | 0.667 | 0.444 | 109.2 | 109.2 | 0.011 |
| scenario-equal | 7 | 100.0% | 7 | 0 | 3 | 4 | 0 | 0 | 0.429 | 1.000 | 0.600 | 27.5 | 82.2 | 0.008 |
| scenario-equal-original | 7 | 100.0% | 7 | 0 | 3 | 4 | 0 | 0 | 0.429 | 1.000 | 0.600 | 27.5 | 82.2 | 0.008 |
| scenario-headroom | 7 | 100.0% | 7 | 0 | 2 | 4 | 0 | 1 | 0.333 | 0.667 | 0.444 | 464.2 | 464.2 | 0.046 |
| scenario-proportional | 7 | 100.0% | 7 | 0 | 3 | 4 | 0 | 0 | 0.429 | 1.000 | 0.600 | 132.1 | 132.1 | 0.013 |
| scenario-proportional-original | 7 | 100.0% | 7 | 0 | 3 | 4 | 0 | 0 | 0.429 | 1.000 | 0.600 | 132.1 | 132.1 | 0.013 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-equal | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-equal-original | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-headroom | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-proportional | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-proportional-original | 7 | 0 | 0 | 0 | 0 | 7 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 2 | 0 | 1.000 | -57.1 | 1 |
| scenario-proportional | 12h-48h | 1 | 0 | 1.000 | 480.5 | 2 |
| scenario-proportional | >48h | 0 | 0 | — | — | 1 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 2 | 0 | 1.000 | -57.1 | 1 |
| scenario-proportional-original | 12h-48h | 1 | 0 | 1.000 | 480.5 | 2 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 246 | 100.0% | 246 | 0 | 38 | 148 | 0 | 60 | 0.204 | 0.388 | 0.268 | -33.5 | 151.3 | 0.015 |
| scenario-equal | 246 | 100.0% | 246 | 0 | 98 | 148 | 0 | 0 | 0.398 | 1.000 | 0.570 | -97.7 | 125.3 | 0.012 |
| scenario-equal-original | 246 | 100.0% | 246 | 0 | 98 | 148 | 0 | 0 | 0.398 | 1.000 | 0.570 | -97.7 | 125.3 | 0.012 |
| scenario-headroom | 246 | 100.0% | 246 | 0 | 38 | 148 | 0 | 60 | 0.204 | 0.388 | 0.268 | 425.8 | 425.8 | 0.042 |
| scenario-proportional | 246 | 100.0% | 246 | 0 | 98 | 148 | 0 | 0 | 0.398 | 1.000 | 0.570 | 132.1 | 250.7 | 0.025 |
| scenario-proportional-original | 246 | 100.0% | 246 | 0 | 98 | 148 | 0 | 0 | 0.398 | 1.000 | 0.570 | 132.1 | 250.7 | 0.025 |

Paired median signed error (n=2; positive = optimistic): scenario-proportional -57.1 min, current 109.2 min.

Against its own pre-correction scan (n=3): scenario-proportional 132.1 min, scenario-proportional-original 132.1 min; paired median change in absolute error 0.0 min (n=3, negative = the correction lands closer).

### Survivor slope trajectory after a death

The survivor's OWN fitted burn slope, expressed against its slope just after the peer died: `slope(t) / slope(t_death+)`. A ratio above 1 is consistent with the inherited traffic having entered the survivor's lookback, which is the demand the scenario would then be adding a second time; a ratio near 1 is consistent with it not having arrived. The table cannot separate absorbed traffic from any other change in the survivor's own burn, and it cannot see absorption at all where the survivor was still learning when its peer died.

Median within a (window lifecycle × death) first, then across them, so a lifecycle that happens to be sampled more often does not outvote one that is not. `t_death+` is the earliest instant at or after the death that has a fitted slope at all, not the literal first instant: a survivor is often still learning when its peer dies, and requiring a slope there would discard the lifecycles this table is about. Instants with no slope enter no bucket, and a lifecycle whose baseline slope is zero is dropped rather than imputed.

Unlike the scored buckets above, this table reads the peer-exhaustion records that survive the replay's label-horizon filtering, not only the ones where every model is comparable and the window's fate was observed. The slope belongs to the survivor's own reading, so a model abstaining or an unobserved outcome is no reason to move the baseline off the earliest post-death reading there is.

The direct, slope-free measurement of the same question, how long a window takes to fill and whether that changes when the class lost a peer, is under `## Absorption measurements` below.

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
| scenario-proportional | 548 | 100.0% | 548 | 0 | 27 | 51 | 462 | 8 | 0.346 | 0.771 | 0.478 | -5.0 | 12.7 | 0.042 |
| scenario-proportional-original | 548 | 100.0% | 548 | 0 | 27 | 50 | 463 | 8 | 0.351 | 0.771 | 0.482 | -4.0 | 12.8 | 0.043 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 548 | 0 | 0 | 0 | 0 | 548 |
| scenario-equal | 548 | 0 | 0 | 0 | 0 | 548 |
| scenario-equal-original | 548 | 0 | 0 | 0 | 0 | 548 |
| scenario-headroom | 548 | 0 | 0 | 0 | 0 | 548 |
| scenario-proportional | 548 | 0 | 0 | 0 | 0 | 548 |
| scenario-proportional-original | 548 | 0 | 0 | 0 | 0 | 548 |

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
| scenario-proportional | <30m | 4 | 0 | 1.000 | -5.0 | 13 |
| scenario-proportional | 30m-2h | 23 | 8 | 0.742 | -5.1 | 37 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 4 | 0 | 1.000 | -4.1 | 12 |
| scenario-proportional-original | 30m-2h | 23 | 8 | 0.742 | -4.0 | 37 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 1 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 10515 | 100.0% | 10515 | 0 | 236 | 928 | 9215 | 136 | 0.203 | 0.634 | 0.307 | 0.2 | 15.6 | 0.052 |
| scenario-equal | 10515 | 100.0% | 10515 | 0 | 202 | 452 | 9691 | 170 | 0.309 | 0.543 | 0.394 | 14.3 | 20.7 | 0.069 |
| scenario-equal-original | 10515 | 100.0% | 10515 | 0 | 200 | 446 | 9697 | 172 | 0.310 | 0.538 | 0.393 | 15.4 | 21.6 | 0.072 |
| scenario-headroom | 10515 | 100.0% | 10515 | 0 | 122 | 268 | 9875 | 250 | 0.313 | 0.328 | 0.320 | 57.1 | 57.1 | 0.190 |
| scenario-proportional | 10515 | 100.0% | 10515 | 0 | 270 | 1074 | 9069 | 102 | 0.201 | 0.726 | 0.315 | -5.1 | 14.0 | 0.047 |
| scenario-proportional-original | 10515 | 100.0% | 10515 | 0 | 270 | 1061 | 9082 | 102 | 0.203 | 0.726 | 0.317 | -4.0 | 13.9 | 0.046 |

Paired median signed error (n=22; positive = optimistic): scenario-proportional -5.1 min, current -0.4 min.

Against its own pre-correction scan (n=27): scenario-proportional -5.0 min, scenario-proportional-original -4.0 min; paired median change in absolute error 0.5 min (n=27, negative = the correction lands closer).

#### anthropic/seven_day

n: 9472 records, 38 window lifecycles, 38 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 38 | 100.0% | 38 | 0 | 7 | 18 | 11 | 2 | 0.280 | 0.778 | 0.412 | -2031.1 | 2031.1 | 0.202 |
| scenario-equal | 38 | 100.0% | 38 | 0 | 8 | 17 | 12 | 1 | 0.320 | 0.889 | 0.471 | -1835.7 | 1417.9 | 0.141 |
| scenario-equal-original | 38 | 100.0% | 38 | 0 | 8 | 17 | 12 | 1 | 0.320 | 0.889 | 0.471 | -1835.7 | 1417.9 | 0.141 |
| scenario-headroom | 38 | 100.0% | 38 | 0 | 7 | 16 | 13 | 2 | 0.304 | 0.778 | 0.438 | -954.1 | 954.1 | 0.095 |
| scenario-proportional | 38 | 100.0% | 38 | 0 | 8 | 18 | 11 | 1 | 0.308 | 0.889 | 0.457 | -1860.7 | 1775.2 | 0.176 |
| scenario-proportional-original | 38 | 100.0% | 38 | 0 | 8 | 18 | 11 | 1 | 0.308 | 0.889 | 0.457 | -1860.7 | 1775.3 | 0.176 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 38 | 0 | 0 | 0 | 0 | 38 |
| scenario-equal | 38 | 0 | 0 | 0 | 0 | 38 |
| scenario-equal-original | 38 | 0 | 0 | 0 | 0 | 38 |
| scenario-headroom | 38 | 0 | 0 | 0 | 0 | 38 |
| scenario-proportional | 38 | 0 | 0 | 0 | 0 | 38 |
| scenario-proportional-original | 38 | 0 | 0 | 0 | 0 | 38 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 3 |
| scenario-proportional | 12h-48h | 2 | 1 | 0.667 | -1176.3 | 13 |
| scenario-proportional | >48h | 6 | 0 | 1.000 | -2653.4 | 2 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 3 |
| scenario-proportional-original | 12h-48h | 2 | 1 | 0.667 | -1176.3 | 13 |
| scenario-proportional-original | >48h | 6 | 0 | 1.000 | -2653.4 | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 9472 | 100.0% | 9472 | 0 | 2159 | 4774 | 2149 | 390 | 0.311 | 0.847 | 0.455 | -1055.5 | 1309.6 | 0.130 |
| scenario-equal | 9472 | 100.0% | 9472 | 0 | 2351 | 5114 | 1809 | 198 | 0.315 | 0.922 | 0.470 | -941.6 | 1071.5 | 0.106 |
| scenario-equal-original | 9472 | 100.0% | 9472 | 0 | 2351 | 5113 | 1810 | 198 | 0.315 | 0.922 | 0.470 | -941.6 | 1071.5 | 0.106 |
| scenario-headroom | 9472 | 100.0% | 9472 | 0 | 2025 | 3938 | 2985 | 524 | 0.340 | 0.794 | 0.476 | -525.0 | 911.1 | 0.090 |
| scenario-proportional | 9472 | 100.0% | 9472 | 0 | 2352 | 5227 | 1696 | 197 | 0.310 | 0.923 | 0.464 | -1209.7 | 1291.5 | 0.128 |
| scenario-proportional-original | 9472 | 100.0% | 9472 | 0 | 2352 | 5226 | 1697 | 197 | 0.310 | 0.923 | 0.465 | -1210.5 | 1291.5 | 0.128 |

Paired median signed error (n=7; positive = optimistic): scenario-proportional -1860.7 min, current -2031.1 min.

Against its own pre-correction scan (n=8): scenario-proportional -1860.7 min, scenario-proportional-original -1860.7 min; paired median change in absolute error 0.0 min (n=8, negative = the correction lands closer).

#### codex/five_hour

n: 217 records, 13 window lifecycles, 2 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 13 | 100.0% | 13 | 0 | 1 | 1 | 11 | 0 | 0.500 | 1.000 | 0.667 | 35.6 | 35.6 | 0.119 |
| scenario-equal | 13 | 100.0% | 13 | 0 | 1 | 1 | 11 | 0 | 0.500 | 1.000 | 0.667 | 35.6 | 35.6 | 0.119 |
| scenario-equal-original | 13 | 100.0% | 13 | 0 | 1 | 1 | 11 | 0 | 0.500 | 1.000 | 0.667 | 36.9 | 36.9 | 0.123 |
| scenario-headroom | 13 | 100.0% | 13 | 0 | 1 | 0 | 12 | 0 | 1.000 | 1.000 | 1.000 | 35.6 | 35.6 | 0.119 |
| scenario-proportional | 13 | 100.0% | 13 | 0 | 1 | 1 | 11 | 0 | 0.500 | 1.000 | 0.667 | 35.6 | 35.6 | 0.119 |
| scenario-proportional-original | 13 | 100.0% | 13 | 0 | 1 | 1 | 11 | 0 | 0.500 | 1.000 | 0.667 | 36.9 | 36.9 | 0.123 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 13 | 0 | 0 | 0 | 0 | 13 |
| scenario-equal | 13 | 0 | 0 | 0 | 0 | 13 |
| scenario-equal-original | 13 | 0 | 0 | 0 | 0 | 13 |
| scenario-headroom | 13 | 0 | 0 | 0 | 0 | 13 |
| scenario-proportional | 13 | 0 | 0 | 0 | 0 | 13 |
| scenario-proportional-original | 13 | 0 | 0 | 0 | 0 | 13 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 1 | 0 | 1.000 | 35.6 | 1 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 1 | 0 | 1.000 | 36.9 | 1 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 217 | 100.0% | 217 | 0 | 18 | 33 | 166 | 0 | 0.353 | 1.000 | 0.522 | -0.9 | 15.0 | 0.050 |
| scenario-equal | 217 | 100.0% | 217 | 0 | 18 | 26 | 173 | 0 | 0.409 | 1.000 | 0.581 | -0.9 | 15.0 | 0.050 |
| scenario-equal-original | 217 | 100.0% | 217 | 0 | 18 | 25 | 174 | 0 | 0.419 | 1.000 | 0.590 | 1.4 | 15.4 | 0.051 |
| scenario-headroom | 217 | 100.0% | 217 | 0 | 18 | 5 | 194 | 0 | 0.783 | 1.000 | 0.878 | -0.9 | 15.0 | 0.050 |
| scenario-proportional | 217 | 100.0% | 217 | 0 | 18 | 33 | 166 | 0 | 0.353 | 1.000 | 0.522 | -0.9 | 15.0 | 0.050 |
| scenario-proportional-original | 217 | 100.0% | 217 | 0 | 18 | 31 | 168 | 0 | 0.367 | 1.000 | 0.537 | 1.4 | 15.4 | 0.051 |

Paired median signed error (n=1; positive = optimistic): scenario-proportional 35.6 min, current 35.6 min.

Against its own pre-correction scan (n=1): scenario-proportional 35.6 min, scenario-proportional-original 36.9 min; paired median change in absolute error -1.3 min (n=1, negative = the correction lands closer).

#### codex/seven_day

n: 4996 records, 20 window lifecycles, 2 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 20 | 100.0% | 20 | 0 | 2 | 12 | 6 | 0 | 0.143 | 1.000 | 0.250 | 758.8 | 758.8 | 0.075 |
| scenario-equal | 20 | 100.0% | 20 | 0 | 2 | 12 | 6 | 0 | 0.143 | 1.000 | 0.250 | 758.8 | 758.8 | 0.075 |
| scenario-equal-original | 20 | 100.0% | 20 | 0 | 2 | 12 | 6 | 0 | 0.143 | 1.000 | 0.250 | 758.8 | 758.8 | 0.075 |
| scenario-headroom | 20 | 100.0% | 20 | 0 | 2 | 12 | 6 | 0 | 0.143 | 1.000 | 0.250 | 758.8 | 758.8 | 0.075 |
| scenario-proportional | 20 | 100.0% | 20 | 0 | 2 | 12 | 6 | 0 | 0.143 | 1.000 | 0.250 | 758.8 | 758.8 | 0.075 |
| scenario-proportional-original | 20 | 100.0% | 20 | 0 | 2 | 12 | 6 | 0 | 0.143 | 1.000 | 0.250 | 758.8 | 758.8 | 0.075 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 20 | 0 | 0 | 0 | 0 | 20 |
| scenario-equal | 20 | 0 | 0 | 0 | 0 | 20 |
| scenario-equal-original | 20 | 0 | 0 | 0 | 0 | 20 |
| scenario-headroom | 20 | 0 | 0 | 0 | 0 | 20 |
| scenario-proportional | 20 | 0 | 0 | 0 | 0 | 20 |
| scenario-proportional-original | 20 | 0 | 0 | 0 | 0 | 20 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 2 | 0 | 1.000 | 758.8 | 7 |
| scenario-proportional | >48h | 0 | 0 | — | — | 5 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 2 | 0 | 1.000 | 758.8 | 7 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 5 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 4996 | 100.0% | 4996 | 0 | 579 | 1991 | 2258 | 168 | 0.225 | 0.775 | 0.349 | 1340.0 | 1340.0 | 0.133 |
| scenario-equal | 4996 | 100.0% | 4996 | 0 | 579 | 1990 | 2259 | 168 | 0.225 | 0.775 | 0.349 | 1340.0 | 1340.0 | 0.133 |
| scenario-equal-original | 4996 | 100.0% | 4996 | 0 | 579 | 1990 | 2259 | 168 | 0.225 | 0.775 | 0.349 | 1340.0 | 1340.0 | 0.133 |
| scenario-headroom | 4996 | 100.0% | 4996 | 0 | 579 | 1990 | 2259 | 168 | 0.225 | 0.775 | 0.349 | 1340.0 | 1340.0 | 0.133 |
| scenario-proportional | 4996 | 100.0% | 4996 | 0 | 579 | 1990 | 2259 | 168 | 0.225 | 0.775 | 0.349 | 1340.0 | 1340.0 | 0.133 |
| scenario-proportional-original | 4996 | 100.0% | 4996 | 0 | 579 | 1990 | 2259 | 168 | 0.225 | 0.775 | 0.349 | 1340.0 | 1340.0 | 0.133 |

Paired median signed error (n=2; positive = optimistic): scenario-proportional 758.8 min, current 758.8 min.

Against its own pre-correction scan (n=2): scenario-proportional 758.8 min, scenario-proportional-original 758.8 min; paired median change in absolute error 0.0 min (n=2, negative = the correction lands closer).

### Scenario-only cohort (instants the current model withholds)

n: 17095 records, 619 window lifecycles, 45 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 619 | 0.0% | 0 | 0 | 0 | 0 | 0 | 0 | — | — | — | — | — | — |
| scenario-equal | 619 | 100.0% | 619 | 0 | 13 | 30 | 555 | 21 | 0.302 | 0.382 | 0.338 | -1033.0 | 1033.0 | 0.199 |
| scenario-equal-original | 619 | 100.0% | 619 | 0 | 13 | 30 | 555 | 21 | 0.302 | 0.382 | 0.338 | -1033.0 | 1033.0 | 0.199 |
| scenario-headroom | 619 | 100.0% | 619 | 0 | 11 | 26 | 559 | 23 | 0.297 | 0.324 | 0.310 | -1033.0 | 1033.0 | 0.152 |
| scenario-proportional | 619 | 100.0% | 619 | 0 | 10 | 28 | 557 | 24 | 0.263 | 0.294 | 0.278 | -1819.1 | 1615.4 | 0.160 |
| scenario-proportional-original | 619 | 100.0% | 619 | 0 | 10 | 28 | 557 | 24 | 0.263 | 0.294 | 0.278 | -1819.1 | 1615.4 | 0.160 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 0 | 0 | 619 | 0 | 0 | 619 |
| scenario-equal | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-equal-original | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-headroom | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-proportional | 619 | 0 | 0 | 0 | 0 | 619 |
| scenario-proportional-original | 619 | 0 | 0 | 0 | 0 | 619 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 1 | 8 | 0.111 | -22.1 | 2 |
| scenario-proportional | 2h-12h | 1 | 15 | 0.063 | -7.2 | 12 |
| scenario-proportional | 12h-48h | 5 | 1 | 0.833 | -1819.1 | 12 |
| scenario-proportional | >48h | 3 | 0 | 1.000 | -1959.6 | 2 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 1 | 8 | 0.111 | -18.3 | 2 |
| scenario-proportional-original | 2h-12h | 1 | 15 | 0.063 | -6.3 | 12 |
| scenario-proportional-original | 12h-48h | 5 | 1 | 0.833 | -1819.1 | 12 |
| scenario-proportional-original | >48h | 3 | 0 | 1.000 | -1959.6 | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 17095 | 0.0% | 0 | 0 | 0 | 0 | 0 | 0 | — | — | — | — | — | — |
| scenario-equal | 17095 | 100.0% | 17095 | 0 | 1969 | 7590 | 7365 | 171 | 0.206 | 0.920 | 0.337 | -1439.6 | 1488.6 | 0.151 |
| scenario-equal-original | 17095 | 100.0% | 17095 | 0 | 1969 | 7586 | 7369 | 171 | 0.206 | 0.920 | 0.337 | -1439.6 | 1488.6 | 0.151 |
| scenario-headroom | 17095 | 100.0% | 17095 | 0 | 1780 | 5338 | 9617 | 360 | 0.250 | 0.832 | 0.385 | -826.1 | 1122.8 | 0.113 |
| scenario-proportional | 17095 | 100.0% | 17095 | 0 | 1937 | 7550 | 7405 | 203 | 0.204 | 0.905 | 0.333 | -1705.0 | 1709.8 | 0.170 |
| scenario-proportional-original | 17095 | 100.0% | 17095 | 0 | 1937 | 7544 | 7411 | 203 | 0.204 | 0.905 | 0.333 | -1705.0 | 1709.8 | 0.170 |

Paired median signed error (n=0; positive = optimistic): scenario-proportional — min, current — min.

Against its own pre-correction scan (n=10): scenario-proportional -1819.1 min, scenario-proportional-original -1819.1 min; paired median change in absolute error 0.0 min (n=10, negative = the correction lands closer).

### Bootstrap

Block bootstrap of `scenario − baseline`, resampling blocks rather than instants (window lifecycles overall, episodes on transitions). For `scenario-proportional`, the verdict basis, the baseline is the current model for criteria A-C and its own pre-correction scan `scenario-proportional-original` for criterion D; both rows are printed for both cohorts. `scenario-equal`, the prior basis scored under `Share rules beside the basis`, carries the same two pairs so its criteria C and D can be read there. The headroom rule carries none, and that section states its C and D as indeterminate rather than resampling it against a baseline that is not its own.

| cohort | scenario | baseline | statistic | p2.5 | p50 | p97.5 | resamples |
|---|---|---|---|---:|---:|---:|---:|
| Overall (block = window lifecycle) | scenario-proportional | current | f1 | 0.003 | 0.044 | 0.091 | 1000 |
| Overall (block = window lifecycle) | scenario-proportional | current | medianAbsErrorMinutes | -62.946 | -0.946 | 6.611 | 1000 |
| Overall (block = window lifecycle) | scenario-proportional | current | medianSignedErrorMinutes | -13.862 | -2.833 | 10.309 | 1000 |
| Any transition (block = episode) | scenario-proportional | current | f1 | -0.039 | 0.059 | 0.134 | 1000 |
| Any transition (block = episode) | scenario-proportional | current | medianAbsErrorMinutes | -119.048 | -8.869 | 128.419 | 1000 |
| Any transition (block = episode) | scenario-proportional | current | medianSignedErrorMinutes | -42.661 | -4.600 | 407.604 | 1000 |
| Overall (block = window lifecycle) | scenario-proportional | scenario-proportional-original | f1 | -0.009 | -0.003 | 0.000 | 1000 |
| Overall (block = window lifecycle) | scenario-proportional | scenario-proportional-original | medianAbsErrorMinutes | -1.309 | 1.236 | 1.848 | 1000 |
| Overall (block = window lifecycle) | scenario-proportional | scenario-proportional-original | medianSignedErrorMinutes | -3.825 | -1.088 | -0.461 | 1000 |
| Any transition (block = episode) | scenario-proportional | scenario-proportional-original | f1 | -0.031 | -0.012 | 0.000 | 1000 |
| Any transition (block = episode) | scenario-proportional | scenario-proportional-original | medianAbsErrorMinutes | -1.321 | 0.572 | 1.848 | 1000 |
| Any transition (block = episode) | scenario-proportional | scenario-proportional-original | medianSignedErrorMinutes | -3.825 | -1.484 | 0.000 | 1000 |
| Overall (block = window lifecycle) | scenario-equal | current | f1 | -0.007 | 0.070 | 0.145 | 1000 |
| Overall (block = window lifecycle) | scenario-equal | current | medianAbsErrorMinutes | -37.145 | 11.570 | 45.147 | 1000 |
| Overall (block = window lifecycle) | scenario-equal | current | medianSignedErrorMinutes | 3.721 | 17.749 | 35.093 | 1000 |
| Any transition (block = episode) | scenario-equal | current | f1 | 0.013 | 0.091 | 0.181 | 1000 |
| Any transition (block = episode) | scenario-equal | current | medianAbsErrorMinutes | -220.541 | 4.929 | 171.271 | 1000 |
| Any transition (block = episode) | scenario-equal | current | medianSignedErrorMinutes | -88.834 | 5.999 | 320.561 | 1000 |
| Overall (block = window lifecycle) | scenario-equal | scenario-equal-original | f1 | 0.000 | 0.000 | 0.000 | 1000 |
| Overall (block = window lifecycle) | scenario-equal | scenario-equal-original | medianAbsErrorMinutes | -3.890 | -1.309 | 1.314 | 1000 |
| Overall (block = window lifecycle) | scenario-equal | scenario-equal-original | medianSignedErrorMinutes | -3.890 | -0.909 | 3.242 | 1000 |
| Any transition (block = episode) | scenario-equal | scenario-equal-original | f1 | 0.000 | 0.000 | 0.000 | 1000 |
| Any transition (block = episode) | scenario-equal | scenario-equal-original | medianAbsErrorMinutes | -4.461 | -1.516 | 1.314 | 1000 |
| Any transition (block = episode) | scenario-equal | scenario-equal-original | medianSignedErrorMinutes | -4.461 | -0.916 | 0.000 | 1000 |

## Absorption measurements

Direct measurements of what a survivor's own window does when its demand class loses a peer. Nothing here fits, tunes or thresholds anything, and nothing here feeds a model: each section states what it measures and over which population, and prints what falls out of that population. The populations are small, so an empty cell is ordinary rather than exceptional; an empty cell prints a dash beside its denominator.

### Time to first 100 %

How long a window took to reach its first reading at or above 100 %, measured from the window start its reset implies (`reset - window length`, the same derivation the projections use) to that reading. The population is every non-placeholder window lifecycle in the replayed snapshot history, both window kinds, every account the history holds, split by whether the account's demand class lost a peer early in the window. Early is a FIXED prefix of the window: its first hour for a five-hour window, its first 24 hours for a weekly one. A peer's death counts whichever of the peer's own windows filled, because an account at 100 % in either window leaves routing. What this section measures is how fill durations and fill fractions differ between the exposure groups; whether demand moved is not identified here.

The fill medians are conditional on an observed fill: they describe the windows that reached 100 % and no others. The two censored columns are what to read first, and a larger censored fraction does not by itself establish a larger bias in the conditional median, because the censored windows are not known to be slower ones — the follow-up-incomplete ones are not known to have failed to fill at all.

`completed below 100 %` counts the windows whose sampling ran to within 10 min of the window's own end without ever reading 100 % AND whose successor window was observed to start, which is the same rule the outcome labels use, both halves of it, ending the window at the same instant: the earlier of its reset and its successor's observed start. `follow-up incomplete` counts the ones whose samples stopped earlier, that carry no reset to end at, or that nothing was ever recorded after: those windows were not observed to their end and say nothing about whether they filled. Proximity to the reset alone would label a run that simply stopped as a window observed not to fill, and one combined census makes a cell whose follow-up merely ended look like a cell of slow windows.

A peer dies because its class is busy, and the same busy period fills a survivor faster, so a shorter fill under peer loss is equally consistent with absorption and with common cause. This section is direct and slope-free; it is not causal.

Three populations sit outside the two arms rather than inside them. A segment whose reset column is null carries no derivable window start, so it has no fill duration to state. A lifecycle whose first sample already reads 100 % filled before observation began, which is not a fill duration either. And a lifecycle whose exposure span is not wholly inside the replayed range has its own row in each table: peer deaths are only detected inside that range, so such a window would read as `no peer lost` from missing data alone. The span each table checks is its own — the fixed prefix above, the window start to the crossing below — so a window can be readable in one and not the other. The reconciliation line below accounts for all of them.

`peer lost in prefix` and its complement are exposure labels rather than statements about the focal account: the prefix rule does not require the focal account to have been available when the peer died, and `no peer lost` does not exclude a peer already exhausted at the window start, only one that crossed 100 % inside the prefix.

The `combined` rows put five-hour and weekly windows in one median. A combined duration median has a composition problem — the two kinds have different lengths and different fill rates, so the combined value moves with the mix — and the per-kind rows are the ones to read.

`fills` counts the windows of a cell that reached 100 %, the two censored columns the ones whose last sample was still below it. `median fill` runs from the derived window start, `median observed span` from the first sample instead, and `median unobserved head` is the gap between those two origins, i.e. how much of the window had already elapsed when the sampler first saw it. `median resolution` is the gap between the crossing sample and the sample before it. `median censored span, both kinds` is the one column taken over the censored windows, and it pools both censored kinds — completed below 100 % and follow-up incomplete — into one median: window start to last sample.

| exposure | window | fills | completed below 100 % | follow-up incomplete | fill fraction | median fill (h) | median observed span (h) | median unobserved head (min) | median resolution (min) | median censored span, both kinds (h) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| peer lost in prefix | five_hour | 7 | 6 | 0 | 53.8% | 2.52 | 2.47 | 3.2 | 2.0 | 4.99 |
| peer lost in prefix | seven_day | 4 | 11 | 1 | 25.0% | 109.98 | 109.89 | 2.6 | 2.0 | 167.97 |
| peer lost in prefix | combined | 11 | 17 | 1 | 37.9% | 3.55 | 3.50 | 3.2 | 2.0 | 83.09 |
| no peer lost in prefix | five_hour | 30 | 804 | 13 | 3.5% | 3.31 | 3.21 | 2.7 | 2.0 | 4.98 |
| no peer lost in prefix | seven_day | 6 | 46 | 11 | 9.5% | 89.01 | 86.68 | 2.1 | 2.0 | 89.09 |
| no peer lost in prefix | combined | 36 | 850 | 24 | 4.0% | 3.45 | 3.34 | 2.7 | 2.0 | 4.99 |
| exposure unobservable | combined | 4 | 120 | 23 | 2.7% | 4.59 | 4.57 | 1.6 | 2.0 | 4.99 |

The same rows again, split instead by whether a same-class peer died anywhere between the window start and the crossing. That definition is length-biased in the direction of longer fills, because a longer fill has more calendar time in which to contain a peer death, and that is why the fixed-prefix split above is the primary one. Both are printed; neither was chosen on its result. This split reads a different span from the prefix one, so it carries its own observability row: a window whose span from its start to its crossing (or to its last sample, uncrossed) leaves the replayed range is `during-fill exposure unobservable` here, whatever the prefix split could say about it.

| exposure | window | fills | completed below 100 % | follow-up incomplete | fill fraction | median fill (h) | median observed span (h) | median unobserved head (min) | median resolution (min) | median censored span, both kinds (h) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| peer lost during fill | five_hour | 13 | 59 | 0 | 18.1% | 3.31 | 3.24 | 3.2 | 2.0 | 4.99 |
| peer lost during fill | seven_day | 8 | 24 | 0 | 25.0% | 109.82 | 101.66 | 3.1 | 2.0 | 167.97 |
| peer lost during fill | combined | 21 | 83 | 0 | 20.2% | 3.99 | 3.95 | 3.2 | 2.0 | 5.00 |
| no peer lost during fill | five_hour | 24 | 746 | 13 | 3.1% | 3.19 | 3.15 | 2.5 | 2.0 | 4.98 |
| no peer lost during fill | seven_day | 2 | 31 | 10 | 4.7% | 71.29 | 71.28 | 0.8 | 2.0 | 51.39 |
| no peer lost during fill | combined | 26 | 777 | 23 | 3.1% | 3.20 | 3.17 | 2.4 | 2.0 | 4.98 |
| during-fill exposure unobservable | combined | 4 | 127 | 25 | 2.6% | 4.59 | 4.57 | 1.6 | 2.0 | 4.99 |

Every cell with fewer than 20 fills prints its fill durations, sorted, in hours. At that n the median summarises few observed fills, and the values themselves are what a reader can judge.

- `peer lost in prefix` five_hour (7 fills): 1.32, 2.30, 2.37, 2.52, 2.64, 3.55, 3.58 h
- `peer lost in prefix` seven_day (4 fills): 88.05, 109.98, 132.78, 159.11 h
- `peer lost in prefix` combined (11 fills): 1.32, 2.30, 2.37, 2.52, 2.64, 3.55, 3.58, 88.05, 109.98, 132.78, 159.11 h
- `no peer lost in prefix` seven_day (6 fills): 71.29, 86.71, 89.01, 101.83, 109.82, 132.28 h
- `exposure unobservable` combined (4 fills): 2.69, 4.59, 87.03, 126.32 h
- `peer lost during fill` five_hour (13 fills): 1.32, 2.27, 2.30, 2.37, 2.52, 2.64, 3.31, 3.42, 3.55, 3.58, 3.99, 4.31, 4.78 h
- `peer lost during fill` seven_day (8 fills): 86.71, 88.05, 101.83, 109.82, 109.98, 132.28, 132.78, 159.11 h
- `no peer lost during fill` seven_day (2 fills): 71.29, 89.01 h
- `during-fill exposure unobservable` combined (4 fills): 2.69, 4.59, 87.03, 126.32 h

Reconciliation: 51 filled + 987 completed below 100 % + 48 follow-up incomplete + 182 with no reset on the segment + 1 already full at the first sample + 19718 placeholder lifecycles skipped = 20987 window lifecycles.

### Request-volume changes around observed exhaustion

What each survivor's own request volume did around the instant a peer of its demand class first read 100 %. The population is every peer-exhaustion event inside the replayed interval, 50 of them, reduced by the exclusions reconciled at the end of this subsection. Volumes come from the `requests` table on a fixed 1-minute grid, per account, and are turned into rates by dividing by the minutes actually counted.

The survivor set `S` is the class members observed AVAILABLE just before the death: their newest snapshot inside the staleness bar reads under 100 % on both windows. A member reading 100 % on either window, or carrying no reading inside the bar, is listed under the death rather than counted as a survivor — an account at 100 % is already out of routing, and an unread stretch is not evidence of being in it. The dying account itself must be available just before the death, so a window filling while its account was already exhausted on the other window is excluded rather than measured as a departure.

The half-width `W` is the largest symmetric width in which NO member of the class changes availability state, capped at 60 min for the primary horizon and 6 h for the second one. The cap is a cap: most deaths are read at less, and the per-death table prints the width each one was read at. Every member of the class bounds it, including a member that is not in `S` and one created after the death — an account arriving is a regime change even though it was never a candidate for the traffic, and it is bounded at the instant it was created rather than at its first reading, which can be an hour later or never come at all. The dying account's own transition at the death is the one change the rule ignores. A death whose clean interval falls under 15 min is excluded, with the account and the distance that bounded it printed beside it. This selection preferentially removes rapid cascades, and strong absorption can itself precipitate the next death, so the analysed population is the sufficiently-isolated departures and nothing here is a claim about cascades.

The weights are read over a different width, `W_pre`, and the reason is that `W` is bounded on BOTH sides of the death: which width `W` takes depends on what happened after `D`, so a weight computed over it would not have been computable at `D`. `W_pre` runs back from `D` to the nearest availability change of any class member before `D`, capped at the same horizon cap and at the near edge of the loaded request span, and reads nothing at or after `D`. That third bound is what keeps the weights over LOADED buckets: a bucket the run never loaded is absent rather than empty, and a lookback reaching past it would divide a partly-loaded volume by its whole width and read the missing stretch as no traffic. Which of the three bounds was the binding one is printed under each death, and each control's weights are shortened to its own loaded prehistory the same way. The dying account's pre-death share, each survivor's pre-death share and the equal split are therefore computable at `D` from data available at `D`. The rate comparison — alpha, the ratio, each `delta_s`, `P`, `N`, `G` and the matched controls — uses the symmetric `W` instead, chosen retrospectively so that no availability change sits inside it; a comparison needs the same clean regime on both sides. Both widths are printed for every death.

Nothing at or after the death enters any share or weight: they are functions of `[D − W_pre, D)` alone. That prevents post-death volume from leaking into the weights. It does not make any of these numbers a measurement of what the death caused, and none of them is read that way here.

An account whose five-hour and weekly windows first read 100 % in the SAME sample left routing once, not twice. Those events are folded into one departure, both window kinds are recorded on it, and the folded event is counted in the reconciliation at the end rather than measured a second time over an identical survivor set and interval.

Request coverage is checked per horizon rather than once at the widest. A death whose loaded request span carries the whole primary interval keeps its primary measurement even where the six-hour interval runs outside that span; the six-hour row is then absent with its reason stated under the death. The gate that excludes a death for having no pre-death traffic reads the PRIMARY horizon, the one the numbers are reported from.

The bucket containing the death is in neither half — a bucket enters pre only if it ends at or before `D`, and post only if it starts at or after it — so up to one minute is uncounted on each side.

`requests.timestamp` is stamped when the row is persisted rather than when the request was made, and `D` is the first sampled 100 % reading rather than the instant routing changed, so persistence lag and sampled exhaustion timing misalign these intervals with both request execution and the routing change. The direction and magnitude of the resulting error are unmeasured. The misalignment matters more as `W` shrinks. `D` can be later than the routing interruption, so redistribution can already appear inside the nominal pre window.

Both bases are reported because request count and token volume answer different questions — the scenario redistributes capacity units, not requests — and where the two disagree, both are printed, and neither is preferred here.

No confidence interval, bootstrap or p-value is computed here. The blocks are deaths, they cluster on a handful of accounts and in time, and this many correlated blocks cannot support an interval. There is no threshold split of any kind either: a cut point read off the same data it is applied to is a fit rather than a measurement. The per-death table below prints every analysed death, sorted by the dying account's pre-death share, and is the deliverable at this n; the aggregate is a summary of it.

A window fills because its account was busy, and often its class with it. A class-specific surge that both killed the peer and raised survivor traffic is not removable from observational data, and nothing here removes it.

Definitions, per basis, over the survivor set `S` and the dying account `d`:

```
preRate_a          = volume(a, [D-W, D))     / minutes counted in [D-W, D)
postRate_a         = volume(a, [D, D+W))     / minutes counted in [D, D+W)
weightRate_a       = volume(a, [D-W_pre, D)) / minutes counted in [D-W_pre, D)
dyingPreShare      = weightRate_d / (weightRate_d + sum over S of weightRate_s)
survivorPreShare_s = weightRate_s / sum over S of weightRate_s
equalSplitShare    = 1 / |S|
alpha              = (postRateSurv - preRateSurv) / preRateDying
survivorRateRatio  = postRateSurv / preRateSurv
delta_s            = postRate_s - preRate_s
contribution_s     = delta_s / preRateDying      (these sum to alpha)
P                  = sum over S of max(delta_s, 0)
N                  = sum over S of max(-delta_s, 0)
G                  = P - N
largestGainShare   = max_s max(delta_s, 0) / P   (null when G <= 0)
```

`alpha = (ratio - 1) * preRateSurv / preRateDying`, so the same ratio change is a different normalised gain at a different PRE-DEATH RATE BALANCE OVER `W`: the dying account's share of pre-death rate over `W`, `preRateDying / (preRateDying + preRateSurv)`. That balance is not the `dying pre-share` column, which is measured over `W_pre`; where the two widths differ the two numbers can differ, and both are correct over their own interval. A ratio difference does not measure a fraction of the dying account's demand. The raw rates over `W` and the raw volumes over `W_pre` are printed beside both.

`largestGainShare` is the largest account's share of positive rate increases. It is not a share of the volume that moved: it divides one account's rise by the sum of the rises and does not see the falls, which is why it has no value where the survivor set's net change `G` is zero or negative.

A survivor with zero pre-death traffic leaves the ratio and the pre-share without a value. It stays visible in the per-death table with its raw rates rather than being dropped from the pairing, because dropping it would silently change the survivor set the aggregate is taken over.

A quantity with no value prints a dash and is never coerced to zero: alpha has no value when the dying account had no pre-death traffic, the largest gain share has none when `G <= 0`, and the survivor rate ratio has none when the survivors had no pre-death traffic.

Matched controls sit at the same instant ±7 d, so weekday and hour are both matched, and are measured over the IDENTICAL survivor set at the IDENTICAL half-width. A control is used only when its whole interval lies inside the loaded request span, every account of `S` and the dying account is available across the whole of it, and no member of the class changes availability state or is created inside it. Whether the workload repeats at a one-week offset is what the control ratios show, and a control's own interval can be a quiet stretch rather than a matched one; the per-death table prints each control's ratio beside the death's so the reader can see which, and the pairing below is stated apart from the aggregate rather than as a headline. Ineligible controls are counted rather than skipped: 10 outside the loaded span, 45 with a class member changing availability state or being created inside the interval.

The other class's ratio over the same interval is printed as concurrent context, and never enters any subtraction. A single account can supply it, in which case its concentration statistics are mechanically trivial: with one account the equal split is 1 and the largest gain share is 1 or nothing. A developer can substitute between providers, so the other class is not assumed unaffected by the death either.

| population | basis | measurements in population | ratio n | median survivor rate ratio | alpha n | median alpha | gain-share n | median largest gain share | split n | median equal split 1/S | dying-share n | median dying pre-share |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| at death (W ≤ 60 min) | requests | 33 | 31 | 1.457 | 33 | 0.200 | 22 | 100.0% | 33 | 50.0% | 33 | 67.0% |
| at death (W ≤ 60 min) | tokens | 33 | 30 | 1.812 | 33 | 0.351 | 24 | 100.0% | 33 | 50.0% | 33 | 73.8% |
| at death (W ≤ 6 h) | requests | 17 | 16 | 0.586 | 17 | -0.222 | 8 | 100.0% | 17 | 50.0% | 17 | 66.2% |
| at death (W ≤ 6 h) | tokens | 17 | 15 | 0.744 | 17 | -0.203 | 8 | 100.0% | 17 | 50.0% | 17 | 69.1% |
| at death (W ≤ 60 min, deaths also measured at W ≤ 6 h) | requests | 17 | 16 | 1.032 | 17 | 0.160 | 10 | 100.0% | 17 | 50.0% | 17 | 55.6% |
| at death (W ≤ 60 min, deaths also measured at W ≤ 6 h) | tokens | 17 | 15 | 1.051 | 17 | 0.158 | 10 | 100.0% | 17 | 50.0% | 17 | 61.7% |
| matched control -7 d (W ≤ 60 min) | requests | 15 | 5 | 0.950 | 2 | -0.354 | 2 | 69.0% | 15 | 50.0% | 5 | 0.0% |
| matched control -7 d (W ≤ 60 min) | tokens | 15 | 5 | 0.992 | 2 | 1.606 | 2 | 92.7% | 15 | 50.0% | 5 | 0.0% |
| matched control +7 d (W ≤ 60 min) | requests | 16 | 9 | 1.518 | 6 | 0.506 | 7 | 100.0% | 16 | 50.0% | 9 | 7.7% |
| matched control +7 d (W ≤ 60 min) | tokens | 16 | 8 | 1.108 | 6 | 0.474 | 7 | 100.0% | 16 | 50.0% | 9 | 3.3% |
| matched control -7 d (W ≤ 6 h) | requests | 5 | 3 | 0.878 | 2 | -1.166 | 1 | 100.0% | 5 | 33.3% | 3 | 8.8% |
| matched control -7 d (W ≤ 6 h) | tokens | 5 | 3 | 0.912 | 2 | -2.261 | 1 | 100.0% | 5 | 33.3% | 3 | 3.5% |
| matched control +7 d (W ≤ 6 h) | requests | 9 | 7 | 2.784 | 7 | 0.113 | 4 | 97.6% | 9 | 33.3% | 8 | 51.7% |
| matched control +7 d (W ≤ 6 h) | tokens | 9 | 6 | 1.018 | 7 | 0.106 | 5 | 100.0% | 9 | 33.3% | 8 | 32.1% |
| other class, same interval (W ≤ 60 min) | requests | 33 | 31 | 0.514 | 0 | — | 9 | 100.0% | 33 | 100.0% | 0 | — |
| other class, same interval (W ≤ 60 min) | tokens | 33 | 31 | 0.458 | 0 | — | 10 | 100.0% | 33 | 100.0% | 0 | — |
| other class, same interval (W ≤ 6 h) | requests | 17 | 16 | 0.256 | 0 | — | 4 | 100.0% | 17 | 100.0% | 0 | — |
| other class, same interval (W ≤ 6 h) | tokens | 17 | 16 | 0.256 | 0 | — | 5 | 100.0% | 17 | 100.0% | 0 | — |

Each statistic carries its own denominator: a row's `measurements in population` count is every measurement of that population, and the `n` beside a median is the subset of them where that statistic has a value.

The pairing is a difference of two ratios rather than a ratio, so it is printed in its own table rather than in the columns above. Its `n` is the deaths carrying a ratio at the death AND at an eligible control, and where both control offsets are eligible their ratios are averaged before the difference is taken.

| pairing | basis | n | median delta |
|---|---|---:|---:|
| paired median of (ratio at death − mean ratio at eligible controls), W ≤ 60 min | requests | 12 | -0.021 |
| paired median of (ratio at death − mean ratio at eligible controls), W ≤ 60 min | tokens | 11 | 0.444 |
| paired median of (ratio at death − mean ratio at eligible controls), W ≤ 6 h | requests | 8 | -0.399 |
| paired median of (ratio at death − mean ratio at eligible controls), W ≤ 6 h | tokens | 7 | 0.702 |

Every analysed death, one block each — requests above tokens on both horizons — with one line per survivor underneath. Volumes are raw counts and raw tokens over the half-window; rates are those divided by the minutes counted.

**Event 31** — 2026-07-28T19:36:41.291Z — anthropic / five_hour — dying `Claude-3` — S = `Claude-2`, `Claude-4`, `Claude-1`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 79 | 1069 | 59 | 59 | 79 | 6 | 1069 | 675 | 6.9% | -4.987 | 0.631 | 0.000 | 6.678 | -6.678 | — | availability-change-inside: Claude-4 is unknown at the start of the interval | 5.190 |
| W = 60 min | tokens | 60 | 20149740 | 196248569 | 59 | 59 | 20149740 | 1250961 | 196248569 | 130934536 | 9.3% | -3.241 | 0.667 | 0 | 1107018 | -1107018 | — | availability-change-inside: Claude-4 is unknown at the start of the interval | 2.673 |
| W = 96 min | requests | 96 | 393 | 1732 | 95 | 95 | 393 | 6 | 1732 | 884 | 18.5% | -2.158 | 0.510 | 0.189 | 9.116 | -8.926 | — | availability-change-inside: Claude-4 is unknown at the start of the interval | 4.542 |
| W = 96 min | tokens | 96 | 87356580 | 319775924 | 95 | 95 | 87356580 | 1250961 | 319775924 | 180627433 | 21.5% | -1.593 | 0.565 | 40584 | 1505305 | -1464721 | — | availability-change-inside: Claude-4 is unknown at the start of the interval | 2.566 |

- Availability bound: 96 min, set by `Claude-2`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 96 min: 96 min, bounded by the nearest availability change of a class member before it.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-2`: requests pre 18.085, post 11.441, delta -6.644, contribution -4.962, pre-share 99.8%; tokens pre 3321770, post 2219229, delta -1102540, contribution -3.228, pre-share 99.9%
  - `Claude-4`: requests pre 0.017, post 0.000, delta -0.017, contribution -0.013, pre-share 0.1%; tokens pre 4201, post 0, delta -4201, contribution -0.012, pre-share 0.1%
  - `Claude-1`: requests pre 0.017, post 0.000, delta -0.017, contribution -0.013, pre-share 0.1%; tokens pre 276, post 0, delta -276, contribution -0.001, pre-share 0.0%
- excluded members: none

**Event 53** — 2026-09-03T12:37:55.770Z — anthropic / five_hour — dying `Claude-2` — S = `Claude-3`, `Claude-4`, `Claude-1`, `Claude-5`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 439 | 5172 | 59 | 59 | 439 | 0 | 5172 | 2759 | 7.8% | -5.497 | 0.533 | 39.390 | 80.288 | -40.898 | — | 0.950 | outside-loaded-span: the interval leaves the span the request table was read over |
| W = 60 min | tokens | 60 | 85874020 | 849544915 | 59 | 59 | 85874020 | 0 | 849544915 | 484180964 | 9.2% | -4.255 | 0.570 | 6588842 | 12781452 | -6192609 | — | 1.082 | outside-loaded-span: the interval leaves the span the request table was read over |
| W = 134 min | requests | 360 | 3406 | 12466 | 133 | 133 | 3284 | 0 | 8657 | 2835 | 21.5% | -1.773 | 0.327 | 18.030 | 61.805 | -43.774 | — | 0.878 | outside-loaded-span: the interval leaves the span the request table was read over |
| W = 134 min | tokens | 360 | 486586902 | 1861635853 | 133 | 133 | 455727177 | 0 | 1288343021 | 490616977 | 20.7% | -1.750 | 0.381 | 2971261 | 8969201 | -5997940 | — | 0.912 | outside-loaded-span: the interval leaves the span the request table was read over |

- Availability bound: 134 min, set by `Claude-2`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 134 min: 360 min, bounded by the horizon's own cap.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-3`: requests pre 74.475, post 1.034, delta -73.441, contribution -9.870, pre-share 85.0%; tokens pre 11720798, post 206909, delta -11513888, contribution -7.911, pre-share 81.4%
  - `Claude-4`: requests pre 6.254, post 45.644, delta 39.390, contribution 5.294, pre-share 7.1%; tokens pre 1400378, post 7989220, delta 6588842, contribution 4.527, pre-share 9.7%
  - `Claude-1`: requests pre 0.119, post 0.085, delta -0.034, contribution -0.005, pre-share 0.1%; tokens pre 18170, post 10328, delta -7842, contribution -0.005, pre-share 0.1%
  - `Claude-5`: requests pre 6.814, post 0.000, delta -6.814, contribution -0.916, pre-share 7.8%; tokens pre 1259721, post 0, delta -1259721, contribution -0.865, pre-share 8.7%
- excluded members: none

**Event 35** — 2026-08-04T15:44:49.581Z — anthropic / five_hour — dying `Claude-3` — S = `Claude-2`, `Claude-4`, `Claude-1`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 187 | 2077 | 59 | 59 | 187 | 2 | 2077 | 1532 | 8.3% | -2.914 | 0.738 | 3.373 | 12.610 | -9.237 | — | availability-change-inside: Claude-3 is exhausted at the start of the interval | 0.025 |
| W = 60 min | tokens | 60 | 64500800 | 210555452 | 59 | 59 | 64500800 | 835476 | 210555452 | 169365189 | 23.5% | -0.639 | 0.804 | 960957 | 1659097 | -698140 | — | availability-change-inside: Claude-3 is exhausted at the start of the interval | 0.047 |
| W = 76 min | requests | 360 | 726 | 4508 | 75 | 75 | 385 | 2 | 2473 | 1716 | 13.9% | -1.966 | 0.694 | 4.613 | 14.707 | -10.093 | — | availability-change-inside: Claude-3 is exhausted at the start of the interval | 0.009 |
| W = 76 min | tokens | 360 | 197028052 | 570678510 | 75 | 75 | 86510601 | 835476 | 265172853 | 197248619 | 25.7% | -0.785 | 0.744 | 1079612 | 1985269 | -905656 | — | availability-change-inside: Claude-3 is exhausted at the start of the interval | 0.008 |

- Availability bound: 76 min, set by `Claude-3`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 76 min: 360 min, bounded by the horizon's own cap.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-2`: requests pre 4.576, post 7.949, delta 3.373, contribution 1.064, pre-share 13.0%; tokens pre 527372, post 1488329, delta 960957, contribution 0.879, pre-share 14.8%
  - `Claude-4`: requests pre 0.000, post 0.000, delta 0.000, contribution 0.000, pre-share 0.0%; tokens pre 0, post 0, delta 0, contribution 0.000, pre-share 0.0%
  - `Claude-1`: requests pre 30.627, post 18.017, delta -12.610, contribution -3.979, pre-share 87.0%; tokens pre 3041365, post 1382268, delta -1659097, contribution -1.518, pre-share 85.2%
- excluded members: none

**Event 45** — 2026-08-24T12:12:49.311Z — anthropic / five_hour — dying `Claude-1` — S = `Claude-2`, `Claude-3`, `Claude-4`, `Claude-5`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 49 min | requests | 60 | 325 | 1206 | 47 | 48 | 222 | 0 | 1144 | 1052 | 21.2% | -0.513 | 0.900 | 11.073 | 13.497 | -2.424 | — | availability-change-inside: Claude-5 is unknown at the start of the interval | 1.040 |
| W = 49 min | tokens | 60 | 114794388 | 261880678 | 47 | 48 | 90642551 | 0 | 254961313 | 262496895 | 30.5% | 0.023 | 1.008 | 2645348 | 2601372 | 43977 | 89.1% | availability-change-inside: Claude-5 is unknown at the start of the interval | 1.108 |

- 6 h horizon absent: the availability bound of 49 min caps the six-hour horizon at the 49 min it is already measured over.
- Availability bound: 49 min, set by `Claude-1`.
- W_pre at W = 49 min: 60 min, bounded by the horizon's own cap.
- Survivors, at W = 49 min (W_pre = 60 min):
  - `Claude-2`: requests pre 1.596, post 1.333, delta -0.262, contribution -0.056, pre-share 6.2%; tokens pre 213852, post 169543, delta -44309, contribution -0.023, pre-share 3.8%
  - `Claude-3`: requests pre 1.574, post 10.958, delta 9.384, contribution 1.987, pre-share 9.5%; tokens pre 341510, post 2699518, delta 2358009, contribution 1.223, pre-share 7.8%
  - `Claude-4`: requests pre 0.915, post 2.604, delta 1.689, contribution 0.358, pre-share 3.6%; tokens pre 388364, post 675704, delta 287340, contribution 0.149, pre-share 7.1%
  - `Claude-5`: requests pre 20.255, post 7.021, delta -13.234, contribution -2.802, pre-share 80.6%; tokens pre 4480983, post 1923920, delta -2557062, contribution -1.326, pre-share 81.2%
- excluded members: none

**Event 20** — 2026-07-24T17:16:53.597Z — anthropic / five_hour — dying `Claude-4` — S = `Claude-2`, `Claude-3`, `Claude-1`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 26 min | requests | 60 | 628 | 1776 | 25 | 25 | 313 | 6 | 230 | 354 | 26.1% | 0.396 | 1.539 | 7.240 | 2.280 | 4.960 | 56.9% | availability-change-inside: Claude-4 is unknown at the start of the interval | — |
| W = 26 min | tokens | 60 | 170501872 | 143627407 | 25 | 25 | 74643969 | 914686 | 20511874 | 46696842 | 54.3% | 0.351 | 2.277 | 1317971 | 270573 | 1047399 | 76.1% | availability-change-inside: Claude-4 is unknown at the start of the interval | — |

- 6 h horizon absent: the availability bound of 26 min caps the six-hour horizon at the 26 min it is already measured over.
- Availability bound: 26 min, set by `Claude-2`.
- W_pre at W = 26 min: 60 min, bounded by the horizon's own cap.
- Survivors, at W = 26 min (W_pre = 60 min):
  - `Claude-2`: requests pre 1.120, post 5.240, delta 4.120, contribution 0.329, pre-share 4.1%; tokens pre 97832, post 1101418, delta 1003586, contribution 0.336, pre-share 15.1%
  - `Claude-3`: requests pre 8.080, post 5.800, delta -2.280, contribution -0.182, pre-share 95.9%; tokens pre 722643, post 452070, delta -270573, contribution -0.091, pre-share 84.9%
  - `Claude-1`: requests pre 0.000, post 3.120, delta 3.120, contribution 0.249, pre-share 0.0%; tokens pre 0, post 314385, delta 314385, contribution 0.105, pre-share 0.0%
- excluded members: none

**Event 42** — 2026-08-17T17:53:47.828Z — anthropic / five_hour — dying `Claude-3` — S = `Claude-2`, `Claude-4`, `Claude-1`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 305 | 731 | 59 | 59 | 305 | 0 | 731 | 913 | 29.4% | 0.597 | 1.249 | 3.085 | 0.000 | 3.085 | 99.5% | availability-change-inside: Claude-2 is exhausted at the start of the interval | 1.270 |
| W = 60 min | tokens | 60 | 149799554 | 167424270 | 59 | 59 | 149799554 | 0 | 167424270 | 253530689 | 47.2% | 0.575 | 1.514 | 1459431 | 0 | 1459431 | 99.5% | availability-change-inside: Claude-2 is exhausted at the start of the interval | 1.071 |
| W = 196 min | requests | 208 | 683 | 3147 | 195 | 195 | 683 | 0 | 3102 | 1819 | 17.8% | -1.878 | 0.586 | 0.005 | 6.585 | -6.579 | — | availability-change-inside: Claude-2 is exhausted at the start of the interval | 0.985 |
| W = 196 min | tokens | 208 | 287205309 | 662902844 | 195 | 195 | 287205309 | 0 | 654162354 | 552819641 | 30.2% | -0.353 | 0.845 | 2100 | 521806 | -519706 | — | availability-change-inside: Claude-2 is exhausted at the start of the interval | 1.018 |

- Availability bound: 196 min, set by `Claude-3`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 196 min: 208 min, bounded by the nearest availability change of a class member before it.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-2`: requests pre 12.390, post 15.458, delta 3.068, contribution 0.593, pre-share 100.0%; tokens pre 2837699, post 4290190, delta 1452490, contribution 0.572, pre-share 100.0%
  - `Claude-4`: requests pre 0.000, post 0.017, delta 0.017, contribution 0.003, pre-share 0.0%; tokens pre 0, post 6941, delta 6941, contribution 0.003, pre-share 0.0%
  - `Claude-1`: requests pre 0.000, post 0.000, delta 0.000, contribution 0.000, pre-share 0.0%; tokens pre 0, post 0, delta 0, contribution 0.000, pre-share 0.0%
- excluded members: none

**Event 48** — 2026-09-02T07:17:12.861Z — anthropic / five_hour — dying `Claude-1` — S = `Claude-2`, `Claude-3`, `Claude-4`, `Claude-5`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 403 | 837 | 59 | 59 | 403 | 0 | 837 | 914 | 32.5% | 0.191 | 1.092 | 6.068 | 4.763 | 1.305 | 100.0% | — | outside-loaded-span: the interval leaves the span the request table was read over |
| W = 60 min | tokens | 60 | 77668505 | 98782521 | 59 | 59 | 77668505 | 0 | 98782521 | 178969268 | 44.0% | 1.032 | 1.812 | 1476467 | 117370 | 1359097 | 100.0% | — | outside-loaded-span: the interval leaves the span the request table was read over |
| W = 74 min | requests | 360 | 1683 | 837 | 73 | 73 | 466 | 0 | 837 | 1313 | 66.8% | 1.021 | 1.569 | 7.219 | 0.699 | 6.521 | 98.3% | — | outside-loaded-span: the interval leaves the span the request table was read over |
| W = 74 min | tokens | 360 | 298359847 | 98782521 | 73 | 73 | 91874577 | 0 | 98782521 | 236436094 | 75.1% | 1.498 | 2.394 | 1885665 | 0 | 1885665 | 80.5% | — | outside-loaded-span: the interval leaves the span the request table was read over |

- Availability bound: 74 min, set by `Claude-1`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 74 min: 360 min, bounded by the horizon's own cap.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-2`: requests pre 0.000, post 6.068, delta 6.068, contribution 0.888, pre-share 0.0%; tokens pre 0, post 1476467, delta 1476467, contribution 1.122, pre-share 0.0%
  - `Claude-3`: requests pre 0.000, post 0.000, delta 0.000, contribution 0.000, pre-share 0.0%; tokens pre 0, post 0, delta 0, contribution 0.000, pre-share 0.0%
  - `Claude-4`: requests pre 0.000, post 0.000, delta 0.000, contribution 0.000, pre-share 0.0%; tokens pre 0, post 0, delta 0, contribution 0.000, pre-share 0.0%
  - `Claude-5`: requests pre 14.186, post 9.424, delta -4.763, contribution -0.697, pre-share 100.0%; tokens pre 1674280, post 1556910, delta -117370, contribution -0.089, pre-share 100.0%
- excluded members: none

**Event 28** — 2026-07-28T13:42:08.510Z — anthropic / five_hour — dying `Claude-3` — S = `Claude-2`, `Claude-4`, `Claude-1`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 548 | 1055 | 59 | 59 | 548 | 3 | 1055 | 1537 | 34.2% | 0.880 | 1.457 | 8.763 | 0.593 | 8.169 | 100.0% | availability-change-inside: Claude-4 is unknown at the start of the interval | 2.480 |
| W = 60 min | tokens | 60 | 100350762 | 92704341 | 59 | 59 | 100350762 | 740068 | 92704341 | 191316826 | 52.0% | 0.983 | 2.064 | 1865065 | 193667 | 1671398 | 100.0% | availability-change-inside: Claude-4 is unknown at the start of the interval | 1.826 |
| W = 96 min | requests | 280 | 4801 | 2902 | 95 | 95 | 1731 | 3 | 1056 | 2005 | 62.3% | 0.548 | 1.899 | 10.053 | 0.063 | 9.989 | 64.8% | availability-change-inside: Claude-4 is unknown at the start of the interval | 2.983 |
| W = 96 min | tokens | 280 | 563958010 | 351546005 | 95 | 95 | 285724171 | 740068 | 92845819 | 294426524 | 61.6% | 0.706 | 3.171 | 2138105 | 16203 | 2121902 | 69.7% | availability-change-inside: Claude-4 is unknown at the start of the interval | 1.772 |

- Availability bound: 96 min, set by `Claude-2`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 96 min: 280 min, bounded by the nearest availability change of a class member before it.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-2`: requests pre 16.492, post 25.254, delta 8.763, contribution 0.943, pre-share 92.2%; tokens pre 1327549, post 3192614, delta 1865065, contribution 1.097, pre-share 84.5%
  - `Claude-4`: requests pre 1.305, post 0.797, delta -0.508, contribution -0.055, pre-share 7.3%; tokens pre 220019, post 50044, delta -169975, contribution -0.100, pre-share 14.0%
  - `Claude-1`: requests pre 0.085, post 0.000, delta -0.085, contribution -0.009, pre-share 0.5%; tokens pre 23692, post 0, delta -23692, contribution -0.014, pre-share 1.5%
- excluded members: none

**Event 38** — 2026-08-07T19:02:42.073Z — anthropic / seven_day — dying `Claude-2` — S = `Claude-3`, `Claude-4`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 56 min | requests | 60 | 267 | 310 | 55 | 55 | 253 | 220 | 303 | 177 | 46.3% | -0.498 | 0.584 | 0.582 | 2.873 | -2.291 | — | — | — |
| W = 56 min | tokens | 60 | 126125538 | 52586733 | 55 | 55 | 121273187 | 43653296 | 51644585 | 44194344 | 70.6% | -0.061 | 0.856 | 378452 | 513911 | -135459 | — | — | — |

- 6 h horizon absent: the availability bound of 56 min caps the six-hour horizon at the 56 min it is already measured over.
- Availability bound: 56 min, set by `Claude-3`.
- W_pre at W = 56 min: 60 min, bounded by the horizon's own cap.
- Survivors, at W = 56 min (W_pre = 60 min):
  - `Claude-3`: requests pre 2.545, post 3.127, delta 0.582, contribution 0.126, pre-share 45.2%; tokens pre 400929, post 779380, delta 378452, contribution 0.172, pre-share 41.9%
  - `Claude-4`: requests pre 2.964, post 0.091, delta -2.873, contribution -0.625, pre-share 54.8%; tokens pre 538064, post 24153, delta -513911, contribution -0.233, pre-share 58.1%
- excluded members: Claude-1 (exhausted)

**Event 34** — 2026-08-03T18:06:23.413Z — anthropic / seven_day — dying `Claude-2` — S = `Claude-3`, `Claude-4`, `Claude-1`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 374 | 310 | 59 | 59 | 374 | 0 | 310 | 320 | 54.7% | 0.027 | 1.032 | 2.136 | 1.966 | 0.169 | 100.0% | availability-change-inside: Claude-2 is exhausted at the start of the interval | availability-change-inside: Claude-2 is exhausted at the start of the interval |
| W = 60 min | tokens | 60 | 65967343 | 66814799 | 59 | 59 | 65967343 | 0 | 66814799 | 82950713 | 49.7% | 0.245 | 1.242 | 455247 | 181757 | 273490 | 100.0% | availability-change-inside: Claude-2 is exhausted at the start of the interval | availability-change-inside: Claude-2 is exhausted at the start of the interval |
| W = 360 min | requests | 360 | 1175 | 3002 | 359 | 359 | 1175 | 0 | 3002 | 732 | 28.1% | -1.932 | 0.244 | 0.482 | 6.805 | -6.323 | — | availability-change-inside: Claude-2 is exhausted at the start of the interval | availability-change-inside: Claude-2 is exhausted at the start of the interval |
| W = 360 min | tokens | 360 | 221990571 | 605224950 | 359 | 359 | 221990571 | 0 | 605224950 | 200503730 | 26.8% | -1.823 | 0.331 | 125046 | 1252403 | -1127357 | — | availability-change-inside: Claude-2 is exhausted at the start of the interval | availability-change-inside: Claude-2 is exhausted at the start of the interval |

- Availability bound: 536 min, set by `Claude-2`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 360 min: 360 min, bounded by the horizon's own cap.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-3`: requests pre 0.678, post 2.814, delta 2.136, contribution 0.337, pre-share 12.9%; tokens pre 360223, post 815470, delta 455247, contribution 0.407, pre-share 31.8%
  - `Claude-4`: requests pre 0.000, post 0.000, delta 0.000, contribution 0.000, pre-share 0.0%; tokens pre 0, post 0, delta 0, contribution 0.000, pre-share 0.0%
  - `Claude-1`: requests pre 4.576, post 2.610, delta -1.966, contribution -0.310, pre-share 87.1%; tokens pre 772231, post 590475, delta -181757, contribution -0.163, pre-share 68.2%
- excluded members: none

**Event 17** — 2026-07-20T19:22:06.633Z — anthropic / five_hour — dying `Claude-3` — S = `Claude-2`, `Claude-1`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 541 | 440 | 59 | 59 | 541 | 2 | 440 | 138 | 55.1% | -0.558 | 0.314 | 0.000 | 5.119 | -5.119 | — | availability-change-inside: Claude-3 is unknown at the start of the interval | availability-change-inside: Claude-2 is exhausted at the start of the interval |
| W = 60 min | tokens | 60 | 128116355 | 76298277 | 59 | 59 | 128116355 | 374105 | 76298277 | 38863590 | 62.7% | -0.292 | 0.509 | 0 | 634486 | -634486 | — | availability-change-inside: Claude-3 is unknown at the start of the interval | availability-change-inside: Claude-2 is exhausted at the start of the interval |
| W = 110 min | requests | 360 | 1185 | 2285 | 109 | 109 | 890 | 2 | 779 | 138 | 34.1% | -0.720 | 0.177 | 0.000 | 5.881 | -5.881 | — | availability-change-inside: Claude-3 is unknown at the start of the interval | availability-change-inside: Claude-2 is exhausted at the start of the interval |
| W = 110 min | tokens | 360 | 223978821 | 454371643 | 109 | 109 | 178554414 | 374105 | 141641958 | 38863590 | 33.0% | -0.576 | 0.274 | 0 | 942921 | -942921 | — | availability-change-inside: Claude-3 is unknown at the start of the interval | availability-change-inside: Claude-2 is exhausted at the start of the interval |

- Availability bound: 110 min, set by `Claude-3`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 110 min: 360 min, bounded by the horizon's own cap.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-2`: requests pre 7.458, post 2.339, delta -5.119, contribution -0.558, pre-share 100.0%; tokens pre 1293191, post 658705, delta -634486, contribution -0.292, pre-share 100.0%
  - `Claude-1`: requests pre 0.000, post 0.000, delta 0.000, contribution 0.000, pre-share 0.0%; tokens pre 0, post 0, delta 0, contribution 0.000, pre-share 0.0%
- excluded members: none

**Event 9** — 2026-07-11T11:41:13.710Z — anthropic / five_hour — dying `Claude-2` — S = `Claude-1`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 250 | 200 | 59 | 59 | 250 | 0 | 200 | 0 | 55.6% | -0.800 | 0.000 | 0.000 | 3.390 | -3.390 | — | availability-change-inside: Claude-1 is exhausted at the start of the interval | — |
| W = 60 min | tokens | 60 | 144677611 | 89817002 | 59 | 59 | 144677611 | 0 | 89817002 | 0 | 61.7% | -0.621 | 0.000 | 0 | 1522322 | -1522322 | — | availability-change-inside: Claude-1 is exhausted at the start of the interval | — |
| W = 192 min | requests | 360 | 847 | 415 | 191 | 191 | 847 | 0 | 415 | 0 | 67.1% | -0.490 | 0.000 | 0.000 | 2.173 | -2.173 | — | availability-change-inside: Claude-1 is exhausted at the start of the interval | — |
| W = 192 min | tokens | 360 | 474299892 | 170103353 | 191 | 191 | 474299892 | 0 | 170103353 | 0 | 73.6% | -0.359 | 0.000 | 0 | 890593 | -890593 | — | availability-change-inside: Claude-1 is exhausted at the start of the interval | — |

- Availability bound: 192 min, set by `Claude-2`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 192 min: 360 min, bounded by the horizon's own cap.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-1`: requests pre 3.390, post 0.000, delta -3.390, contribution -0.800, pre-share 100.0%; tokens pre 1522322, post 0, delta -1522322, contribution -0.621, pre-share 100.0%
- excluded members: Claude-3 (unknown)

**Event 30** — 2026-07-28T15:18:09.431Z — anthropic / five_hour — dying `Claude-2` — S = `Claude-4`, `Claude-1`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 558 | 412 | 59 | 59 | 558 | 0 | 412 | 1058 | 57.5% | 1.158 | 2.568 | 10.949 | 0.000 | 10.949 | 99.2% | availability-change-inside: Claude-4 is unknown at the start of the interval | availability-change-inside: Claude-3 changes availability at 2026-08-04T15:44:49.581Z |
| W = 60 min | tokens | 60 | 89184934 | 74217344 | 59 | 59 | 89184934 | 0 | 74217344 | 230221300 | 54.6% | 1.749 | 3.102 | 2644135 | 0 | 2644135 | 99.4% | availability-change-inside: Claude-4 is unknown at the start of the interval | availability-change-inside: Claude-3 changes availability at 2026-08-04T15:44:49.581Z |
| W = 94 min | requests | 96 | 1592 | 413 | 93 | 92 | 1585 | 0 | 412 | 1226 | 79.4% | 0.522 | 3.008 | 8.896 | 0.000 | 8.896 | 98.0% | availability-change-inside: Claude-4 is unknown at the start of the interval | availability-change-inside: Claude-3 changes availability at 2026-08-04T15:44:49.581Z |
| W = 94 min | tokens | 96 | 219823757 | 74602767 | 93 | 92 | 218970968 | 0 | 74217344 | 259212353 | 74.7% | 0.858 | 3.531 | 2019490 | 0 | 2019490 | 99.2% | availability-change-inside: Claude-4 is unknown at the start of the interval | availability-change-inside: Claude-3 changes availability at 2026-08-04T15:44:49.581Z |

- Availability bound: 94 min, set by `Claude-2`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 94 min: 96 min, bounded by the nearest availability change of a class member before it.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-4`: requests pre 6.983, post 17.847, delta 10.864, contribution 1.149, pre-share 100.0%; tokens pre 1257921, post 3885168, delta 2627247, contribution 1.738, pre-share 100.0%
  - `Claude-1`: requests pre 0.000, post 0.085, delta 0.085, contribution 0.009, pre-share 0.0%; tokens pre 0, post 16888, delta 16888, contribution 0.011, pre-share 0.0%
- excluded members: Claude-3 (exhausted)

**Event 51** — 2026-09-02T17:18:29.332Z — anthropic / five_hour — dying `Claude-5` — S = `Claude-3`, `Claude-4`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 50 min | requests | 60 | 1903 | 1396 | 49 | 49 | 1442 | 0 | 1396 | 3366 | 57.7% | 1.366 | 2.411 | 40.204 | 0.000 | 40.204 | 92.2% | — | outside-loaded-span: the interval leaves the span the request table was read over |
| W = 50 min | tokens | 60 | 332609198 | 170161909 | 49 | 49 | 264189702 | 0 | 170161909 | 429356762 | 66.2% | 0.981 | 2.523 | 5289691 | 0 | 5289691 | 92.7% | — | outside-loaded-span: the interval leaves the span the request table was read over |

- 6 h horizon absent: the availability bound of 50 min caps the six-hour horizon at the 50 min it is already measured over.
- Availability bound: 50 min, set by `Claude-3`.
- W_pre at W = 50 min: 60 min, bounded by the horizon's own cap.
- Survivors, at W = 50 min (W_pre = 60 min):
  - `Claude-3`: requests pre 28.245, post 65.306, delta 37.061, contribution 1.259, pre-share 99.1%; tokens pre 3453357, post 8356267, delta 4902911, contribution 0.909, pre-share 99.4%
  - `Claude-4`: requests pre 0.245, post 3.388, delta 3.143, contribution 0.107, pre-share 0.9%; tokens pre 19335, post 406116, delta 386780, contribution 0.072, pre-share 0.6%
- excluded members: Claude-2 (exhausted), Claude-1 (exhausted)

**Event 12** — 2026-07-19T14:25:04.566Z — anthropic / five_hour — dying `Claude-1` — S = `Claude-2`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 50 min | requests | 60 | 138 | 101 | 49 | 49 | 138 | 0 | 101 | 653 | 57.7% | 4.000 | 6.465 | 11.265 | 0.000 | 11.265 | 100.0% | — | availability-change-inside: Claude-2 is exhausted at the start of the interval |
| W = 50 min | tokens | 60 | 59013204 | 17616561 | 49 | 49 | 59013204 | 0 | 17616561 | 188839663 | 77.0% | 2.901 | 10.719 | 3494349 | 0 | 3494349 | 100.0% | — | availability-change-inside: Claude-2 is exhausted at the start of the interval |

- 6 h horizon absent: the availability bound of 50 min caps the six-hour horizon at the 50 min it is already measured over.
- Availability bound: 50 min, set by `Claude-2`.
- W_pre at W = 50 min: 60 min, bounded by the horizon's own cap.
- Survivors, at W = 50 min (W_pre = 60 min):
  - `Claude-2`: requests pre 2.061, post 13.327, delta 11.265, contribution 4.000, pre-share 100.0%; tokens pre 359522, post 3853871, delta 3494349, contribution 2.901, pre-share 100.0%
- excluded members: Claude-3 (unknown)

**Event 15** — 2026-07-19T18:21:05.585Z — anthropic / five_hour — dying `Claude-1` — S = `Claude-2`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 306 | 188 | 59 | 59 | 306 | 0 | 188 | 237 | 61.9% | 0.160 | 1.261 | 0.831 | 0.000 | 0.831 | 100.0% | — | availability-change-inside: Claude-2 is exhausted at the start of the interval |
| W = 60 min | tokens | 60 | 161804618 | 89314423 | 59 | 59 | 161804618 | 0 | 89314423 | 93911103 | 64.4% | 0.028 | 1.051 | 77910 | 0 | 77910 | 100.0% | — | availability-change-inside: Claude-2 is exhausted at the start of the interval |
| W = 90 min | requests | 90 | 391 | 200 | 89 | 89 | 391 | 0 | 200 | 257 | 66.2% | 0.146 | 1.285 | 0.640 | 0.000 | 0.640 | 100.0% | — | availability-change-inside: Claude-2 is exhausted at the start of the interval |
| W = 90 min | tokens | 90 | 213799060 | 95711818 | 89 | 89 | 213799060 | 0 | 95711818 | 103825404 | 69.1% | 0.038 | 1.085 | 91164 | 0 | 91164 | 100.0% | — | availability-change-inside: Claude-2 is exhausted at the start of the interval |

- Availability bound: 90 min, set by `Claude-2`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 90 min: 90 min, bounded by the nearest availability change of a class member before it.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-2`: requests pre 3.186, post 4.017, delta 0.831, contribution 0.160, pre-share 100.0%; tokens pre 1513804, post 1591714, delta 77910, contribution 0.028, pre-share 100.0%
- excluded members: Claude-3 (exhausted)

**Event 25** — 2026-07-26T19:02:46.831Z — anthropic / five_hour — dying `Claude-4` — S = `Claude-1`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 48 min | requests | 60 | 1137 | 560 | 47 | 47 | 834 | 1 | 403 | 1373 | 67.0% | 1.163 | 3.407 | 20.638 | 0.000 | 20.638 | 100.0% | availability-change-inside: Claude-4 is unknown at the start of the interval | 4.000 |
| W = 48 min | tokens | 60 | 181894491 | 113533814 | 47 | 47 | 134222630 | 181342 | 84638510 | 234265559 | 61.6% | 1.115 | 2.768 | 3183554 | 0 | 3183554 | 100.0% | availability-change-inside: Claude-4 is unknown at the start of the interval | 4.343 |

- 6 h horizon absent: the availability bound of 48 min caps the six-hour horizon at the 48 min it is already measured over.
- Availability bound: 48 min, set by `Claude-2`.
- W_pre at W = 48 min: 60 min, bounded by the horizon's own cap.
- Survivors, at W = 48 min (W_pre = 60 min):
  - `Claude-1`: requests pre 8.574, post 29.213, delta 20.638, contribution 1.163, pre-share 100.0%; tokens pre 1800819, post 4984374, delta 3183554, contribution 1.115, pre-share 100.0%
- excluded members: Claude-2 (exhausted), Claude-3 (exhausted)

**Event 59** — 2026-09-05T14:11:12.387Z — anthropic / five_hour — dying `Claude-1` — S = `Claude-2`, `Claude-3`, `Claude-4`, `Claude-5`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 58 min | requests | 60 | 1118 | 426 | 57 | 57 | 1118 | 0 | 402 | 1739 | 72.4% | 1.196 | 4.326 | 27.351 | 3.895 | 23.456 | 99.4% | 1.249 | outside-loaded-span: the interval leaves the span the request table was read over |
| W = 58 min | tokens | 60 | 173285586 | 61404476 | 57 | 57 | 173285586 | 0 | 59240648 | 329034555 | 73.8% | 1.557 | 5.554 | 5300013 | 566787 | 4733226 | 98.9% | 0.992 | outside-loaded-span: the interval leaves the span the request table was read over |

- 6 h horizon absent: the availability bound of 58 min caps the six-hour horizon at the 58 min it is already measured over.
- Availability bound: 58 min, set by `Claude-5`.
- W_pre at W = 58 min: 60 min, bounded by the horizon's own cap.
- Survivors, at W = 58 min (W_pre = 60 min):
  - `Claude-2`: requests pre 4.544, post 0.649, delta -3.895, contribution -0.199, pre-share 66.4%; tokens pre 808888, post 242101, delta -566787, contribution -0.186, pre-share 78.6%
  - `Claude-3`: requests pre 0.000, post 0.175, delta 0.175, contribution 0.009, pre-share 0.0%; tokens pre 0, post 58033, delta 58033, contribution 0.019, pre-share 0.0%
  - `Claude-4`: requests pre 0.000, post 0.000, delta 0.000, contribution 0.000, pre-share 0.0%; tokens pre 0, post 0, delta 0, contribution 0.000, pre-share 0.0%
  - `Claude-5`: requests pre 2.509, post 29.684, delta 27.175, contribution 1.386, pre-share 33.6%; tokens pre 230421, post 5472402, delta 5241980, contribution 1.724, pre-share 21.4%
- excluded members: none

**Event 16** — 2026-07-19T22:23:06.461Z — anthropic / five_hour — dying `Claude-3` — S = `Claude-2`, `Claude-1`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 414 | 133 | 59 | 59 | 414 | 11 | 133 | 13 | 75.7% | -0.290 | 0.098 | 0.000 | 2.034 | -2.034 | — | availability-change-inside: Claude-3 is unknown at the start of the interval | availability-change-inside: Claude-3 is exhausted at the start of the interval |
| W = 60 min | tokens | 60 | 129210512 | 38860802 | 59 | 59 | 129210512 | 1349387 | 38860802 | 2450734 | 76.9% | -0.282 | 0.063 | 0 | 617120 | -617120 | — | availability-change-inside: Claude-3 is unknown at the start of the interval | availability-change-inside: Claude-3 is exhausted at the start of the interval |
| W = 92 min | requests | 92 | 693 | 167 | 91 | 91 | 693 | 11 | 167 | 13 | 80.6% | -0.222 | 0.078 | 0.000 | 1.692 | -1.692 | — | availability-change-inside: Claude-3 is unknown at the start of the interval | availability-change-inside: Claude-3 is exhausted at the start of the interval |
| W = 92 min | tokens | 92 | 228813189 | 48897873 | 91 | 91 | 228813189 | 1349387 | 48897873 | 2450734 | 82.4% | -0.203 | 0.050 | 0 | 510408 | -510408 | — | availability-change-inside: Claude-3 is unknown at the start of the interval | availability-change-inside: Claude-3 is exhausted at the start of the interval |

- Availability bound: 92 min, set by `Claude-1`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 92 min: 92 min, bounded by the nearest availability change of a class member before it.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-2`: requests pre 1.644, post 0.000, delta -1.644, contribution -0.234, pre-share 72.9%; tokens pre 440675, post 0, delta -440675, contribution -0.201, pre-share 66.9%
  - `Claude-1`: requests pre 0.610, post 0.220, delta -0.390, contribution -0.056, pre-share 27.1%; tokens pre 217982, post 41538, delta -176444, contribution -0.081, pre-share 33.1%
- excluded members: none

**Event 65** — 2026-09-05T19:33:14.876Z — anthropic / five_hour — dying `Claude-4` — S = `Claude-1`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 38 min | requests | 38 | 477 | 151 | 37 | 37 | 477 | 1 | 151 | 5 | 76.0% | -0.306 | 0.033 | 0.000 | 3.946 | -3.946 | — | — | outside-loaded-span: the interval leaves the span the request table was read over |
| W = 38 min | tokens | 38 | 93600952 | 14464003 | 37 | 37 | 93600952 | 0 | 14464003 | 867601 | 86.6% | -0.145 | 0.060 | 0 | 367470 | -367470 | — | — | outside-loaded-span: the interval leaves the span the request table was read over |

- 6 h horizon absent: the availability bound of 38 min caps the six-hour horizon at the 38 min it is already measured over.
- Availability bound: 38 min, set by `Claude-5`.
- W_pre at W = 38 min: 38 min, bounded by the nearest availability change of a class member before it.
- Survivors, at W = 38 min (W_pre = 38 min):
  - `Claude-1`: requests pre 4.081, post 0.135, delta -3.946, contribution -0.306, pre-share 100.0%; tokens pre 390919, post 23449, delta -367470, contribution -0.145, pre-share 100.0%
- excluded members: Claude-2 (exhausted), Claude-3 (exhausted), Claude-5 (exhausted)

**Event 11** — 2026-07-19T10:59:04.428Z — anthropic / five_hour — dying `Claude-2` — S = `Claude-1`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 52 min | requests | 60 | 822 | 237 | 51 | 51 | 653 | 3 | 237 | 234 | 77.6% | -0.005 | 0.987 | 0.000 | 0.059 | -0.059 | — | — | availability-change-inside: Claude-2 is exhausted at the start of the interval |
| W = 52 min | tokens | 60 | 201142545 | 58638330 | 51 | 51 | 159513622 | 752637 | 58638330 | 66588651 | 77.4% | 0.050 | 1.136 | 155889 | 0 | 155889 | 100.0% | — | availability-change-inside: Claude-2 is exhausted at the start of the interval |

- 6 h horizon absent: the availability bound of 52 min caps the six-hour horizon at the 52 min it is already measured over.
- Availability bound: 52 min, set by `Claude-2`.
- W_pre at W = 52 min: 60 min, bounded by the horizon's own cap.
- Survivors, at W = 52 min (W_pre = 60 min):
  - `Claude-1`: requests pre 4.647, post 4.588, delta -0.059, contribution -0.005, pre-share 100.0%; tokens pre 1149771, post 1305660, delta 155889, contribution 0.050, pre-share 100.0%
- excluded members: Claude-3 (unknown)

**Event 37** — 2026-08-06T12:49:40.245Z — anthropic / seven_day — dying `Claude-1` — S = `Claude-2`, `Claude-3`, `Claude-4`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 1011 | 152 | 59 | 59 | 1011 | 1 | 152 | 1922 | 86.9% | 1.751 | 12.645 | 30.051 | 0.051 | 30.000 | 100.0% | 0.412 | 0.000 |
| W = 60 min | tokens | 60 | 234739487 | 63178819 | 59 | 59 | 234739487 | 315948 | 63178819 | 517365368 | 78.8% | 1.935 | 8.189 | 7718972 | 20895 | 7698077 | 100.0% | 0.269 | 0.000 |
| W = 360 min | requests | 360 | 4055 | 8333 | 359 | 359 | 4055 | 61 | 8333 | 3168 | 32.7% | -1.274 | 0.380 | 0.000 | 14.387 | -14.387 | — | 0.082 | 0.000 |
| W = 360 min | tokens | 360 | 904148445 | 1119794826 | 359 | 359 | 904148445 | 7171087 | 1119794826 | 817955028 | 44.7% | -0.334 | 0.730 | 667977 | 1508757 | -840779 | — | 0.058 | 0.000 |

- Availability bound: 1813 min, set by `Claude-2`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 360 min: 360 min, bounded by the horizon's own cap.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-2`: requests pre 0.000, post 0.000, delta 0.000, contribution 0.000, pre-share 0.0%; tokens pre 0, post 0, delta 0, contribution 0.000, pre-share 0.0%
  - `Claude-3`: requests pre 0.102, post 0.051, delta -0.051, contribution -0.003, pre-share 3.9%; tokens pre 32343, post 11448, delta -20895, contribution -0.005, pre-share 3.0%
  - `Claude-4`: requests pre 2.475, post 32.525, delta 30.051, contribution 1.754, pre-share 96.1%; tokens pre 1038484, post 8757456, delta 7718972, contribution 1.940, pre-share 97.0%
- excluded members: none

**Event 10** — 2026-07-14T14:57:14.374Z — anthropic / five_hour — dying `Claude-1` — S = `Claude-2`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 410 | 31 | 59 | 59 | 410 | 29 | 31 | 499 | 93.0% | 1.141 | 16.097 | 7.932 | 0.000 | 7.932 | 100.0% | 1.344 | 3.535 |
| W = 60 min | tokens | 60 | 165079221 | 11476143 | 59 | 59 | 165079221 | 11835351 | 11476143 | 142893903 | 93.5% | 0.796 | 12.451 | 2227420 | 0 | 2227420 | 100.0% | 2.074 | 1.896 |
| W = 134 min | requests | 360 | 754 | 81 | 133 | 133 | 754 | 29 | 81 | 1058 | 90.3% | 1.296 | 13.062 | 7.346 | 0.000 | 7.346 | 100.0% | 2.129 | 2.784 |
| W = 134 min | tokens | 360 | 303402808 | 46996265 | 133 | 133 | 303402808 | 11835351 | 46996265 | 317744790 | 86.6% | 0.892 | 6.761 | 2035703 | 0 | 2035703 | 100.0% | 3.189 | 1.381 |

- Availability bound: 134 min, set by `Claude-1`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 134 min: 360 min, bounded by the horizon's own cap.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-2`: requests pre 0.525, post 8.458, delta 7.932, contribution 1.141, pre-share 100.0%; tokens pre 194511, post 2421931, delta 2227420, contribution 0.796, pre-share 100.0%
- excluded members: Claude-3 (unknown)

**Event 52** — 2026-09-02T18:08:29.337Z — anthropic / five_hour — dying `Claude-3` — S = `Claude-4`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 42 min | requests | 50 | 3200 | 166 | 41 | 41 | 2451 | 0 | 156 | 1458 | 95.1% | 0.531 | 9.346 | 31.756 | 0.000 | 31.756 | 100.0% | — | outside-loaded-span: the interval leaves the span the request table was read over |
| W = 42 min | tokens | 50 | 409457098 | 19899664 | 41 | 41 | 329729877 | 0 | 19364175 | 258139377 | 95.4% | 0.724 | 13.331 | 5823785 | 0 | 5823785 | 100.0% | — | outside-loaded-span: the interval leaves the span the request table was read over |

- 6 h horizon absent: the availability bound of 42 min caps the six-hour horizon at the 42 min it is already measured over.
- Availability bound: 42 min, set by `Claude-2`.
- W_pre at W = 42 min: 50 min, bounded by the nearest availability change of a class member before it.
- Survivors, at W = 42 min (W_pre = 50 min):
  - `Claude-4`: requests pre 3.805, post 35.561, delta 31.756, contribution 0.531, pre-share 100.0%; tokens pre 472297, post 6296082, delta 5823785, contribution 0.724, pre-share 100.0%
- excluded members: Claude-2 (exhausted), Claude-1 (exhausted), Claude-5 (exhausted)

**Event 6** — 2026-07-03T13:19:27.425Z — anthropic / seven_day — dying `Claude-1` — S = `Claude-2`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 989 | 45 | 59 | 59 | 989 | 36 | 45 | 3 | 95.6% | -0.042 | 0.067 | 0.000 | 0.712 | -0.712 | — | availability-change-inside: Claude-1 is exhausted at the start of the interval | availability-change-inside: Claude-1 changes availability at 2026-07-10T13:35:13.432Z |
| W = 60 min | tokens | 60 | 168454085 | 4607837 | 59 | 59 | 168454085 | 10575442 | 4607837 | 506323 | 97.3% | -0.024 | 0.110 | 0 | 69517 | -69517 | — | availability-change-inside: Claude-1 is exhausted at the start of the interval | availability-change-inside: Claude-1 changes availability at 2026-07-10T13:35:13.432Z |
| W = 360 min | requests | 360 | 5368 | 334 | 359 | 359 | 5368 | 87 | 334 | 2256 | 94.1% | 0.358 | 6.754 | 5.354 | 0.000 | 5.354 | 100.0% | availability-change-inside: Claude-1 is exhausted at the start of the interval | availability-change-inside: Claude-1 changes availability at 2026-07-10T13:35:13.432Z |
| W = 360 min | tokens | 360 | 799910415 | 38469455 | 359 | 359 | 799910415 | 28371061 | 38469455 | 436809435 | 95.4% | 0.498 | 11.355 | 1109582 | 0 | 1109582 | 100.0% | availability-change-inside: Claude-1 is exhausted at the start of the interval | availability-change-inside: Claude-1 changes availability at 2026-07-10T13:35:13.432Z |

- Availability bound: 1507 min, set by `Claude-2`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 360 min: 360 min, bounded by the horizon's own cap.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-2`: requests pre 0.763, post 0.051, delta -0.712, contribution -0.042, pre-share 100.0%; tokens pre 78099, post 8582, delta -69517, contribution -0.024, pre-share 100.0%
- excluded members: Claude-3 (unknown)

**Event 39** — 2026-08-07T19:58:42.079Z — anthropic / seven_day — dying `Claude-3` — S = `Claude-4`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 56 min | requests | 56 | 172 | 5 | 55 | 55 | 172 | 93 | 5 | 22 | 97.2% | 0.099 | 4.400 | 0.309 | 0.000 | 0.309 | 100.0% | — | — |
| W = 56 min | tokens | 56 | 42865908 | 1328436 | 55 | 55 | 42865908 | 29441185 | 1328436 | 3846045 | 97.0% | 0.059 | 2.895 | 45775 | 0 | 45775 | 100.0% | — | — |

- 6 h horizon absent: the availability bound of 56 min caps the six-hour horizon at the 56 min it is already measured over.
- Availability bound: 56 min, set by `Claude-2`.
- W_pre at W = 56 min: 56 min, bounded by the nearest availability change of a class member before it.
- Survivors, at W = 56 min (W_pre = 56 min):
  - `Claude-4`: requests pre 0.091, post 0.400, delta 0.309, contribution 0.099, pre-share 100.0%; tokens pre 24153, post 69928, delta 45775, contribution 0.059, pre-share 100.0%
- excluded members: Claude-2 (exhausted), Claude-1 (exhausted)

**Event 60** — 2026-09-05T15:09:12.393Z — anthropic / five_hour — dying `Claude-5` — S = `Claude-2`, `Claude-3`, `Claude-4`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 54 min | requests | 58 | 1692 | 47 | 53 | 53 | 1556 | 2 | 46 | 1735 | 97.3% | 1.085 | 37.717 | 31.868 | 0.000 | 31.868 | 75.1% | 0.672 | outside-loaded-span: the interval leaves the span the request table was read over |
| W = 54 min | tokens | 58 | 311926892 | 17107663 | 53 | 53 | 290744974 | 453154 | 16683855 | 340690269 | 94.8% | 1.114 | 20.420 | 6113329 | 0 | 6113329 | 80.3% | 0.793 | outside-loaded-span: the interval leaves the span the request table was read over |

- 6 h horizon absent: the availability bound of 54 min caps the six-hour horizon at the 54 min it is already measured over.
- Availability bound: 54 min, set by `Claude-1`.
- W_pre at W = 54 min: 58 min, bounded by the nearest availability change of a class member before it.
- Survivors, at W = 54 min (W_pre = 58 min):
  - `Claude-2`: requests pre 0.679, post 8.604, delta 7.925, contribution 0.270, pre-share 78.7%; tokens pre 252377, post 1457107, delta 1204730, contribution 0.220, pre-share 80.7%
  - `Claude-3`: requests pre 0.189, post 24.132, delta 23.943, contribution 0.816, pre-share 21.3%; tokens pre 62413, post 4971011, delta 4908598, contribution 0.895, pre-share 19.3%
  - `Claude-4`: requests pre 0.000, post 0.000, delta 0.000, contribution 0.000, pre-share 0.0%; tokens pre 0, post 0, delta 0, contribution 0.000, pre-share 0.0%
- excluded members: Claude-1 (exhausted)

**Event 64** — 2026-09-05T18:38:28.979Z — anthropic / five_hour — dying `Claude-3` — S = `Claude-4`, `Claude-1`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 16 min | requests | 26 | 703 | 12 | 15 | 15 | 445 | 1 | 12 | 240 | 98.3% | 0.512 | 20.000 | 15.200 | 0.000 | 15.200 | 99.1% | — | outside-loaded-span: the interval leaves the span the request table was read over |
| W = 16 min | tokens | 26 | 107868155 | 1165042 | 15 | 15 | 64165700 | 260325 | 1165042 | 54312792 | 98.9% | 0.828 | 46.619 | 3543183 | 0 | 3543183 | 100.0% | — | outside-loaded-span: the interval leaves the span the request table was read over |

- 6 h horizon absent: the availability bound of 16 min caps the six-hour horizon at the 16 min it is already measured over.
- Availability bound: 16 min, set by `Claude-5`.
- W_pre at W = 16 min: 26 min, bounded by the nearest availability change of a class member before it.
- Survivors, at W = 16 min (W_pre = 26 min):
  - `Claude-4`: requests pre 0.800, post 15.867, delta 15.067, contribution 0.508, pre-share 100.0%; tokens pre 77669, post 3620853, delta 3543183, contribution 0.828, pre-share 100.0%
  - `Claude-1`: requests pre 0.000, post 0.133, delta 0.133, contribution 0.004, pre-share 0.0%; tokens pre 0, post 0, delta 0, contribution 0.000, pre-share 0.0%
- excluded members: Claude-2 (exhausted), Claude-5 (exhausted)

**Event 14** — 2026-07-19T16:29:05.469Z — anthropic / five_hour — dying `Claude-3` — S = `Claude-1`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 22 min | requests | 38 | 548 | 8 | 21 | 21 | 209 | 0 | 1 | 170 | 98.6% | 0.809 | 170.000 | 8.048 | 0.000 | 8.048 | 100.0% | availability-change-inside: Claude-3 is unknown at the start of the interval | availability-change-inside: Claude-3 is exhausted at the start of the interval |
| W = 22 min | tokens | 38 | 177595518 | 4408800 | 21 | 21 | 80781624 | 0 | 570888 | 63453242 | 97.6% | 0.778 | 111.148 | 2994398 | 0 | 2994398 | 100.0% | availability-change-inside: Claude-3 is unknown at the start of the interval | availability-change-inside: Claude-3 is exhausted at the start of the interval |

- 6 h horizon absent: the availability bound of 22 min caps the six-hour horizon at the 22 min it is already measured over.
- Availability bound: 22 min, set by `Claude-2`.
- W_pre at W = 22 min: 38 min, bounded by the nearest availability change of a class member before it.
- Survivors, at W = 22 min (W_pre = 38 min):
  - `Claude-1`: requests pre 0.048, post 8.095, delta 8.048, contribution 0.809, pre-share 100.0%; tokens pre 27185, post 3021583, delta 2994398, contribution 0.778, pre-share 100.0%
- excluded members: Claude-2 (exhausted)

**Event 26** — 2026-07-26T21:16:47.529Z — anthropic / seven_day — dying `Claude-4` — S = `Claude-1`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 36 min | requests | 36 | 132 | 1 | 35 | 35 | 132 | 72 | 1 | 14 | 99.2% | 0.098 | 14.000 | 0.371 | 0.000 | 0.371 | 100.0% | availability-change-inside: Claude-4 is unknown at the start of the interval | — |
| W = 36 min | tokens | 36 | 33722493 | 252599 | 35 | 35 | 33722493 | 20180952 | 252599 | 5488978 | 99.3% | 0.155 | 21.730 | 149611 | 0 | 149611 | 100.0% | availability-change-inside: Claude-4 is unknown at the start of the interval | — |

- 6 h horizon absent: the availability bound of 36 min caps the six-hour horizon at the 36 min it is already measured over.
- Availability bound: 36 min, set by `Claude-4`.
- W_pre at W = 36 min: 36 min, bounded by the nearest availability change of a class member before it.
- Survivors, at W = 36 min (W_pre = 36 min):
  - `Claude-1`: requests pre 0.029, post 0.400, delta 0.371, contribution 0.098, pre-share 100.0%; tokens pre 7217, post 156828, delta 149611, contribution 0.155, pre-share 100.0%
- excluded members: Claude-2 (exhausted), Claude-3 (exhausted)

**Event 3** — 2026-07-02T09:38:41.152Z — anthropic / five_hour — dying `Claude-1` — S = `Claude-2`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 681 | 2 | 59 | 59 | 681 | 8 | 2 | 584 | 99.7% | 0.855 | 292.000 | 9.864 | 0.000 | 9.864 | 100.0% | availability-change-inside: Claude-1 is exhausted at the start of the interval | 1.518 |
| W = 60 min | tokens | 60 | 154581017 | 0 | 59 | 59 | 154581017 | 3092132 | 0 | 174482272 | 100.0% | 1.129 | — | 2957327 | 0 | 2957327 | 100.0% | availability-change-inside: Claude-1 is exhausted at the start of the interval | — |
| W = 138 min | requests | 360 | 859 | 2 | 137 | 137 | 859 | 8 | 2 | 1034 | 99.8% | 1.201 | 517.000 | 7.533 | 0.000 | 7.533 | 100.0% | availability-change-inside: Claude-1 is exhausted at the start of the interval | 12.804 |
| W = 138 min | tokens | 360 | 199194858 | 0 | 137 | 137 | 199194858 | 3092132 | 0 | 324095154 | 100.0% | 1.627 | — | 2365658 | 0 | 2365658 | 100.0% | availability-change-inside: Claude-1 is exhausted at the start of the interval | — |

- Availability bound: 138 min, set by `Claude-2`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 138 min: 360 min, bounded by the horizon's own cap.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-2`: requests pre 0.034, post 9.898, delta 9.864, contribution 0.855, pre-share 100.0%; tokens pre 0, post 2957327, delta 2957327, contribution 1.129, pre-share —
- excluded members: Claude-3 (unknown)

**Event 2** — 2026-07-02T00:40:40.683Z — anthropic / five_hour — dying `Claude-1` — S = `Claude-2`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 60 min | requests | 60 | 1162 | 0 | 59 | 59 | 1162 | 32 | 0 | 232 | 100.0% | 0.200 | — | 3.932 | 0.000 | 3.932 | 100.0% | availability-change-inside: Claude-1 is exhausted at the start of the interval | — |
| W = 60 min | tokens | 60 | 291677370 | 0 | 59 | 59 | 291677370 | 8473293 | 0 | 46049520 | 100.0% | 0.158 | — | 780500 | 0 | 780500 | 100.0% | availability-change-inside: Claude-1 is exhausted at the start of the interval | — |
| W = 90 min | requests | 360 | 1904 | 0 | 89 | 89 | 1414 | 32 | 0 | 303 | 100.0% | 0.214 | — | 3.404 | 0.000 | 3.404 | 100.0% | availability-change-inside: Claude-1 is exhausted at the start of the interval | — |
| W = 90 min | tokens | 360 | 449220694 | 0 | 89 | 89 | 347953201 | 8473293 | 0 | 60159597 | 100.0% | 0.173 | — | 675951 | 0 | 675951 | 100.0% | availability-change-inside: Claude-1 is exhausted at the start of the interval | — |

- Availability bound: 90 min, set by `Claude-1`.
- W_pre at W = 60 min: 60 min, bounded by the horizon's own cap.
- W_pre at W = 90 min: 360 min, bounded by the horizon's own cap.
- Survivors, at W = 60 min (W_pre = 60 min):
  - `Claude-2`: requests pre 0.000, post 3.932, delta 3.932, contribution 0.200, pre-share —; tokens pre 0, post 780500, delta 780500, contribution 0.158, pre-share —
- excluded members: Claude-3 (unknown)

**Event 8** — 2026-07-10T13:35:13.432Z — anthropic / five_hour — dying `Claude-1` — S = `Claude-2`

| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| W = 16 min | requests | 60 | 695 | 0 | 15 | 15 | 221 | 4 | 0 | 98 | 100.0% | 0.443 | — | 6.533 | 0.000 | 6.533 | 100.0% | availability-change-inside: Claude-1 changes availability at 2026-07-03T13:19:27.425Z | — |
| W = 16 min | tokens | 60 | 171338445 | 0 | 15 | 15 | 53445969 | 1039281 | 0 | 28797802 | 100.0% | 0.539 | — | 1919853 | 0 | 1919853 | 100.0% | availability-change-inside: Claude-1 changes availability at 2026-07-03T13:19:27.425Z | — |

- 6 h horizon absent: the availability bound of 16 min caps the six-hour horizon at the 16 min it is already measured over.
- Availability bound: 16 min, set by `Claude-1`.
- W_pre at W = 16 min: 60 min, bounded by the horizon's own cap.
- Survivors, at W = 16 min (W_pre = 60 min):
  - `Claude-2`: requests pre 0.000, post 6.533, delta 6.533, contribution 0.443, pre-share —; tokens pre 0, post 1919853, delta 1919853, contribution 0.539, pre-share —
- excluded members: Claude-3 (unknown)

Deaths that were not measured, printed rather than dropped:

| event | instant | class | window | dying account | excluded by | bound |
|---:|---|---|---|---|---|---|
| 4 | 2026-07-02T11:56:41.474Z | anthropic | five_hour | Claude-2 | noSurvivors | every peer was Claude-3 (unknown), Claude-1 (exhausted) |
| 5 | 2026-07-02T14:11:22.339Z | codex | five_hour | Codex-1 | noSurvivors | the class held no other account |
| 13 | 2026-07-19T15:15:05.073Z | anthropic | five_hour | Claude-2 | noSurvivors | every peer was Claude-3 (unknown), Claude-1 (exhausted) |
| 19 | 2026-07-24T16:20:53.492Z | codex | seven_day | Codex-1 | noSurvivors | the class held no other account |
| 21 | 2026-07-24T17:42:54.184Z | anthropic | seven_day | Claude-2 | intervalTooShort | Claude-4 changes availability 2 min from the death |
| 22 | 2026-07-24T19:46:54.680Z | anthropic | seven_day | Claude-1 | intervalTooShort | Claude-3 changes availability 2 min from the death |
| 23 | 2026-07-24T19:48:54.680Z | anthropic | seven_day | Claude-3 | intervalTooShort | Claude-1 changes availability 2 min from the death |
| 24 | 2026-07-26T15:26:25.563Z | anthropic | five_hour | Claude-4 | intervalTooShort | Claude-4 changes availability 14 min from the death |
| 27 | 2026-07-27T06:00:48.362Z | anthropic | seven_day | Claude-3 | alreadyExhausted | Claude-3 already read 100 % on a window before the death |
| 36 | 2026-08-04T20:36:50.624Z | codex | seven_day | Codex-1 | noSurvivors | the class held no other account |
| 41 | 2026-08-17T13:17:38.486Z | anthropic | five_hour | Claude-1 | intervalTooShort | Claude-3 changes availability 4 min from the death |
| 49 | 2026-09-02T16:02:28.745Z | anthropic | five_hour | Claude-1 | intervalTooShort | Claude-2 changes availability 4 min from the death |
| 50 | 2026-09-02T16:06:28.745Z | anthropic | five_hour | Claude-2 | intervalTooShort | Claude-1 changes availability 4 min from the death |
| 56 | 2026-09-05T13:43:12.377Z | codex | five_hour | Codex-2 | intervalTooShort | Codex-2 changes availability 14 min from the death |
| 61 | 2026-09-05T16:01:10.300Z | anthropic | five_hour | Claude-1 | alreadyExhausted | Claude-1 already read 100 % on a window before the death |
| 62 | 2026-09-05T18:02:28.976Z | anthropic | five_hour | Claude-5 | intervalTooShort | Claude-2 changes availability 10 min from the death |
| 63 | 2026-09-05T18:12:28.976Z | anthropic | five_hour | Claude-2 | intervalTooShort | Claude-5 changes availability 10 min from the death |

Reconciliation: 33 analysed + 5 noSurvivors + 2 alreadyExhausted + 0 dyingStateUnknown + 10 intervalTooShort + 0 outsideLoadedSpan + 0 noRequestCoverage + 0 noPreDeathDyingTraffic + 0 folded into a simultaneous departure = 50 peer-exhaustion events in the replayed interval.

## Observation-lag mechanism check

What the correction actually did to the projections, as opposed to what it scored. `scenario-equal` advances each reading over its observation lag; `scenario-equal-original` is the identical equal split with that advance switched off. Every check in this section is measured on THAT pair, which is the equal split — the verdict basis when the correction shipped, and kept as the subject here so the section cannot silently change what it is about. Its conclusion carries over to `scenario-proportional`, the basis since 2026-09-07, by the same mechanism: both scans take the same advance, from the same per-path anchor, before the walk starts, and the advance is a property of the reading rather than of the share rule that splits the demand afterwards. Each check below states what it measures, which records enter it, which are excluded and by which predicate, and prints the number that falls out of that population. None of them states what the number ought to be; reading it against the mechanism described is the reader's job. An eligible set of zero is reported as such rather than as a pass.

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
| scenario-proportional | 160 | 100.0% | 160 | 0 | 11 | 32 | 115 | 2 | 0.256 | 0.846 | 0.393 | -7.7 | 7.7 | 0.026 |
| scenario-proportional-original | 160 | 100.0% | 160 | 0 | 11 | 32 | 115 | 2 | 0.256 | 0.846 | 0.393 | -7.2 | 7.2 | 0.024 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 160 | 0 | 0 | 0 | 0 | 160 |
| scenario-equal | 160 | 0 | 0 | 0 | 0 | 160 |
| scenario-equal-original | 160 | 0 | 0 | 0 | 0 | 160 |
| scenario-headroom | 160 | 0 | 0 | 0 | 0 | 160 |
| scenario-proportional | 160 | 0 | 0 | 0 | 0 | 160 |
| scenario-proportional-original | 160 | 0 | 0 | 0 | 0 | 160 |

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
| scenario-proportional | <30m | 1 | 0 | 1.000 | -4.2 | 9 |
| scenario-proportional | 30m-2h | 10 | 2 | 0.833 | -8.1 | 11 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 8 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-proportional | >48h | 0 | 0 | — | — | 1 |
| scenario-proportional-original | <30m | 1 | 0 | 1.000 | -2.4 | 8 |
| scenario-proportional-original | 30m-2h | 10 | 2 | 0.833 | -7.4 | 12 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 8 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1632 | 100.0% | 1632 | 0 | 46 | 609 | 957 | 20 | 0.070 | 0.697 | 0.128 | -2.9 | 14.5 | 0.048 |
| scenario-equal | 1632 | 100.0% | 1632 | 0 | 34 | 596 | 970 | 32 | 0.054 | 0.515 | 0.098 | 20.9 | 20.9 | 0.070 |
| scenario-equal-original | 1632 | 100.0% | 1632 | 0 | 34 | 596 | 970 | 32 | 0.054 | 0.515 | 0.098 | 21.4 | 21.4 | 0.071 |
| scenario-headroom | 1632 | 100.0% | 1632 | 0 | 23 | 430 | 1136 | 43 | 0.051 | 0.348 | 0.089 | 54.3 | 54.3 | 0.181 |
| scenario-proportional | 1632 | 100.0% | 1632 | 0 | 59 | 663 | 903 | 7 | 0.082 | 0.894 | 0.150 | -5.1 | 10.9 | 0.036 |
| scenario-proportional-original | 1632 | 100.0% | 1632 | 0 | 59 | 660 | 906 | 7 | 0.082 | 0.894 | 0.150 | -3.6 | 11.2 | 0.037 |

Paired median signed error (n=7; positive = optimistic): scenario-proportional -8.1 min, current -8.1 min.

Against its own pre-correction scan (n=11): scenario-proportional -7.7 min, scenario-proportional-original -7.2 min; paired median change in absolute error 0.8 min (n=11, negative = the correction lands closer).

##### age 2-5 min

n: 2546 records, 164 window lifecycles, 18 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 164 | 100.0% | 164 | 0 | 6 | 26 | 126 | 6 | 0.188 | 0.500 | 0.273 | 0.4 | 5.1 | 0.017 |
| scenario-equal | 164 | 100.0% | 164 | 0 | 7 | 22 | 130 | 5 | 0.241 | 0.583 | 0.341 | 29.1 | 29.1 | 0.097 |
| scenario-equal-original | 164 | 100.0% | 164 | 0 | 7 | 21 | 131 | 5 | 0.250 | 0.583 | 0.350 | 30.6 | 30.6 | 0.102 |
| scenario-headroom | 164 | 100.0% | 164 | 0 | 5 | 11 | 141 | 7 | 0.313 | 0.417 | 0.357 | 56.7 | 56.7 | 0.189 |
| scenario-proportional | 164 | 100.0% | 164 | 0 | 10 | 28 | 124 | 2 | 0.263 | 0.833 | 0.400 | -5.1 | 3.7 | 0.012 |
| scenario-proportional-original | 164 | 100.0% | 164 | 0 | 10 | 28 | 124 | 2 | 0.263 | 0.833 | 0.400 | -4.0 | 4.0 | 0.013 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 164 | 0 | 0 | 0 | 0 | 164 |
| scenario-equal | 164 | 0 | 0 | 0 | 0 | 164 |
| scenario-equal-original | 164 | 0 | 0 | 0 | 0 | 164 |
| scenario-headroom | 164 | 0 | 0 | 0 | 0 | 164 |
| scenario-proportional | 164 | 0 | 0 | 0 | 0 | 164 |
| scenario-proportional-original | 164 | 0 | 0 | 0 | 0 | 164 |

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
| scenario-proportional | <30m | 3 | 1 | 0.750 | 0.9 | 7 |
| scenario-proportional | 30m-2h | 7 | 1 | 0.875 | -5.1 | 10 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 7 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-proportional | >48h | 0 | 0 | — | — | 2 |
| scenario-proportional-original | <30m | 3 | 1 | 0.750 | 2.4 | 7 |
| scenario-proportional-original | 30m-2h | 7 | 1 | 0.875 | -4.0 | 10 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 7 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 2546 | 100.0% | 2546 | 0 | 33 | 1117 | 1379 | 17 | 0.029 | 0.660 | 0.055 | 2.2 | 10.0 | 0.033 |
| scenario-equal | 2546 | 100.0% | 2546 | 0 | 31 | 1051 | 1445 | 19 | 0.029 | 0.620 | 0.055 | 17.5 | 17.5 | 0.058 |
| scenario-equal-original | 2546 | 100.0% | 2546 | 0 | 31 | 1049 | 1447 | 19 | 0.029 | 0.620 | 0.055 | 19.0 | 19.0 | 0.063 |
| scenario-headroom | 2546 | 100.0% | 2546 | 0 | 16 | 725 | 1771 | 34 | 0.022 | 0.320 | 0.040 | 63.6 | 63.6 | 0.212 |
| scenario-proportional | 2546 | 100.0% | 2546 | 0 | 44 | 1166 | 1330 | 6 | 0.036 | 0.880 | 0.070 | -3.3 | 4.9 | 0.016 |
| scenario-proportional-original | 2546 | 100.0% | 2546 | 0 | 44 | 1165 | 1331 | 6 | 0.036 | 0.880 | 0.070 | -1.7 | 4.3 | 0.014 |

Paired median signed error (n=6; positive = optimistic): scenario-proportional -5.1 min, current 0.4 min.

Against its own pre-correction scan (n=10): scenario-proportional -5.1 min, scenario-proportional-original -4.0 min; paired median change in absolute error -0.8 min (n=10, negative = the correction lands closer).

##### age 5-10 min

n: 1018 records, 97 window lifecycles, 9 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 97 | 100.0% | 97 | 0 | 1 | 14 | 80 | 2 | 0.067 | 0.333 | 0.111 | 27.5 | 27.5 | 0.092 |
| scenario-equal | 97 | 100.0% | 97 | 0 | 2 | 11 | 83 | 1 | 0.154 | 0.667 | 0.250 | 18.3 | 18.3 | 0.061 |
| scenario-equal-original | 97 | 100.0% | 97 | 0 | 2 | 11 | 83 | 1 | 0.154 | 0.667 | 0.250 | 22.8 | 22.8 | 0.076 |
| scenario-headroom | 97 | 100.0% | 97 | 0 | 2 | 5 | 89 | 1 | 0.286 | 0.667 | 0.400 | 33.7 | 33.7 | 0.112 |
| scenario-proportional | 97 | 100.0% | 97 | 0 | 2 | 14 | 80 | 1 | 0.125 | 0.667 | 0.211 | -7.0 | 2.8 | 0.009 |
| scenario-proportional-original | 97 | 100.0% | 97 | 0 | 2 | 13 | 81 | 1 | 0.133 | 0.667 | 0.222 | -3.2 | 1.0 | 0.003 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 97 | 0 | 0 | 0 | 0 | 97 |
| scenario-equal | 97 | 0 | 0 | 0 | 0 | 97 |
| scenario-equal-original | 97 | 0 | 0 | 0 | 0 | 97 |
| scenario-headroom | 97 | 0 | 0 | 0 | 0 | 97 |
| scenario-proportional | 97 | 0 | 0 | 0 | 0 | 97 |
| scenario-proportional-original | 97 | 0 | 0 | 0 | 0 | 97 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 5 |
| scenario-proportional | 30m-2h | 2 | 0 | 1.000 | -7.0 | 2 |
| scenario-proportional | 2h-12h | 0 | 1 | 0.000 | — | 4 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-proportional | >48h | 0 | 0 | — | — | 1 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 5 |
| scenario-proportional-original | 30m-2h | 2 | 0 | 1.000 | -3.2 | 1 |
| scenario-proportional-original | 2h-12h | 0 | 1 | 0.000 | — | 4 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1018 | 100.0% | 1018 | 0 | 1 | 359 | 655 | 3 | 0.003 | 0.250 | 0.005 | 27.5 | 27.5 | 0.092 |
| scenario-equal | 1018 | 100.0% | 1018 | 0 | 2 | 350 | 664 | 2 | 0.006 | 0.500 | 0.011 | 18.3 | 18.3 | 0.061 |
| scenario-equal-original | 1018 | 100.0% | 1018 | 0 | 2 | 349 | 665 | 2 | 0.006 | 0.500 | 0.011 | 22.8 | 22.8 | 0.076 |
| scenario-headroom | 1018 | 100.0% | 1018 | 0 | 2 | 240 | 774 | 2 | 0.008 | 0.500 | 0.016 | 33.7 | 33.7 | 0.112 |
| scenario-proportional | 1018 | 100.0% | 1018 | 0 | 2 | 363 | 651 | 2 | 0.005 | 0.500 | 0.011 | -7.0 | 2.8 | 0.009 |
| scenario-proportional-original | 1018 | 100.0% | 1018 | 0 | 2 | 360 | 654 | 2 | 0.006 | 0.500 | 0.011 | -3.2 | 1.0 | 0.003 |

Paired median signed error (n=1; positive = optimistic): scenario-proportional -7.0 min, current 27.5 min.

Against its own pre-correction scan (n=2): scenario-proportional -7.0 min, scenario-proportional-original -3.2 min; paired median change in absolute error 1.8 min (n=2, negative = the correction lands closer).

##### age >= 10 min

n: 57 records, 17 window lifecycles, 2 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 17 | 100.0% | 17 | 0 | 0 | 6 | 11 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 17 | 100.0% | 17 | 0 | 0 | 6 | 11 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 17 | 100.0% | 17 | 0 | 0 | 6 | 11 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 17 | 100.0% | 17 | 0 | 0 | 5 | 12 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional | 17 | 100.0% | 17 | 0 | 0 | 6 | 11 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional-original | 17 | 100.0% | 17 | 0 | 0 | 6 | 11 | 0 | 0.000 | — | 0.000 | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-equal | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-equal-original | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-headroom | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-proportional | 17 | 0 | 0 | 0 | 0 | 17 |
| scenario-proportional-original | 17 | 0 | 0 | 0 | 0 | 17 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-proportional | >48h | 0 | 0 | — | — | 2 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 57 | 100.0% | 57 | 0 | 0 | 23 | 34 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 57 | 100.0% | 57 | 0 | 0 | 23 | 34 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 57 | 100.0% | 57 | 0 | 0 | 23 | 34 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 57 | 100.0% | 57 | 0 | 0 | 20 | 37 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional | 57 | 100.0% | 57 | 0 | 0 | 23 | 34 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional-original | 57 | 100.0% | 57 | 0 | 0 | 23 | 34 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-proportional — min, current — min.

Against its own pre-correction scan (n=0): scenario-proportional — min, scenario-proportional-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### age unknown (null)

n: 19947 records, 455 window lifecycles, 39 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 455 | 100.0% | 455 | 0 | 25 | 52 | 369 | 9 | 0.325 | 0.735 | 0.450 | -12.4 | 35.6 | 0.089 |
| scenario-equal | 455 | 100.0% | 455 | 0 | 24 | 37 | 384 | 10 | 0.393 | 0.706 | 0.505 | 5.0 | 41.7 | 0.104 |
| scenario-equal-original | 455 | 100.0% | 455 | 0 | 24 | 37 | 384 | 10 | 0.393 | 0.706 | 0.505 | 1.8 | 42.5 | 0.104 |
| scenario-headroom | 455 | 100.0% | 455 | 0 | 18 | 27 | 394 | 16 | 0.400 | 0.529 | 0.456 | 35.6 | 138.3 | 0.135 |
| scenario-proportional | 455 | 100.0% | 455 | 0 | 27 | 56 | 365 | 7 | 0.325 | 0.794 | 0.462 | -13.7 | 35.6 | 0.098 |
| scenario-proportional-original | 455 | 100.0% | 455 | 0 | 27 | 55 | 366 | 7 | 0.329 | 0.794 | 0.466 | -12.8 | 36.9 | 0.094 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 455 | 0 | 0 | 0 | 0 | 455 |
| scenario-equal | 455 | 0 | 0 | 0 | 0 | 455 |
| scenario-equal-original | 455 | 0 | 0 | 0 | 0 | 455 |
| scenario-headroom | 455 | 0 | 0 | 0 | 0 | 455 |
| scenario-proportional | 455 | 0 | 0 | 0 | 0 | 455 |
| scenario-proportional-original | 455 | 0 | 0 | 0 | 0 | 455 |

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
| scenario-proportional | <30m | 2 | 0 | 1.000 | -12.4 | 5 |
| scenario-proportional | 30m-2h | 15 | 6 | 0.714 | -13.7 | 26 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 4 | 1 | 0.800 | 278.3 | 19 |
| scenario-proportional | >48h | 6 | 0 | 1.000 | -2653.4 | 6 |
| scenario-proportional-original | <30m | 2 | 0 | 1.000 | -10.4 | 5 |
| scenario-proportional-original | 30m-2h | 15 | 6 | 0.714 | -12.8 | 25 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 4 | 1 | 0.800 | 274.3 | 19 |
| scenario-proportional-original | >48h | 6 | 0 | 1.000 | -2653.4 | 6 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 19947 | 100.0% | 19947 | 0 | 2912 | 5618 | 10763 | 654 | 0.341 | 0.817 | 0.481 | -109.7 | 1237.4 | 0.126 |
| scenario-equal | 19947 | 100.0% | 19947 | 0 | 3083 | 5562 | 10819 | 483 | 0.357 | 0.865 | 0.505 | -460.9 | 1071.6 | 0.110 |
| scenario-equal-original | 19947 | 100.0% | 19947 | 0 | 3081 | 5557 | 10824 | 485 | 0.357 | 0.864 | 0.505 | -461.1 | 1071.9 | 0.110 |
| scenario-headroom | 19947 | 100.0% | 19947 | 0 | 2703 | 4786 | 11595 | 863 | 0.361 | 0.758 | 0.489 | -30.5 | 979.3 | 0.102 |
| scenario-proportional | 19947 | 100.0% | 19947 | 0 | 3114 | 6109 | 10272 | 452 | 0.338 | 0.873 | 0.487 | -515.9 | 1217.9 | 0.125 |
| scenario-proportional-original | 19947 | 100.0% | 19947 | 0 | 3114 | 6100 | 10281 | 452 | 0.338 | 0.873 | 0.487 | -515.9 | 1217.9 | 0.125 |

Paired median signed error (n=25; positive = optimistic): scenario-proportional -13.7 min, current -12.4 min.

Against its own pre-correction scan (n=27): scenario-proportional -13.7 min, scenario-proportional-original -12.8 min; paired median change in absolute error 0.0 min (n=27, negative = the correction lands closer).

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
| scenario-proportional | 150 | 100.0% | 150 | 0 | 11 | 24 | 113 | 2 | 0.314 | 0.846 | 0.458 | -7.7 | 7.7 | 0.026 |
| scenario-proportional-original | 150 | 100.0% | 150 | 0 | 11 | 24 | 113 | 2 | 0.314 | 0.846 | 0.458 | -7.2 | 7.2 | 0.024 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 150 | 0 | 0 | 0 | 0 | 150 |
| scenario-equal | 150 | 0 | 0 | 0 | 0 | 150 |
| scenario-equal-original | 150 | 0 | 0 | 0 | 0 | 150 |
| scenario-headroom | 150 | 0 | 0 | 0 | 0 | 150 |
| scenario-proportional | 150 | 0 | 0 | 0 | 0 | 150 |
| scenario-proportional-original | 150 | 0 | 0 | 0 | 0 | 150 |

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
| scenario-proportional | <30m | 1 | 0 | 1.000 | -4.2 | 9 |
| scenario-proportional | 30m-2h | 10 | 2 | 0.833 | -8.1 | 11 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 4 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 1 | 0 | 1.000 | -2.4 | 8 |
| scenario-proportional-original | 30m-2h | 10 | 2 | 0.833 | -7.4 | 12 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 4 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1107 | 100.0% | 1107 | 0 | 46 | 160 | 881 | 20 | 0.223 | 0.697 | 0.338 | -2.9 | 14.5 | 0.048 |
| scenario-equal | 1107 | 100.0% | 1107 | 0 | 34 | 135 | 906 | 32 | 0.201 | 0.515 | 0.289 | 20.9 | 20.9 | 0.070 |
| scenario-equal-original | 1107 | 100.0% | 1107 | 0 | 34 | 135 | 906 | 32 | 0.201 | 0.515 | 0.289 | 21.4 | 21.4 | 0.071 |
| scenario-headroom | 1107 | 100.0% | 1107 | 0 | 23 | 82 | 959 | 43 | 0.219 | 0.348 | 0.269 | 54.3 | 54.3 | 0.181 |
| scenario-proportional | 1107 | 100.0% | 1107 | 0 | 59 | 201 | 840 | 7 | 0.227 | 0.894 | 0.362 | -5.1 | 10.9 | 0.036 |
| scenario-proportional-original | 1107 | 100.0% | 1107 | 0 | 59 | 199 | 842 | 7 | 0.229 | 0.894 | 0.364 | -3.6 | 11.2 | 0.037 |

Paired median signed error (n=7; positive = optimistic): scenario-proportional -8.1 min, current -8.1 min.

Against its own pre-correction scan (n=11): scenario-proportional -7.7 min, scenario-proportional-original -7.2 min; paired median change in absolute error 0.8 min (n=11, negative = the correction lands closer).

##### age 2-5 min

n: 1380 records, 154 window lifecycles, 18 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 154 | 100.0% | 154 | 0 | 6 | 17 | 125 | 6 | 0.261 | 0.500 | 0.343 | 0.4 | 5.1 | 0.017 |
| scenario-equal | 154 | 100.0% | 154 | 0 | 7 | 13 | 129 | 5 | 0.350 | 0.583 | 0.438 | 29.1 | 29.1 | 0.097 |
| scenario-equal-original | 154 | 100.0% | 154 | 0 | 7 | 12 | 130 | 5 | 0.368 | 0.583 | 0.452 | 30.6 | 30.6 | 0.102 |
| scenario-headroom | 154 | 100.0% | 154 | 0 | 5 | 5 | 137 | 7 | 0.500 | 0.417 | 0.455 | 56.7 | 56.7 | 0.189 |
| scenario-proportional | 154 | 100.0% | 154 | 0 | 10 | 19 | 123 | 2 | 0.345 | 0.833 | 0.488 | -5.1 | 3.7 | 0.012 |
| scenario-proportional-original | 154 | 100.0% | 154 | 0 | 10 | 19 | 123 | 2 | 0.345 | 0.833 | 0.488 | -4.0 | 4.0 | 0.013 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 154 | 0 | 0 | 0 | 0 | 154 |
| scenario-equal | 154 | 0 | 0 | 0 | 0 | 154 |
| scenario-equal-original | 154 | 0 | 0 | 0 | 0 | 154 |
| scenario-headroom | 154 | 0 | 0 | 0 | 0 | 154 |
| scenario-proportional | 154 | 0 | 0 | 0 | 0 | 154 |
| scenario-proportional-original | 154 | 0 | 0 | 0 | 0 | 154 |

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
| scenario-proportional | <30m | 3 | 1 | 0.750 | 0.9 | 7 |
| scenario-proportional | 30m-2h | 7 | 1 | 0.875 | -5.1 | 10 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 3 | 1 | 0.750 | 2.4 | 7 |
| scenario-proportional-original | 30m-2h | 7 | 1 | 0.875 | -4.0 | 10 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1380 | 100.0% | 1380 | 0 | 33 | 186 | 1144 | 17 | 0.151 | 0.660 | 0.245 | 2.2 | 10.0 | 0.033 |
| scenario-equal | 1380 | 100.0% | 1380 | 0 | 31 | 86 | 1244 | 19 | 0.265 | 0.620 | 0.371 | 17.5 | 17.5 | 0.058 |
| scenario-equal-original | 1380 | 100.0% | 1380 | 0 | 31 | 84 | 1246 | 19 | 0.270 | 0.620 | 0.376 | 19.0 | 19.0 | 0.063 |
| scenario-headroom | 1380 | 100.0% | 1380 | 0 | 16 | 36 | 1294 | 34 | 0.308 | 0.320 | 0.314 | 63.6 | 63.6 | 0.212 |
| scenario-proportional | 1380 | 100.0% | 1380 | 0 | 44 | 203 | 1127 | 6 | 0.178 | 0.880 | 0.296 | -3.3 | 4.9 | 0.016 |
| scenario-proportional-original | 1380 | 100.0% | 1380 | 0 | 44 | 202 | 1128 | 6 | 0.179 | 0.880 | 0.297 | -1.7 | 4.3 | 0.014 |

Paired median signed error (n=6; positive = optimistic): scenario-proportional -5.1 min, current 0.4 min.

Against its own pre-correction scan (n=10): scenario-proportional -5.1 min, scenario-proportional-original -4.0 min; paired median change in absolute error -0.8 min (n=10, negative = the correction lands closer).

##### age 5-10 min

n: 451 records, 87 window lifecycles, 9 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 87 | 100.0% | 87 | 0 | 1 | 7 | 77 | 2 | 0.125 | 0.333 | 0.182 | 27.5 | 27.5 | 0.092 |
| scenario-equal | 87 | 100.0% | 87 | 0 | 2 | 3 | 81 | 1 | 0.400 | 0.667 | 0.500 | 18.3 | 18.3 | 0.061 |
| scenario-equal-original | 87 | 100.0% | 87 | 0 | 2 | 3 | 81 | 1 | 0.400 | 0.667 | 0.500 | 22.8 | 22.8 | 0.076 |
| scenario-headroom | 87 | 100.0% | 87 | 0 | 2 | 1 | 83 | 1 | 0.667 | 0.667 | 0.667 | 33.7 | 33.7 | 0.112 |
| scenario-proportional | 87 | 100.0% | 87 | 0 | 2 | 7 | 77 | 1 | 0.222 | 0.667 | 0.333 | -7.0 | 2.8 | 0.009 |
| scenario-proportional-original | 87 | 100.0% | 87 | 0 | 2 | 6 | 78 | 1 | 0.250 | 0.667 | 0.364 | -3.2 | 1.0 | 0.003 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 87 | 0 | 0 | 0 | 0 | 87 |
| scenario-equal | 87 | 0 | 0 | 0 | 0 | 87 |
| scenario-equal-original | 87 | 0 | 0 | 0 | 0 | 87 |
| scenario-headroom | 87 | 0 | 0 | 0 | 0 | 87 |
| scenario-proportional | 87 | 0 | 0 | 0 | 0 | 87 |
| scenario-proportional-original | 87 | 0 | 0 | 0 | 0 | 87 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 5 |
| scenario-proportional | 30m-2h | 2 | 0 | 1.000 | -7.0 | 2 |
| scenario-proportional | 2h-12h | 0 | 1 | 0.000 | — | 0 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 5 |
| scenario-proportional-original | 30m-2h | 2 | 0 | 1.000 | -3.2 | 1 |
| scenario-proportional-original | 2h-12h | 0 | 1 | 0.000 | — | 0 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 451 | 100.0% | 451 | 0 | 1 | 24 | 423 | 3 | 0.040 | 0.250 | 0.069 | 27.5 | 27.5 | 0.092 |
| scenario-equal | 451 | 100.0% | 451 | 0 | 2 | 7 | 440 | 2 | 0.222 | 0.500 | 0.308 | 18.3 | 18.3 | 0.061 |
| scenario-equal-original | 451 | 100.0% | 451 | 0 | 2 | 7 | 440 | 2 | 0.222 | 0.500 | 0.308 | 22.8 | 22.8 | 0.076 |
| scenario-headroom | 451 | 100.0% | 451 | 0 | 2 | 4 | 443 | 2 | 0.333 | 0.500 | 0.400 | 33.7 | 33.7 | 0.112 |
| scenario-proportional | 451 | 100.0% | 451 | 0 | 2 | 25 | 422 | 2 | 0.074 | 0.500 | 0.129 | -7.0 | 2.8 | 0.009 |
| scenario-proportional-original | 451 | 100.0% | 451 | 0 | 2 | 22 | 425 | 2 | 0.083 | 0.500 | 0.143 | -3.2 | 1.0 | 0.003 |

Paired median signed error (n=1; positive = optimistic): scenario-proportional -7.0 min, current 27.5 min.

Against its own pre-correction scan (n=2): scenario-proportional -7.0 min, scenario-proportional-original -3.2 min; paired median change in absolute error 1.8 min (n=2, negative = the correction lands closer).

##### age >= 10 min

n: 13 records, 10 window lifecycles, 2 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-equal | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-equal-original | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-headroom | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-proportional | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |
| scenario-proportional-original | 10 | 100.0% | 10 | 0 | 0 | 0 | 10 | 0 | — | — | — | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal-original | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-headroom | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-proportional | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-proportional-original | 10 | 0 | 0 | 0 | 0 | 10 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 13 | 100.0% | 13 | 0 | 0 | 0 | 13 | 0 | — | — | — | — | — | — |
| scenario-equal | 13 | 100.0% | 13 | 0 | 0 | 0 | 13 | 0 | — | — | — | — | — | — |
| scenario-equal-original | 13 | 100.0% | 13 | 0 | 0 | 0 | 13 | 0 | — | — | — | — | — | — |
| scenario-headroom | 13 | 100.0% | 13 | 0 | 0 | 0 | 13 | 0 | — | — | — | — | — | — |
| scenario-proportional | 13 | 100.0% | 13 | 0 | 0 | 0 | 13 | 0 | — | — | — | — | — | — |
| scenario-proportional-original | 13 | 100.0% | 13 | 0 | 0 | 0 | 13 | 0 | — | — | — | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-proportional — min, current — min.

Against its own pre-correction scan (n=0): scenario-proportional — min, scenario-proportional-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### age unknown (null)

n: 7781 records, 402 window lifecycles, 36 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 402 | 100.0% | 402 | 0 | 16 | 28 | 351 | 7 | 0.364 | 0.696 | 0.478 | -3.6 | 15.6 | 0.052 |
| scenario-equal | 402 | 100.0% | 402 | 0 | 14 | 13 | 366 | 9 | 0.519 | 0.609 | 0.560 | 13.9 | 19.1 | 0.064 |
| scenario-equal-original | 402 | 100.0% | 402 | 0 | 14 | 13 | 366 | 9 | 0.519 | 0.609 | 0.560 | 14.8 | 21.0 | 0.070 |
| scenario-headroom | 402 | 100.0% | 402 | 0 | 9 | 4 | 375 | 14 | 0.692 | 0.391 | 0.500 | 51.5 | 51.5 | 0.172 |
| scenario-proportional | 402 | 100.0% | 402 | 0 | 17 | 31 | 348 | 6 | 0.354 | 0.739 | 0.479 | -12.4 | 25.8 | 0.086 |
| scenario-proportional-original | 402 | 100.0% | 402 | 0 | 17 | 30 | 349 | 6 | 0.362 | 0.739 | 0.486 | -10.4 | 24.5 | 0.082 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 402 | 0 | 0 | 0 | 0 | 402 |
| scenario-equal | 402 | 0 | 0 | 0 | 0 | 402 |
| scenario-equal-original | 402 | 0 | 0 | 0 | 0 | 402 |
| scenario-headroom | 402 | 0 | 0 | 0 | 0 | 402 |
| scenario-proportional | 402 | 0 | 0 | 0 | 0 | 402 |
| scenario-proportional-original | 402 | 0 | 0 | 0 | 0 | 402 |

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
| scenario-proportional | <30m | 2 | 0 | 1.000 | -12.4 | 5 |
| scenario-proportional | 30m-2h | 15 | 6 | 0.714 | -13.7 | 26 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional | >48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | <30m | 2 | 0 | 1.000 | -10.4 | 5 |
| scenario-proportional-original | 30m-2h | 15 | 6 | 0.714 | -12.8 | 25 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 0 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 7781 | 100.0% | 7781 | 0 | 174 | 591 | 6920 | 96 | 0.227 | 0.644 | 0.336 | 0.2 | 16.2 | 0.054 |
| scenario-equal | 7781 | 100.0% | 7781 | 0 | 153 | 250 | 7261 | 117 | 0.380 | 0.567 | 0.455 | 10.8 | 20.7 | 0.069 |
| scenario-equal-original | 7781 | 100.0% | 7781 | 0 | 151 | 245 | 7266 | 119 | 0.381 | 0.559 | 0.453 | 11.8 | 20.7 | 0.069 |
| scenario-headroom | 7781 | 100.0% | 7781 | 0 | 99 | 151 | 7360 | 171 | 0.396 | 0.367 | 0.381 | 46.7 | 51.5 | 0.172 |
| scenario-proportional | 7781 | 100.0% | 7781 | 0 | 183 | 678 | 6833 | 87 | 0.213 | 0.678 | 0.324 | -5.0 | 17.4 | 0.058 |
| scenario-proportional-original | 7781 | 100.0% | 7781 | 0 | 183 | 669 | 6842 | 87 | 0.215 | 0.678 | 0.326 | -3.4 | 17.9 | 0.060 |

Paired median signed error (n=16; positive = optimistic): scenario-proportional -12.4 min, current -3.6 min.

Against its own pre-correction scan (n=17): scenario-proportional -12.4 min, scenario-proportional-original -10.4 min; paired median change in absolute error 0.9 min (n=17, negative = the correction lands closer).

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
| scenario-proportional | 10 | 100.0% | 10 | 0 | 0 | 8 | 2 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional-original | 10 | 100.0% | 10 | 0 | 0 | 8 | 2 | 0 | 0.000 | — | 0.000 | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal-original | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-headroom | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-proportional | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-proportional-original | 10 | 0 | 0 | 0 | 0 | 10 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 4 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-proportional | >48h | 0 | 0 | — | — | 1 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 4 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 3 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 525 | 100.0% | 525 | 0 | 0 | 449 | 76 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 525 | 100.0% | 525 | 0 | 0 | 461 | 64 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 525 | 100.0% | 525 | 0 | 0 | 461 | 64 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 525 | 100.0% | 525 | 0 | 0 | 348 | 177 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional | 525 | 100.0% | 525 | 0 | 0 | 462 | 63 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional-original | 525 | 100.0% | 525 | 0 | 0 | 461 | 64 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-proportional — min, current — min.

Against its own pre-correction scan (n=0): scenario-proportional — min, scenario-proportional-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### age 2-5 min

n: 1166 records, 10 window lifecycles, 1 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 10 | 100.0% | 10 | 0 | 0 | 9 | 1 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 10 | 100.0% | 10 | 0 | 0 | 9 | 1 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 10 | 100.0% | 10 | 0 | 0 | 9 | 1 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 10 | 100.0% | 10 | 0 | 0 | 6 | 4 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional | 10 | 100.0% | 10 | 0 | 0 | 9 | 1 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional-original | 10 | 100.0% | 10 | 0 | 0 | 9 | 1 | 0 | 0.000 | — | 0.000 | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal-original | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-headroom | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-proportional | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-proportional-original | 10 | 0 | 0 | 0 | 0 | 10 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 5 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-proportional | >48h | 0 | 0 | — | — | 2 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 5 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1166 | 100.0% | 1166 | 0 | 0 | 931 | 235 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 1166 | 100.0% | 1166 | 0 | 0 | 965 | 201 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 1166 | 100.0% | 1166 | 0 | 0 | 965 | 201 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 1166 | 100.0% | 1166 | 0 | 0 | 689 | 477 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional | 1166 | 100.0% | 1166 | 0 | 0 | 963 | 203 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional-original | 1166 | 100.0% | 1166 | 0 | 0 | 963 | 203 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-proportional — min, current — min.

Against its own pre-correction scan (n=0): scenario-proportional — min, scenario-proportional-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### age 5-10 min

n: 567 records, 10 window lifecycles, 0 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 10 | 100.0% | 10 | 0 | 0 | 7 | 3 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 10 | 100.0% | 10 | 0 | 0 | 8 | 2 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 10 | 100.0% | 10 | 0 | 0 | 8 | 2 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 10 | 100.0% | 10 | 0 | 0 | 4 | 6 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional | 10 | 100.0% | 10 | 0 | 0 | 7 | 3 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional-original | 10 | 100.0% | 10 | 0 | 0 | 7 | 3 | 0 | 0.000 | — | 0.000 | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-equal-original | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-headroom | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-proportional | 10 | 0 | 0 | 0 | 0 | 10 |
| scenario-proportional-original | 10 | 0 | 0 | 0 | 0 | 10 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 4 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-proportional | >48h | 0 | 0 | — | — | 1 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 4 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 1 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 567 | 100.0% | 567 | 0 | 0 | 335 | 232 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 567 | 100.0% | 567 | 0 | 0 | 343 | 224 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 567 | 100.0% | 567 | 0 | 0 | 342 | 225 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 567 | 100.0% | 567 | 0 | 0 | 236 | 331 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional | 567 | 100.0% | 567 | 0 | 0 | 338 | 229 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional-original | 567 | 100.0% | 567 | 0 | 0 | 338 | 229 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-proportional — min, current — min.

Against its own pre-correction scan (n=0): scenario-proportional — min, scenario-proportional-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### age >= 10 min

n: 44 records, 7 window lifecycles, 0 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 7 | 100.0% | 7 | 0 | 0 | 6 | 1 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 7 | 100.0% | 7 | 0 | 0 | 6 | 1 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 7 | 100.0% | 7 | 0 | 0 | 6 | 1 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 7 | 100.0% | 7 | 0 | 0 | 5 | 2 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional | 7 | 100.0% | 7 | 0 | 0 | 6 | 1 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional-original | 7 | 100.0% | 7 | 0 | 0 | 6 | 1 | 0 | 0.000 | — | 0.000 | — | — | — |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-equal | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-equal-original | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-headroom | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-proportional | 7 | 0 | 0 | 0 | 0 | 7 |
| scenario-proportional-original | 7 | 0 | 0 | 0 | 0 | 7 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-proportional | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-proportional | >48h | 0 | 0 | — | — | 2 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 2 |
| scenario-proportional-original | 12h-48h | 0 | 0 | — | — | 2 |
| scenario-proportional-original | >48h | 0 | 0 | — | — | 2 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 44 | 100.0% | 44 | 0 | 0 | 23 | 21 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal | 44 | 100.0% | 44 | 0 | 0 | 23 | 21 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-equal-original | 44 | 100.0% | 44 | 0 | 0 | 23 | 21 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-headroom | 44 | 100.0% | 44 | 0 | 0 | 20 | 24 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional | 44 | 100.0% | 44 | 0 | 0 | 23 | 21 | 0 | 0.000 | — | 0.000 | — | — | — |
| scenario-proportional-original | 44 | 100.0% | 44 | 0 | 0 | 23 | 21 | 0 | 0.000 | — | 0.000 | — | — | — |

Paired median signed error (n=0; positive = optimistic): scenario-proportional — min, current — min.

Against its own pre-correction scan (n=0): scenario-proportional — min, scenario-proportional-original — min; paired median change in absolute error — min (n=0, negative = the correction lands closer).

##### age unknown (null)

n: 12166 records, 53 window lifecycles, 39 episodes.

Lifecycle-balanced (one record per window lifecycle, median instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 53 | 100.0% | 53 | 0 | 9 | 24 | 18 | 2 | 0.273 | 0.818 | 0.409 | -1610.6 | 1610.6 | 0.160 |
| scenario-equal | 53 | 100.0% | 53 | 0 | 10 | 24 | 18 | 1 | 0.294 | 0.909 | 0.444 | -1417.9 | 1402.2 | 0.139 |
| scenario-equal-original | 53 | 100.0% | 53 | 0 | 10 | 24 | 18 | 1 | 0.294 | 0.909 | 0.444 | -1417.9 | 1402.2 | 0.139 |
| scenario-headroom | 53 | 100.0% | 53 | 0 | 9 | 23 | 19 | 2 | 0.281 | 0.818 | 0.419 | -736.2 | 954.1 | 0.095 |
| scenario-proportional | 53 | 100.0% | 53 | 0 | 10 | 25 | 17 | 1 | 0.286 | 0.909 | 0.435 | -1775.2 | 1402.2 | 0.139 |
| scenario-proportional-original | 53 | 100.0% | 53 | 0 | 10 | 25 | 17 | 1 | 0.286 | 0.909 | 0.435 | -1775.3 | 1402.2 | 0.139 |

| estimator | usable | insufficient_data | low_confidence | no_slope | no_reset | total |
|---|---:|---:|---:|---:|---:|---:|
| current | 53 | 0 | 0 | 0 | 0 | 53 |
| scenario-equal | 53 | 0 | 0 | 0 | 0 | 53 |
| scenario-equal-original | 53 | 0 | 0 | 0 | 0 | 53 |
| scenario-headroom | 53 | 0 | 0 | 0 | 0 | 53 |
| scenario-proportional | 53 | 0 | 0 | 0 | 0 | 53 |
| scenario-proportional-original | 53 | 0 | 0 | 0 | 0 | 53 |

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
| scenario-proportional | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional | 12h-48h | 4 | 1 | 0.800 | 278.3 | 19 |
| scenario-proportional | >48h | 6 | 0 | 1.000 | -2653.4 | 6 |
| scenario-proportional-original | <30m | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 30m-2h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 2h-12h | 0 | 0 | — | — | 0 |
| scenario-proportional-original | 12h-48h | 4 | 1 | 0.800 | 274.3 | 19 |
| scenario-proportional-original | >48h | 6 | 0 | 1.000 | -2653.4 | 6 |

Per record (every scored instant):

| estimator | instants | usable | scored | censored | TP | FP | TN | FN | precision | recall | F1 | median signed err (min) | median abs err (min) | median abs err (window) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 12166 | 100.0% | 12166 | 0 | 2738 | 5027 | 3843 | 558 | 0.353 | 0.831 | 0.495 | -265.1 | 1318.6 | 0.131 |
| scenario-equal | 12166 | 100.0% | 12166 | 0 | 2930 | 5312 | 3558 | 366 | 0.355 | 0.889 | 0.508 | -545.4 | 1132.1 | 0.112 |
| scenario-equal-original | 12166 | 100.0% | 12166 | 0 | 2930 | 5312 | 3558 | 366 | 0.355 | 0.889 | 0.508 | -545.4 | 1132.1 | 0.112 |
| scenario-headroom | 12166 | 100.0% | 12166 | 0 | 2604 | 4635 | 4235 | 692 | 0.360 | 0.790 | 0.494 | -122.0 | 1019.7 | 0.101 |
| scenario-proportional | 12166 | 100.0% | 12166 | 0 | 2931 | 5431 | 3439 | 365 | 0.351 | 0.889 | 0.503 | -623.5 | 1308.3 | 0.130 |
| scenario-proportional-original | 12166 | 100.0% | 12166 | 0 | 2931 | 5431 | 3439 | 365 | 0.351 | 0.889 | 0.503 | -623.5 | 1308.3 | 0.130 |

Paired median signed error (n=9; positive = optimistic): scenario-proportional -1775.2 min, current -1610.6 min.

Against its own pre-correction scan (n=10): scenario-proportional -1775.2 min, scenario-proportional-original -1775.3 min; paired median change in absolute error 0.0 min (n=10, negative = the correction lands closer).

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
| Overall | scenario-proportional | 767 | 41666 | 10.3 | 19.7 | 0.000 |
| Overall | scenario-proportional-original | 767 | 41666 | 10.5 | 20.1 | 0.000 |
| Any transition | current | 165 | 4016 | 11.5 | 18.7 | 0.000 |
| Any transition | scenario-equal | 198 | 6506 | 11.7 | 24.9 | 0.000 |
| Any transition | scenario-equal-original | 198 | 6506 | 11.7 | 24.9 | 0.000 |
| Any transition | scenario-headroom | 198 | 6506 | 12.8 | 24.2 | 0.000 |
| Any transition | scenario-proportional | 198 | 6506 | 11.5 | 20.0 | 0.000 |
| Any transition | scenario-proportional-original | 198 | 6506 | 11.5 | 19.7 | 0.000 |

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
| anthropic | scenario-proportional | 7627 | 1010 | 5245 | 217 | 7410 | 0 | 0.997 |
| anthropic | scenario-proportional-original | 7627 | 1010 | 5245 | 217 | 7410 | 0 | 0.997 |
| codex | current | 5868 | 1020 | 2594 | 2213 | 1398 | 2257 | 0.274 |
| codex | scenario-equal | 5868 | 1020 | 2594 | 2213 | 1398 | 2257 | 0.274 |
| codex | scenario-equal-original | 5868 | 1020 | 2594 | 2213 | 1398 | 2257 | 0.274 |
| codex | scenario-headroom | 5868 | 1020 | 2594 | 2213 | 1398 | 2257 | 0.274 |
| codex | scenario-proportional | 5868 | 1020 | 2594 | 2213 | 1398 | 2257 | 0.274 |
| codex | scenario-proportional-original | 5868 | 1020 | 2594 | 2213 | 1398 | 2257 | 0.274 |

## Verdict

```
MODELS. `scenario-proportional` is the demand-conserving scan that splits
   each class's demand across the accounts alive at an instant in
   proportion to their own measured burn, and ADVANCES each reading over
   its observation lag; `scenario-proportional-original` is the same
   proportional rule with the pre-correction scan, which schedules every
   window from the instant of the replay however old its reading is. Both
   are scored on the COMMON cohort: every model usable, truth observed.

A. NOT MORE OPTIMISTIC ON TRANSITIONS. On the any-transition cohort,
   lifecycle-balanced: max(paired median signed error of scenario-
   proportional, 0) <= max(paired median signed error of current, 0), AND
   recall of scenario-proportional >= recall of current. (Positive signed
   error = predicted later than observed = optimistic; a model that is
   EARLY is not rewarded for it, which is why both sides are clamped at 0.)
B. BETTER AT TRANSITIONS. On the same cohort, F1 of scenario-proportional
   >= F1 of current.
C. NO SIGNIFICANT OVERALL LOSS. On the overall cohort, the block-bootstrap
   95% CI of F1(scenario-proportional) - F1(current) is not entirely below
   zero (p97.5 >= 0). Read from the entry whose BASELINE is the current
   model.
D. NOT WORSE THAN THE ORIGINAL SCENARIO. On the any-transition common
   cohort, lifecycle-balanced: F1(scenario-proportional) >= F1(scenario-
   proportional-original), AND the paired median of |error of scenario-
   proportional| - |error of scenario-proportional-original| <= 0 over the
   records both models dated. Recall of both is printed beside D and is NOT
   judged: the correction can change the ORDER of a class's events, and
   with it which windows are dated before their reset at all, in EITHER
   direction.

replace = A and B and C and D. keep-scenario = any criterion FALSE.
insufficient-evidence = no criterion false, at least one indeterminate.
The verdict basis is the PROPORTIONAL share rule, re-declared on 2026-09-07
after it was scored as a candidate beside the equal split, which had been
the basis through v2026.9.19. The equal split and the headroom rule are
scored beside it and never enter the verdict.
```

**A. not more optimistic on transitions: PASS**

| value | number |
|---|---:|
| paired median signed error, scenario-proportional (min) | -11.930 |
| paired median signed error, current (min) | -0.435 |
| paired n | 18 |
| recall, scenario-proportional | 0.857 |
| recall, current | 0.643 |

**B. better at transitions: PASS**

| value | number |
|---|---:|
| F1, scenario-proportional | 0.533 |
| F1, current | 0.474 |

**C. no significant overall loss: PASS**

| value | number |
|---|---:|
| F1 delta p2.5 | 0.003 |
| F1 delta p50 | 0.044 |
| F1 delta p97.5 | 0.091 |
| resamples | 1000 |

**D. not worse than the original scenario: FAIL**

| value | number |
|---|---:|
| F1, scenario-proportional | 0.533 |
| F1, scenario-proportional-original | 0.545 |
| paired median |error| change vs own control (min) | 0.000 |
| paired n | 24 |
| recall, scenario-proportional | 0.857 |
| recall, scenario-proportional-original | 0.857 |

| cohort | records | lifecycles | episodes |
|---|---:|---:|---:|
| Overall | 25200 | 619 | 57 |
| Any transition | 4280 | 171 | 57 |

Coverage of the basis and its control: scenario-proportional 42975 usable records, scenario-proportional-original 42975.

**Verdict: keep-scenario**

PROVISIONAL: the peer-exhaustion (codex), add (codex), upgrade (codex) pairs hold no usable, uncensored weekly record common to all models, and each carries at least one tagged weekly window still pending at the label horizon, so their weekly half is unlabelled. Re-run the reproduce command above with a later `--to` once those windows have reset, and re-read the verdict.

What step 4 does with this:

- `replace`: the scenario becomes the headline runway, with the current model kept beside it for one release.
- `keep-scenario`: the scenario stays a labelled second line and exclusion keeps the headline.
- `insufficient-evidence`: nothing ships; the run repeats when the missing windows have completed.

### Identity with the current model on the first assignment

The identity the basis is constructed to have: while every account whose measured burn is in the class demand is alive AND in the assignment, the demand handed back to an account is the burn it contributed, so it burns at its own measured slope and `scenario-proportional`'s projection IS the current model's. The population is the records whose window the basis's own scan projects entirely on its first assignment — no class window already at 100 % at the instant, no account whose burn joined the class demand withheld from the pool that demand is split over, no class exhaustion of ANY cycle between the instant and this window's own, and no class window filled inside its own observation lag — and where both the basis and the current model committed to a date. The withheld and later-cycle conditions are the two the scan's first-cycle projection list cannot state on its own: one redistributes demand with nothing having died, the other is a death after a reset. Below the tolerance an ETA is the same instant; the column is a count, not a claim about the rest of the replay.

n=5007 eligible records, 5007 of which the basis dated within 1 ms of the current model (100.0%).

## Share rules beside the basis

Every other share rule the replay scans, held to the same four criteria as the verdict, computed by the same functions on the same lifecycle-balanced cohorts and against the same comparison models. NONE of it enters the verdict: `evaluateVerdict` reads nothing from this section, and the verdict above is the same with or without it. `scenario-equal` is here because it WAS the verdict basis through v2026.9.19, and is kept scored beside the basis that replaced it so the change of basis can be read rather than taken on trust. Each rule's criterion D is judged against its OWN pre-correction scan; a rule that has none says so instead of borrowing another rule's control.

### `scenario-equal` — the PRIOR verdict basis, pre-declared and scored as the basis through v2026.9.19

| criterion | statistic | scenario-equal | scenario-proportional | current | scenario-equal-original | result |
|---|---|---:|---:|---:|---:|---|
| A. not more optimistic on transitions | paired median signed error (min) | 14.106 | -11.930 | -3.643 | — | FAIL |
| B. better at transitions | F1 on transitions | 0.568 | 0.533 | 0.474 | — | PASS |
| C. no significant overall loss | overall F1 delta against current, p97.5 | 0.145 | 0.091 | — | — | PASS |
| D. not worse than the original scenario | F1 on transitions | 0.568 | 0.533 | 0.474 | 0.568 | PASS |
| D. not worse than the original scenario | paired median absolute-error change against its own pre-correction scan (min) | 0.000 | 0.000 | — | — | PASS |

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
| paired median |error| change vs own control (min) | 0.000 |
| paired n | 21 |
| recall, scenario-equal | 0.750 |
| recall, scenario-equal-original | 0.750 |

### `scenario-headroom` — the headroom rule, reported since the first run and never a basis

| criterion | statistic | scenario-headroom | scenario-proportional | current | own control | result |
|---|---|---:|---:|---:|---:|---|
| A. not more optimistic on transitions | paired median signed error (min) | 48.618 | -11.930 | -4.820 | — | FAIL |
| B. better at transitions | F1 on transitions | 0.507 | 0.533 | 0.474 | — | PASS |
| C. no significant overall loss | overall F1 delta against current, p97.5 | — | 0.091 | — | — | INDETERMINATE |
| D. not worse than the original scenario | F1 on transitions | 0.507 | 0.533 | 0.474 | — | INDETERMINATE |
| D. not worse than the original scenario | paired median absolute-error change against its own pre-correction scan (min) | — | 0.000 | — | — | INDETERMINATE |

- C is indeterminate: the replay bootstraps the verdict basis and `scenario-equal` only, so `scenario-headroom` has no F1-delta CI against the current model here.
- D is indeterminate: `scenario-headroom` has no pre-correction scan of its own in this replay, and judging it against another rule's control would compare two share rules and the lag advance at once.

**A. not more optimistic on transitions: FAIL**

| value | number |
|---|---:|
| paired median signed error, scenario-headroom (min) | 48.618 |
| paired median signed error, current (min) | -4.820 |
| paired n | 14 |
| recall, scenario-headroom | 0.607 |
| recall, current | 0.643 |

**B. better at transitions: PASS**

| value | number |
|---|---:|
| F1, scenario-headroom | 0.507 |
| F1, current | 0.474 |

**C. no significant overall loss: INDETERMINATE**

| value | number |
|---|---:|
| F1 delta p2.5 | — |
| F1 delta p50 | — |
| F1 delta p97.5 | — |
| resamples | — |

**D. not worse than the original scenario: INDETERMINATE**

| value | number |
|---|---:|
| F1, scenario-headroom | 0.507 |
| F1, no pre-correction control | — |
| paired median |error| change vs own control (min) | — |
| paired n | 0 |
| recall, scenario-headroom | 0.607 |
| recall, no pre-correction control | — |

## Known limits

- Pause and removal cannot be replayed: `usage_snapshots` rows cascade-delete with their account, so no removed account has history, and `accounts.paused` keeps none. The scenario's `presence: "demand-only"` path is covered by its unit tests only.
- Snapshots before 2026-08-24 carry no `plan_tier`/`rate_limit_tier` and no `observed_at`. Tiers there are today's, marked `assumed`; without an observation instant the weekly full-confidence path is unavailable to BOTH models, so the two are still compared like for like.
- No reset-credit bank is modelled, and no live usage point is injected — the replay only has what the sampler stored.
- The headroom share rule is reported, never used as the verdict basis. The verdict basis is the proportional share rule, re-declared on 2026-09-07 after it was scored as a candidate beside the equal split, which had been the basis through v2026.9.19; both the equal split and the headroom rule are scored beside it and neither enters the verdict.
- The verdict basis weights each account by its OWN measured demand, and that demand is the same fitted slope the current model projects from. Each alive account's share of a kind's class demand is its own measured demand for the kind over the ALIVE accounts' measured demand for it. The denominator is the survivors, not the class: with burns of 80, 20 and 10 and the 80 dead, the two survivors take two thirds and one third of the whole class demand, not 20/110 and 10/110 of it. A window still learning has no accepted measured-demand contribution — the preparation withholds it whatever its fitted slope says — so it carries no weight of its own and takes demand only through the rule's equal-split fallback; where a class's live accounts are all learning for a kind, the basis IS the equal split for that kind.
- IF a survivor's own lookback already contains the traffic it absorbed, the scenario would be adding that demand a second time. Whether it does is a hypothesis this replay reports on (the peer-exhaustion cohort and the survivor slope table) rather than a property these measurements establish; nothing here corrects for it.
- The observation-lag advance never rewinds the scan clock below the instant being replayed: a window that fills inside its lag dies AT that instant, though the projection it records carries the true, earlier one. Any redistribution such a death causes therefore starts at the instant, not at the fill.
- A reading whose row carries no `observed_at` and whose estimator is the now-anchored lifetime average has no derivable lag and is advanced by nothing. That is a real absence, not a measured zero, and the mechanism section reports those records under `unknown` rather than folding them into the fresh bucket.
- The absorption section's first reading at or above 100 % is a sampled crossing, not the instant the window filled, so every fill duration there is an upper bound within the sample gap printed beside it in that section's `median resolution` column.
- `requests.timestamp` is persistence time, not request time, and the death instant is the first sampled 100 % reading rather than the moment routing changed. Persistence lag and sampled exhaustion timing misalign the request-volume intervals with request execution and with the routing change; the direction and magnitude of the resulting error are unmeasured, and the misalignment matters more as the half-width shrinks.
- `requests` has no foreign key to `accounts`, so a deleted account's traffic is unattributed. Such an account also has no snapshots, which cascade-delete with it, so it can appear neither in a survivor set nor in the availability history the survivor set is derived from.
- Pause has no history in the database, so an account idle during a matched-control interval cannot be told from one deliberately parked, and no adjustment for that is possible.
- A regression fit that states no ETA — a flat or falling six-hour fit, which an idle account inside a live window produces — has no recoverable anchor either: the fit's anchor is back-solved from the ETA. Such a window is scheduled from the replayed instant in BOTH scans, which is pre-existing behaviour and not something the correction introduced, and the lag-population table counts those records apart from the lags it medians.
- Pending at this run (tag and servable class): peer-exhaustion (codex), add (codex), upgrade (codex). Those pairs hold no usable, uncensored weekly record common to all models, and each carries at least one tagged weekly window still pending at the label horizon, so their weekly half is unlabelled and the verdict is provisional.
- Positive counts (all records, per model) — current: 3686 actual positives of 25200 scored; scenario-equal: 5826 actual positives of 42295 scored; scenario-equal-original: 5826 actual positives of 42295 scored; scenario-headroom: 5826 actual positives of 42295 scored; scenario-proportional: 5826 actual positives of 42295 scored; scenario-proportional-original: 5826 actual positives of 42295 scored.
- `total_tokens` is null or zero on 8957 of 621632 attributed `requests` rows in the loaded span (1.4 %); those contribute zero to the absorption measurement's token basis.

## Notes

- Placeholder windows skipped: 233.
- Replay took 38.9 s over 9648 instants; scoring and bootstrap 5.8 s.
- Grid step 10 min; rows loaded 8 days either side of the replay interval.
- Request buckets loaded: 64432 minute buckets over 7 accounts, on a 60-second grid, spanning 2026-06-23T09:31:00.000Z to 2026-09-07T15:23:00.000Z.
