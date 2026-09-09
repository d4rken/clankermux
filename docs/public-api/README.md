# Public API

The widget API is read-only and requires no credentials. All routes below are `GET /public/v1/<resource>` on the existing server base URL. Successful responses are JSON, except for the SSE stream.

| Resource | Data | Contract | Example |
| --- | --- | --- | --- |
| `status` | Health, uptime/version, pool counts, routing candidate, aggregate quota usage and provider overload state | [Schema](schemas/status.schema.json) | [JSON](examples/status.json) |
| `accounts` | Account IDs/names, providers, availability, credential state/expiry, quota windows, predictions, per-window forecasts and learning reasons | [Schema](schemas/accounts.schema.json) | [JSON](examples/accounts.json) |
| `runway` | Worst stateable API-key/pool quota outcome, headroom and coverage; key identities/pins omitted | [Schema](schemas/runway.schema.json) | [JSON](examples/runway.json) |
| `stops` | Seven-day request/block totals, stop causes and candidate-count distribution | [Schema](schemas/stops.schema.json) | [JSON](examples/stops.json) |
| `pacing` | Per-class spending context, least-used account's weekly burn ratio, five-hour constraints | [Schema](schemas/pacing.schema.json) | [JSON](examples/pacing.json) |
| `workload-headroom` | Per-class/family quota forecast, advisory state, evidence and coverage for two planning intervals | [Schema](schemas/workload-headroom.schema.json) | [JSON](examples/workload-headroom.json) |
| `stream` | Active-request snapshot and live request events including project/model, timing, tokens and costs | [Schema](schemas/stream.schema.json) | [Snapshot](examples/stream.snapshot.json) |

Account and project names are public. Credentials, API-key secrets, prompts and response bodies are not published. Account records are sorted by name; join by IDs, not display labels or array positions.

## Choosing parallel-work guidance

Use `workload-headroom.rows[].nextReset.guidanceState` for the compact display, with the numeric fields from that same object. Select `class/anthropic` for Claude, `class/codex` for GPT, and `family/fable` for reported Fable quotas. A family constraint overlaps its class capacity; their percentages cannot be added.

The workload and runway envelope's `intervalKind: "fixed_horizon"` starts at `generatedAt` and ends at `generatedAt + horizonMs`. A workload `nextReset.intervalKind: "until_next_weekly_reset"` starts at that same `generatedAt` and ends at `nextReset.resetsAt`. It forecasts **until**, not after, the reset. Keep the long-horizon row's advice separately labelled.

| `guidanceState` | Interpretation |
| --- | --- |
| `increase` | A measured, fully covered model states a margin; display the approximate percentage and bound qualification. |
| `reduce` | A measured, fully covered model states a deficit; display the approximate reduction and bound qualification. |
| `exhausted` | The fully covered model reports quota exhausted now. |
| `learning` | Every eligible account is still learning its burn. |
| `unknown` | No forecast can be established; waiting alone may not resolve missing data. |
| `no_accounts` | No eligible accounts. |
| `uncertain` | Evidence is weak or coverage incomplete; withhold a prescriptive percentage. |
| `unquantified` | Read `outcomeKind`: the model either clears the interval or projects exhaustion, but no numeric adjustment is stated. |
| `other` | Unrecognized/inconsistent state; show unavailable advice. |

`nextReset.headroomAbsence` explains its missing percentage: `learning_accounts`, `structural_evidence`, `bound_broken_by_credits`, `beyond_probe_range`, `not_projected`, or `other`. It is null when a number is stated. The existing row-level `headroomAbsence` describes only the long horizon. A null `nextReset` means no usable weekly deadline is known.

These are advisory model thresholds. The margin is the first failing 1% probe step, not a tested-safe increase of exactly that amount. Family percentages are conservative bounds. `projectionBasis` describes baseline evidence, not confidence in every hypothetical probe. The API does not prescribe agent counts or automatic scaling.

Use `/pacing` for spending and five-hour constraints, `/accounts` for operational details, and `/runway` for API-key/pin context. Never convert `/pacing.burnRatio` into a whole-pool recommendation. See the [integration guide](../external-widgets-pacing-guide.md) for rendering rules, compatibility cases and example interpretations.

