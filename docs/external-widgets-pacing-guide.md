# External widget integration: pacing and next-reset guidance

Updated 2026-09-05. Audience: maintainers of desk widgets, applets, and other
external ClankerMux consumers.

The server changes accompanying this guide are **not deployed yet**. Prepare
clients to accept both the existing response and the additive `nextReset` field.
The schema remains `clankermux.public.workload-headroom.v1`.

This guide supersedes the headline selection and null-headroom rendering rules
in [the earlier pacing handover](handover-pacing-widget.md). Use a forecast for
the requested workload, check its evidence, and state the interval it covers.

## What to display

For a GPT/Codex widget, select the workload row with `dimensionKind: "class"`
and `dimensionId: "codex"`. For Claude, use the `anthropic` class. For a
particular scoped family, use its `family` row and stable `dimensionId`.
Do not select rows by array position or display label. Do not use spare Claude
capacity to imply spare Codex capacity, or add class and family percentages.

Make `row.nextReset` the primary day-to-day planning view when it is present
and its deadline is valid and future. Show “Until next weekly reset” and the
deadline/countdown beside the advice. This models the interval until the
earliest known weekly reset among the active accounts supporting that workload.
It is not necessarily seven days away, and it is not a promise that every
account recovers together. Five-hour constraints still participate in the scan.

Show the existing row fields separately as “Long-term pace · 14 days”, deriving
the number of days from the response's `horizonMs`. They retain their existing
meaning. Enough capacity until the next reset and an unsustainable pace over
two weeks can both be true.

For an overview widget, present one card per class rather than a single green
pool indicator. A family card may add a constraint that its class card does not
show. `/public/v1/runway` remains useful for API-key/pool runway context, but
its aggregate headroom does not answer whether a particular workload can grow.

## Endpoints

All routes below are read-only, unauthenticated routes on the existing
ClankerMux base URL. No provider credentials are needed.

| Purpose | GET route | Fields to use |
| --- | --- | --- |
| Primary workload forecast | `/public/v1/workload-headroom` | `rows[].nextReset` |
| Long-term workload forecast | `/public/v1/workload-headroom` | Existing fields on `rows[]`, plus `horizonMs` |
| Per-class spending context | `/public/v1/pacing` | `classes[]`, including server-provided tones |
| Individual account readings | `/public/v1/accounts` | Account IDs, names, paused state, windows |
| API-key/pool runway context | `/public/v1/runway` | Outcomes and coverage |

Poll workload headroom and pacing about once per minute. Their readers memoize
results for 60 seconds and coalesce concurrent reads. Faster polling does not
produce a fresh forecast. Use `generatedAt` as the computation timestamp; it is
not the observation timestamp of every underlying quota reading.

## New response fields

The following is an illustrative response fragment showing the two intervals;
the values are not a production account snapshot:

```json
{
  "schema": "clankermux.public.workload-headroom.v1",
  "generatedAt": "2026-09-05T00:00:00.000Z",
  "horizonMs": 1209600000,
  "rows": [
    {
      "dimensionKind": "class",
      "dimensionId": "codex",
      "label": "GPT",
      "nextReset": {
        "resetsAt": "2026-09-06T00:00:00.000Z",
        "outcomeKind": "beyond_horizon",
        "exhaustsAt": null,
        "headroomPct": 25,
        "headroomDirection": "margin",
        "projectionBasis": "measured"
      },
      "outcomeKind": "runway",
      "exhaustsAt": "2026-09-10T04:00:00.000Z",
      "headroomPct": 40,
      "headroomDirection": "deficit",
      "headroomBasis": "exact",
      "headroomAbsence": null,
      "projectionBasis": "measured",
      "eligibleAccounts": 1,
      "unreadableAccounts": 0,
      "spentAccounts": 0
    }
  ]
}
```

Suggested presentation: “Until next reset: 25% pace margin”, followed by
“14-day pace: reduce by 40% if this burn continues”. These percentages describe
changes to consumption rate, not remaining quota, token balances, or exact
numbers of additional agents.

| `nextReset` field | Contract |
| --- | --- |
| `resetsAt` | ISO timestamp, nullable defensively; validate before rendering a countdown. |
| `outcomeKind` | `beyond_horizon`, `runway`, `out_now`, `unknown`, `no_accounts`, or `other`. Here the horizon ends at `resetsAt`. |
| `exhaustsAt` | ISO timestamp for `runway`; null for the other outcomes. |
| `headroomPct` | Magnitude of the pace adjustment, or null when no figure is stated. |
| `headroomDirection` | `margin`, `deficit`, `other`, or null. It carries the sign. |
| `projectionBasis` | `measured`, `structural`, `other`, or null. Check before showing prescriptive advice. |

`nextReset` is null when no usable future weekly deadline is known. The field
will be absent on older servers. Both cases must be supported.

The row's `headroomBasis` distinguishes class thresholds (`exact`, within the
server's model and probe resolution) from family bounds (`conservative_bound`).
The next-reset family calculation uses the same conservative method. Label its
figures as bounds rather than exact recommendations. For example, a margin is
a conservative estimate of room to grow; a deficit is a conservative cut.

The nested object has no `headroomAbsence` field. The row's existing
`headroomAbsence` describes the **long-term** calculation only. Do not copy it
into the next-reset interpretation.

## Rendering rules

Handle freshness and evidence before interpreting a missing headroom value.

