# Public widget API

The read-only API serves small displays, Linux Mint applets and macOS menu-bar
widgets. All routes are unauthenticated `GET /public/v1/<resource>`. This contract
replaces the earlier API in place: `/pacing`, `/runway` and `/workload-headroom`
are removed. There is no compatibility adapter or parallel API version.

| Resource | Purpose | Schema | Example |
| --- | --- | --- | --- |
| `status` | Service readiness, version, uptime, configured and paused account totals | [Schema](schemas/status.schema.json) | [JSON](examples/status.json) |
| `accounts` | Account identity, credentials status, availability, observed quota windows and per-window forecasts | [Schema](schemas/accounts.schema.json) | [JSON](examples/accounts.json) |
| `workloads` | Current availability and weekly-only budget outlook per class and model family | [Schema](schemas/workloads.schema.json) | [JSON](examples/workloads.json) |
| `stops` | Seven-day request/block totals, causes and routing-candidate distribution | [Schema](schemas/stops.schema.json) | [JSON](examples/stops.json) |
| `stream` | Active request snapshot and request lifecycle events over SSE | [Schema](schemas/stream.schema.json) | [Snapshot](examples/stream.snapshot.json) |

Account and project names are public. Credentials, prompts and response bodies
are not exposed. Status `serviceState: ready` describes the serving process; it
makes no claim about account capacity. Use workloads for availability.

## The default widget endpoint

Poll `/workloads` and select stable IDs: `class:anthropic`, `class:codex`, and
`family:fable`. Labels are display text, never keys. Family rows link through
`parentWorkloadId` where a single parent class is known. Fable overlaps Claude;
capacities and percentages must not be added.

Each workload has two independently timestamped sections:

- `availability`: the candidates for a fresh, unpinned, nominal-size request,
  after provider and workload-family gates. Counts are available, constrained
  or unknown (disjoint). Missing usage alone does not block routing.
  `nextRecoveryAt` is the earliest known lift that clears all known holds on
  one constrained account; a null value is not proof there will be no recovery.
- `weekly`: a forecast using account-wide weekly windows and, for a family,
  its scoped weekly windows. Five-hour evidence never controls weekly coverage.
  Weekly membership includes subscription accounts reporting weekly quotas; paid
  or unmetered fallback stays in availability but cannot conceal an exhausted
  subscription budget. Availability and weekly coverage therefore have different
  denominators.
  `computedAt` dates the calculation; `evidenceObservedAt` is the oldest account
  observation, null if some eligible account has no observation time.

Availability is cached for about five seconds; weekly calculations for sixty
seconds. A newly assembled `generatedAt` does not refresh either section's
underlying evidence. Polling faster cannot refresh the provider. Use bounded
retry/backoff and render stale evidence separately; a three-minute client stale
indicator is a reasonable UI policy, not a forecast accuracy guarantee.

### Weekly outcome and evidence

`period` states `startsAt`, `endsAt` and `endReason: next_weekly_reset`. This is
**until the earliest known future weekly reset**, including usable deadlines on
eligible accounts excluded from modeling. Unstarted sliding reset placeholders
are ignored. The deadline is a planning checkpoint, not a promise that all
accounts—or even a blocked account—recover then. Do not label it “safe all week.”
A missing deadline leaves `period: null`. Refresh at the deadline; expired
cached advice is withheld until a new calculation is available.

| `outcome` | Meaning |
| --- | --- |
| `exhausted` | The modeled weekly pool is exhausted now. |
| `exhausts_before_end` | The modeled pool projects an interruption before the checkpoint; see `exhaustsAt`. |
| `lasts_until_end` | No all-out interval is projected before the checkpoint. |
| `unknown` | No outcome can be established. |
| `no_accounts` | No active accounts were considered. |
| `not_applicable` | This workload reports no weekly subscription quota. |
| `other` | Unrecognized state; display neutral/unavailable advice. |

`quality` describes estimator evidence: `supported`, `limited` or `unavailable`.
The separate `reason` explains missing or limited evidence. Quality is not an
accuracy probability, and supported evidence does not imply complete coverage.

Coverage categories are disjoint:

```
eligibleAccounts = modeledAccounts + idleAccounts
                  + learningAccounts + unavailableAccounts
```

`idleAccounts` have no burn evidence (including unopened family windows);
`learningAccounts` need more history; `unavailableAccounts` lack usable evidence.
These describe forecasting, not routing availability. An idle account can serve
work now. With partial coverage, describe the projected **subset**, not the
whole pool. Example: “Weekly risk · 3/5 modeled · 2 idle.”

`accountRisk` counts observations of spent accounts, projected exhaustion before
each account's own reset, accounts projected within their own budget, and
unassessable accounts. These categories are disjoint, count every eligible
account, and do not predict how many accounts will be unavailable simultaneously.
They describe observed windows, before hypothetical automated credit redemption.