## Account window evidence

`accounts[].windows[].forecast` exposes the canonical window estimate separately
from regression-only `prediction`. Weekly `prediction: null` does not mean no
forecast exists. A weekly projection remains visible when the five-hour window
is learning. The forecast states `projected` or `learning`, with `other` as a
fallback; learning reasons are `no_usage`, `unstarted`, or `short_history`.
Only short history has a possible `readyAt`, indicating the earliest useful
fresh observation rather than guaranteed readiness.

A projected forecast carries nullable `exhaustsAt` and `lowConfidence`. Compare
exhaustion with the window's `resetsAt`: raw extrapolation can extend past the
reset. Null/absent forecast means no usable forecast; preserve the separate
reading and its freshness. Stale, untimed, mismatched or already-reset evidence
is withheld. See [partial learning](examples/accounts.partial-learning.json).

For partial workload coverage, render `eligibleAccounts - unreadableAccounts`
from the same workload row: for example, “3/5 modeled · 2 learning”. Do not
subtract `unopenedAccounts` or `learningAccounts` again, reconstruct coverage
from a separate accounts response, or turn idle usage into a growth percentage.

The workload envelope's `paceProbe` publishes `maximumReductionPct`,
`maximumIncreasePct` and `stepPct` (currently 50, 50 and 1). A missing adjustment
with `beyond_probe_range` means either no tested reduction avoids exhaustion,
or no tested increase finds failure; use the selected interval's `outcomeKind`
to distinguish them. Qualify these statements by modeled coverage and family
bounds. They are search limits, not whole-pool scaling instructions. The model
holds per-account burn fixed and does not redistribute demand after failover.

## Compatibility, freshness and errors

Schemas use Draft 2020-12 and accept unknown object fields. New metadata fields and historically optional `nextReset` are optional in the compatibility schemas; current producers always emit the new fields where their containing object exists. Keep neutral fallbacks for descriptive enum `other` and unknown future values. Schema IDs and v1 paths remain unchanged.

Instants are ISO/RFC3339 strings; durations carry units in their names. Null measurements are unavailable, not zero. Display strings are limited to 96 UTF-8 bytes; identifiers are not truncated. JSON Schema length validation cannot replace that byte-level producer rule.

Poll pacing and workload forecasts about once per minute. Their snapshots are memoized for 60 seconds; `generatedAt` is the computation time, not necessarily the observation time. Consumers own stale-age policy, retry/backoff and deadline expiry. A three-minute stale threshold is a suggested UI policy, not a server guarantee. Do not infer a reset when a countdown expires; fetch a new snapshot.

Known routes reject non-GET methods with `405` and `Allow: GET`. Unknown public routes return `404`. The SSE connection cap can return `503` with `Retry-After`. Other failed reads can return server errors; handle non-success responses before parsing a resource payload. Error responses are outside the successful-resource schemas and should not be interpreted as zero capacity.

## Stream transport

The response uses `text/event-stream`. JSON `data:` records conform to the stream schema: `active.snapshot`, `request.opened`, `request.dropped`, `request.upstream` and `request.done`. The stream starts with the active snapshot, even when empty, after a `connected` control event. Subscribe/replay can overlap; reconcile requests by ID.

The named `connected` and `server-shutdown` events carry plain text (`ok`/`bye`), and `: ping` heartbeats are comments. These control frames are not JSON payloads. Reconnect after disconnect and replace active state from the new snapshot.

## Maintaining contracts

The [examples directory](examples/) contains complete invented payloads, including weak evidence, missing quota, credit limitations, opposing interval advice and stream variants.

```sh
bun run public-api:generate
bun run public-api:check
bun test scripts/public-api/schema.test.ts
```

Schemas are generated from the public DTO entry points with a reviewed compatibility/constraint manifest. Actual serialized responses, examples and legacy payloads are validated in tests; producer field allowlists independently enforce privacy. No schema-generation or validation dependency runs in the API request path.
