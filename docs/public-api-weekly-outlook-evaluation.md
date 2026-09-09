# Weekly-only quota outlook: bounded evaluation

Historical document. The replacement contract is documented in [the public API reference](public-api/README.md).

Evaluated on 2026-09-09 at **12:36:38.782 UTC**, using five active Anthropic
accounts' recent persisted observations. This is an offline evaluation, not a
new public forecast mode or a deployment recommendation.

**Result:** removing the five-hour constraint increases modeled weekly coverage
from 3/5 to 5/5. On this snapshot, the Claude class produces a 49% weekly-only
deficit. Fable still has no numeric adjustment because its scoped evidence and
constraints remain limiting. This supports a separate budgeting view worth
evaluating further; it does not justify replacing the combined headline.

## Evidence and method

The database was opened with the existing `openReadOnlyDatabase` helper, which
uses SQLite's read-only mode. Queries selected active Anthropic account IDs and
recent quota snapshots only; no names, credentials or request bodies were
selected. No provider requests, live cache changes or database writes occurred.

Account-wide and scoped snapshots were resolved with the existing
`loadRecentSnapshotObservations`, `snapshotWithin` and `projectableWindows`
helpers. The lookup covered ten minutes. All five winning observations were
approximately 68–103 seconds old. Scoped readings were paired with account-wide
readings on their sampler tick; the actual `observed_at` timestamps were kept.

Both calculations used `computeWorkloadHeadroom` at the same frozen clock and
its existing canonical account/family input builders. The alternative removed
only `windowObservations.fiveHour`; account-wide weekly and scoped family
windows, reset times, observation times and account eligibility were retained.
Coverage was recalculated from these inputs, rather than copied from the
combined forecast. A check confirms no five-hour input survives the filter.

The process-local regression predictions and revision anchors were unavailable
to this offline reader. They were explicitly null, as in a snapshot-only
fallback; no slope or anchor was inferred from rounded public payloads. This
means the results do **not** reproduce the live server's exact cache-backed
forecast. In particular, this combined class forecast has structural evidence,
whereas the live class forecast inspected during the investigation was measured.
The zero-reading exclusion still applies even to a confident flat regression,
so that difference does not explain away the observed coverage problem.

## Captured readings

Rows are anonymous and carry no production account identifiers.

| Account | Five-hour use | Weekly use | Fable weekly use |
| --- | ---: | ---: | ---: |
| A | 42% | 57% | 95% |
| B | 1% | 56% | 100% |
| C | 0% | 38% | 48% |
| D | 34% | 78% | 100% |
| E | 0% | 58% | 100% |

Accounts C and E have usable nonzero weekly readings but are excluded from the
combined pool because their five-hour readings are zero. Filtering five-hour
windows recovers these two accounts for the conditional weekly calculation.

## Results

The next-reset interval ends at **2026-09-13 07:00:00.204 UTC**. The long
interval is 14 days. In this snapshot, each row's exhaustion instant is the same
over both intervals; every exhaustion below occurs before the next weekly reset.

| Workload and constraint set | Modeled coverage | Projected exhaustion, UTC | Long-horizon headroom | Next-reset headroom |
| --- | --- | --- | --- | --- |
| Claude, combined windows | 3/5; two learning | Sep 11, 07:29:07 | Null: beyond probe range | Null: structural evidence |
| Claude, weekly only | 5/5; none learning | Sep 11, 11:21:53 | 49% deficit; measured | 49% deficit; measured |
| Fable, combined windows | 3/5; two learning | Sep 9, 14:22:47 | Null: beyond probe range | Null: structural evidence |
| Fable, weekly only | 5/5; none learning | Sep 10, 18:31:20 | Null: beyond probe range | Null: structural evidence |

The class percentage is near the existing 50% maximum tested reduction. It is
an outcome of this frozen snapshot, not evidence that the current live pool
requires exactly this change. Three Fable scoped windows are already spent;
recovering five-hour-idle accounts does not remove those scoped constraints or
give the remaining scoped estimates measured confidence.

## Decision and limits

Keep weekly-only headroom as a separate evaluation in this implementation.
Ship the per-window explanations and qualified probe information independently.
They make useful weekly evidence visible without changing the forecast's
constraint set or meaning.

A later weekly-budget view would answer: **“What happens to these weekly quotas
if each account continues its measured weekly burn, with five-hour limits
excluded?”** Its scope must be visible. The current model holds each account's
burn fixed; it does not redistribute a spent account's demand to survivors.
Consequently, a longer modeled runway or complete weekly coverage is not a
guarantee that the same workload can run continuously or accept more agents.
Retain the combined forecast and immediate availability indicators separately.

Before publishing that view, compare it with the full live scan inputs,
including anchors, across additional observations and reset transitions. Also
cover zero/missing weekly readings and scoped-family learning: weekly-only
filtering must not promise complete coverage when the weekly evidence itself is
absent. Do not adopt the experimental redistribution model for Fable; its input
contract supports account-wide windows only.

## Reproduction

The [offline script](../scripts/public-api/evaluate-weekly-outlook.ts) contains
the frozen anonymized readings, exact observation/reset timestamps and frozen
clock. It performs no database or network I/O:

```sh
bun scripts/public-api/evaluate-weekly-outlook.ts
```

The script calls the production core functions, checks the 3-to-5 class coverage
change and prints both intervals. It is development tooling, not a new runtime
forecast. The original data was read from persisted snapshots; the frozen
fixture is not a current live-account feed.