| Condition | Suggested display and behavior |
| --- | --- |
| Fetch fails or the snapshot is stale | Keep the last reading with its timestamp and “Stale”; avoid presenting it as current advice. |
| Selected row absent or `no_accounts` | “No active accounts for this workload”; do not borrow another class's row. |
| `unknown`, `other`, or unrecognized outcome | “Forecast unavailable”; do not infer zero capacity or ample capacity. |
| `out_now` | “Available modeled capacity exhausted”; show unreadable-account caveats if present. |
| `projectionBasis: structural` | “Early / structural estimate”; use a subdued or cautionary forecast, without a precise consumption cut or “cut hard”. |
| Projection basis null, `other`, or unrecognized | “Evidence unavailable”; withhold prescriptive pace advice. |
| `measured`, finite headroom, direction `margin` | “N% pace margin” for the displayed interval. |
| `measured`, finite headroom, direction `deficit` | “Reduce pace by N%” for the displayed interval, under the sustained-burn assumption. |
| `measured`, headroom null, `beyond_horizon` | “Projected to reach next reset” (or the stated long-term horizon); “Pace margin unavailable”. |
| `measured`, headroom null, `runway` | “May exhaust before next reset”; show `exhaustsAt`, with “Required cut unavailable”. |

The final two rules deliberately avoid treating null as proof of either huge
spare capacity or a need for a severe cut. Probe limits, modelled credits, and
missing evidence can all prevent a number being stated. Never coerce null to
zero, and never show a signed number without checking `headroomDirection`.

`structural` is broader than “recently reset”. It also covers estimates without
sufficient observation evidence, including scoped family estimates. The server
now caps confidence for ordinary window starts and usable burn anchors with
less than one hour of evidence, including the regression path. An hour passing
does not guarantee that every forecast becomes measured. Use the server's
classification rather than a widget-side one-hour timer.

`measured` does not guarantee complete coverage. Show `unreadableAccounts` when
nonzero, alongside `eligibleAccounts`. An exhaustion time derived while some
accounts are unreadable is a lower bound on runway, not a complete account-pool
forecast. `spentAccounts` is existing row-level context; it is not a new
next-reset-specific count.

## Paused accounts and banked resets

The server excludes paused accounts from workload forecasts and pacing counts.
An account can remain visible on `/public/v1/accounts` with its old readings
while contributing no runway or constraint. If the widget builds its own active
account list, exclude entries with `availability.state: "paused"` on the public
accounts resource (there is no top-level public `paused` boolean). Prefer the
server forecasts to recomputing
pace by averaging account percentages: a small Pro account and a much larger
account do not carry the same capacity.

Banked resets are finite extra capacity. The server models them only when the
corresponding automation and usable credit metadata permit it. Do not manually
add a week, 100 percentage points, or a fixed token allowance for each credit
on top of the returned forecast; that would count the same credit twice.

Manual pauses (including legacy pauses with no reason) stop weekly-exhaustion
redemption. Expiry protection remains enabled on paused accounts when its
separate opt-in is on; accounts needing reauthentication are excluded from both
triggers. Other automatic pause reasons are not a universal reset-automation
stop. This is separate from forecasting: all paused accounts are excluded from
runway and pacing even when expiry protection remains active.

The exhaustion-triggered path conserves a banked reset when another eligible
Codex account can serve the request. A displayed bank balance is therefore not
a promise of an immediate reset or of another full week of sustainable
consumption.

## Compatibility and freshness

1. Accept unknown object fields. `nextReset` adds one nested object inside a
   workload row; it adds no arrays. Update fixed token/depth budgets if the
   widget uses a constrained JSON parser.
2. If `nextReset` is absent or null, show “Next-reset forecast unavailable”.
   The existing row can still appear as explicitly labelled long-term context,
   using its own evidence and coverage checks.
3. If its deadline has passed, stop using that object as a future forecast and
   request an updated snapshot. Do not move its deadline forward locally or
   convert a negative countdown to a new weekly window.
4. Keep enum fallbacks neutral. Validate dates and finite percentages. Derive
   countdowns in the user's local time from ISO instants.
5. Use bounded retry/backoff after network failures. A suggested widget policy
   is to mark snapshots older than three minutes stale; this is a client UX
   policy, not a new server freshness guarantee.

## Acceptance cases for widget maintainers

| Input/scenario | Expected behavior |
| --- | --- |
| Active Codex account plus a paused small Codex account | Only active capacity drives the headline; paused account may remain in the detail list. |
| Next reset clears but the 14-day projection needs a cut | Primary card shows next-reset room; secondary card states the long-term adjustment and interval. |
| Young weekly window, 2% used after ten minutes | Structural/early forecast; no confident “cut hard” message. |
| `headroomPct: null` with either `runway` or `beyond_horizon` | No zero substitution, no automatic extreme bar position. |
| Two banked resets already modelled | No extra widget-side credit arithmetic. |
| Unreadable account alongside readable accounts | Show incomplete coverage; do not promise full-pool certainty. |
| Older server without `nextReset` | Widget remains functional and labels existing guidance as long-term. |
| Deadline passes between polls | Mark next-reset forecast expired and refresh; no inferred recovery. |
| Unknown enum or network failure | Neutral/unavailable or timestamped stale display; no crash. |

## Server references

- Wire contract and serializer: `packages/http-api/src/handlers/public/dto.ts`
  (`PublicWorkloadHeadroomRowDto`).
- Pinned response examples and parser depth checks:
  `packages/http-api/src/handlers/public/__tests__/dto.test.ts`.
- Forecast construction: `packages/core/src/workload-headroom.ts`.
- Next-reset and paused-account regression cases:
  `packages/core/src/__tests__/workload-headroom.test.ts`.
- Confidence rules: `packages/core/src/capacity-runway.ts`.
- Memoization: `packages/http-api/src/services/public-workload-headroom.ts`.