### Pace adjustment

`pace.changePct` is a signed **estimated change in consumption rate at the
current per-account workload distribution**. It is not remaining quota, tokens,
or a number of agents. The model keeps account burn fixed and does not move a
spent account's demand onto its survivors. Five-hour limits can still interrupt
work separately. Even complete weekly coverage does not remove these assumptions.

| `pace.state` | Interpretation |
| --- | --- |
| `estimate` | Positive: last tested passing increase. Negative: the estimated reduction with a contiguous passing tail to the tested floor. Zero: no additional tested increase fits. |
| `increase_limit` | Every tested increase passed. `changePct` gives the largest tested increase, not an exact maximum. |
| `reduction_limit` | The maximum tested reduction was insufficient. `changePct` gives that tested reduction, not a recommended cut. |
| `unavailable` | No recommendation; `changePct: null` and `reason` explain why. |
| `other` | Unrecognized result; display neutral/unavailable advice. |

The current search tests 1% steps up to +50% or down to -50%. Aborted searches
are unavailable, never mislabeled as limits. Positive estimates use the **last
passing** step, correcting the old API's first-failing-step semantics. Family
`qualification: conservative_bound` reflects unknown family shares of the
account-wide burn; other rows use `estimate`. Family bounds with modeled credits
are withheld. Partial coverage or weak baseline evidence also withholds numeric
pace advice; per-account risk stays available.

Examples: [partial coverage](examples/workloads.partial.json),
[increase limit](examples/workloads.increase-limit.json),
[reduction limit](examples/workloads.reduction-limit.json),
[family restriction](examples/workloads.family.json).

## Account detail

Account identity, provider, credential status and availability remain separate
from quota measurements. There is no overall maximum-utilization gauge or
routing-candidate flag. `windows[]` retains each window's `kind`, `scopeId`,
label, utilization, observation time and reset. There is one `forecast` object;
the regression-only `prediction` object is removed.

Window forecast outcomes are `exhausted`, `exhausts_before_reset`,
`lasts_until_reset`, `unknown` or `other`. An extrapolation after reset is not
published as exhaustion. `quality` and `reason` explain whether evidence is
usable. Learning reasons are `no_usage`, `unstarted` and `short_history`.
`reassessAt` is the earliest useful fresh reading for short history, never an
automatic readiness promise. Stale, missing and reset-elapsed evidence cannot
produce a reassuring forecast. See [idle session with weekly evidence](examples/accounts.partial-learning.json).

## Recorded request outcomes

`/stops` reports explicit proxy refusals in `blockedRequests` and its `causes`
array. Failures, recorded downstream disconnects and unknown outcomes have
separate `failedRequests`, `disconnectedRequests` and `unclassifiedRequests`
counts. A forwarded upstream error or a generic `all_accounts_failed` terminal
is a failure; neither proves that the pool ran out of quota.

`totalRequests` excludes verified per-attempt audit rows written by older
builds. `excludedAttemptAuditRows` states how many were removed from both the
request denominator and outcome counts. The dashboard's Request outcomes card
uses the same computation. Request History and general statistics retain their
existing record-based totals.

These counts describe stored terminal reasons. A disconnect does not establish
user intent, and aborts that were never recorded cannot be counted. Captured
upstream errors can replace a transport reason. Historical completion mistakes
are not rewritten or inferred away.

The v1 field names and public cause vocabulary remain stable; the additional
counts are additive fields. The public event stream keeps its existing error
categories, including its older quota category for `all_accounts_failed`.

## Wire and transport rules

Instants are ISO/RFC3339 strings; durations include units in field names. Null
measurements are unavailable, not zero. Join using IDs. Labels are bounded to
96 UTF-8 bytes; IDs are not truncated. Responses use shallow objects and at
most two array levels. Accept unknown object fields and neutral enum fallbacks.
Schemas describe the replacement contract; old payloads are not supported.

Known routes reject non-GET methods with `405` and `Allow: GET`; removed and
unknown routes return `404` at the public mount. Failed reads are errors, never
zero-capacity snapshots. The SSE connection cap can return `503` with
`Retry-After`. Successful-resource schemas do not describe error responses.

`/stream` uses `text/event-stream`: JSON events are `active.snapshot`,
`request.opened`, `request.dropped`, `request.upstream` and `request.done`.
The initial snapshot supports reconnect/reconciliation by request ID. The
`connected` and `server-shutdown` controls carry plain text; `: ping` is a
heartbeat comment. These controls are not JSON resource events.

## Maintaining the contract

```sh
bun run public-api:generate
bun run public-api:check
bun test scripts/public-api/schema.test.ts
```

Schemas use Draft 2020-12 and are generated from named public DTO types.
Examples and actual serializers are validated in tests; no schema tooling runs
in the API request path. Provider refreshes and routing-cache mutations are
never initiated by a public GET.
