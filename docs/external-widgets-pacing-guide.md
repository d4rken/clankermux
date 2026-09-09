# Widget/display agent handover — release 2026.9.36

This release replaces the public API contract **in place**, under the existing
`/public/v1` prefix. Update Mint applets, macOS menu-bar widgets and small displays
to the replacement payloads. There is no parallel v2 API or legacy adapter.

## Endpoint migration

All routes are unauthenticated, read-only GETs on the existing server URL.

| Route | Action |
| --- | --- |
| `/public/v1/workloads` | New primary widget endpoint. Read `workloads[]`, not `rows[]`. |
| `/public/v1/accounts` | Keep for account details; use the new window forecast shape below. |
| `/public/v1/status` | Read `serviceState`, `version`, `uptimeS`, and `accounts.configured/paused`. Old pool, routing, usage and provider rollups are removed. |
| `/public/v1/stops` | Block history; retained. |
| `/public/v1/stream` | Active requests and live SSE events; retained. |
| `/public/v1/pacing`, `/public/v1/runway`, `/public/v1/workload-headroom` | Removed; return 404. Remove old fetches and fallback calculations. |

## Primary display

Select workload IDs `class:anthropic` (Claude), `class:codex` (GPT/Codex), and
`family:fable` (when reported). Join by ID, never label or position. A family's
`parentWorkloadId` identifies overlap: Fable and Claude are not independent pools.

Use two separate indicators:

- **Weekly budget:** `weekly.outcome`, `quality`, `reason`, `exhaustsAt`,
  `coverage`, and `pace`.
- **Available now:** `availability.availableAccounts`, `constrainedAccounts`,
  `unknownAccounts`, and `nextRecoveryAt`.

Five-hour learning no longer excludes usable weekly evidence. Weekly family
forecasts include both account-wide and family weekly limits. Availability
includes provider/family gates for a fresh, unpinned, nominal-size request; it
is not a guarantee for a restricted API key or a different request shape.
Paid fallback can be available even when subscription weekly quota is exhausted.

Weekly coverage categories are disjoint:

```
eligibleAccounts = modeledAccounts + idleAccounts
                  + learningAccounts + unavailableAccounts
```

Show coverage explicitly, e.g. “3/5 modeled · 2 idle”. `quality: supported`
describes estimator evidence; it does not imply complete coverage. With partial
coverage, qualify the projected subset rather than declaring the entire pool out.
`accountRisk` separately counts accounts spent, forecast at risk before their own
reset, within their budget, and unassessable. It does not describe simultaneous
pool exhaustion.

| Weekly outcome | Suggested wording |
| --- | --- |
| `exhausted` | “Weekly quota exhausted” (qualify partial coverage) |
| `exhausts_before_end` | “Weekly risk” with exhaustion time |
| `lasts_until_end` | “Projected to reach next reset” |
| `unknown` | “Forecast unavailable” with reason/coverage |
| `no_accounts` | “No active accounts” |
| `not_applicable` | “No weekly subscription quota” |
| `other` or unrecognized | Neutral unavailable state |

## Pace: inspect the state before the number

Read `weekly.pace`, replacing the old `headroomPct`/`headroomDirection` pair.
`changePct` is signed: positive means an estimated increase in consumption rate,
negative an estimated reduction. Never convert it directly into an agent count.

| Pace state | Rendering |
| --- | --- |
| `estimate` | “Estimated pace +N%” or “Estimated pace -N%”; zero means no additional tested increase fits. |
| `increase_limit` | “Tested increase fits”; value is the largest tested increase, not an exact maximum. |
| `reduction_limit` | “Tested cut insufficient”; value is the tested cut, not a recommended reduction. |
| `unavailable` | Withhold the percentage; use `reason`. |
| `other` or unrecognized | Withhold the percentage. |

Respect `qualification: conservative_bound` for families. The positive estimate
now uses the last tested passing step, correcting the previous first-failing-step
meaning. Do not use burn ratio, quota percentage averages or combined-window
headroom as a fallback. The model assumes the current per-account distribution
of burn; it does not redistribute demand after an account exhausts.

Example fragment (invented; see the reference for complete payloads):

```json
{
  "id": "class:anthropic",
  "weekly": {
    "outcome": "exhausts_before_end",
    "quality": "supported",
    "pace": {
      "state": "estimate",
      "changePct": -25,
      "qualification": "estimate",
      "reason": null
    }
  }
}
```

## Account detail and freshness

`accounts[].windows[]` retains `kind`, `scopeId`, utilization, observation time
and reset. It now has **one forecast object**:

- `outcome`: `exhausted`, `exhausts_before_reset`, `lasts_until_reset`, `unknown`
  or `other`. Exhaustion after reset is no longer exposed as a risk timestamp.
- `quality` and `reason`: includes `no_usage`, `unstarted`, `short_history`,
  stale/missing evidence and elapsed resets.
- `exhaustsAt` and `reassessAt`: the latter is the earliest useful fresh reading
  for short history, not a promise that learning ends then.

Remove references to window `prediction`, forecast `state/lowConfidence/readyAt`,
account-level `utilizationPct`, and `isDefaultCandidate`.

Poll `/workloads` about every 5–15 seconds if live availability matters, or once
a minute for budget-only displays. Availability is cached about five seconds;
weekly forecasts about sixty seconds. Use their separate `computedAt` fields
and weekly `evidenceObservedAt`; envelope `generatedAt` is not evidence freshness.

`weekly.period.endsAt` is the next known weekly reset checkpoint, not after the
reset or after a full week. Stop using advice when the deadline passes, and
refresh. Handle stale data, null periods, network errors and unknown enums
without turning them into zero capacity. A three-minute stale indicator is a
suggested client policy. Preserve bounded reconnect/backoff for polling and SSE.

Suggested compact layout: “Claude · weekly risk · estimated pace -25%”, with
“5 available now · 5/5 modeled” in the secondary line or popup.

The [API reference](public-api/README.md) includes all five schemas, complete
examples, model assumptions and SSE transport details. Schema IDs on retained
resources keep their existing names; do not assume that means old payload shapes
are still supported.
