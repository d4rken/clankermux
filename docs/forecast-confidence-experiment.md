# Forecast confidence experiment — 2026-09-06

Keep the production one-hour confidence gate. Improve its explanation and expose
each window's forecast independently of the combined account runway.

The experiment in `scripts/forecast-confidence-backtest.ts` evaluates an earlier
gate using distinct provider observations, rather than repeated snapshots of a
cached reading. Its thresholds were fixed before inspecting the results:

- Six distinct observation timestamps spanning at least 15 minutes.
- At least five percentage points of growth since the last reset or revision.
- A rising regression, with the slope over the latter half of the observations
  within 25% of the whole segment's slope.
- Latest observation at most ten minutes old; untimed and future observations
  cannot supply evidence.

The candidate supplements the existing gate only where it abstains. It is an
offline experiment and is not imported by the server or dashboard.

## Replay

Read-only replay of 27,787 Anthropic snapshots, all carrying observation times.
Development: August 25–30; held-out: August 31–September 5, 2026 (UTC).
Sample forecast instants ten minutes apart within each quota window. Label
outcomes with the existing backtest's reset-boundary and censoring rules; reject
outcomes that end outside their partition. Reconstruct credit anchors from
observed downward revisions. Only past observations feed a forecast.

```sh
bun scripts/forecast-confidence-backtest.ts \
  /path/to/clankermux.db \
  2026-08-25T00:00:00Z 2026-08-31T00:00:00Z 2026-09-06T00:00:00Z
```

| Partition | Additional forecasts | Correct exhaustion warnings | False exhaustion warnings | Correct survivals | Missed exhaustions |
| --- | ---: | ---: | ---: | ---: | ---: |
| Development | 25 | 0 | 17 | 8 | 0 |
| Held-out | 35 | 9 | 18 | 7 | 1 |

The held-out candidate increases scored forecast points from 1,471 to 1,506,
out of 3,443 eligible instants. Only 9 of its 27 additional exhaustion warnings
are followed by exhaustion (33% precision). Across the ten additional forecasts
whose windows actually exhaust, median absolute ETA error is 49.2 minutes.
Combined median ETA error increases from 24.7 to 25.4 minutes.

This is insufficient evidence to enable earlier forecasts. Points from the
same account/window are correlated, the additional points span only five
accounts, and the development partition has no observed exhaustions among
scored points. This evaluates account-wide five-hour windows under historical
routing/load, not pooled runway accuracy or a counterfactual constant workload.
It does not establish that one hour is optimal; it rejects this candidate as a
justification for relaxing that rule. Future experiments should use a new
held-out period and report per-window/account uncertainty.

## Display behavior

`/api/runway` now carries each window's independent forecast or learning reason.
The Usage page shows these side by side: a learning five-hour window no longer
hides a usable weekly forecast. Combined runway remains unknown for that
account. Zero usage waits for usage; a short history reports the remaining
time and the need for a fresh reading. A cached response cannot promote itself
to a confident forecast just because the displayed countdown elapsed.
