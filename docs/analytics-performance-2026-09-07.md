# Account-performance query measurements, 7 September 2026

The recurring dashboard warnings consist of `totals`, `burn_rate`, and
`additional_data`. That phase set matches the Usage page's `LIMITS_SECTIONS`
(`totals,accountPerformance`); its default range is seven days. The production
warnings did not include the URL, so this identifies a matching request shape,
not proof of which browser tab generated each warning.

A read-only invocation of the real handler with
`range=7d&sections=totals,accountPerformance` covered 138,770 requests. It measured
392 ms for totals, 148 ms for burn rate, and 343 ms for account performance.
The first totals read was slower than the recurring production observations
(roughly 224–230 ms). These are separate-process SQL timings, not endpoint
latency measurements.

## Change

Aggregate requests by `account_used` before joining the current account name.
The original query joined the accounts table once per request and grouped by
both account ID and account name. Since account IDs are unique, the name lookup
can happen after aggregation without changing the groups. Missing account rows
still fall back to the stored account ID, and NULL account IDs retain the
no-account sentinel. Separate accounts sharing a name remain separate rows.

The query keeps its filter predicates inside the request aggregation, its
SELECT-first sentinel bind, `COUNT(id)`, success/cost/NULL semantics, descending
request-count ordering, and top-ten limit. There are no schema changes, index
hints, cache additions, or new concurrency mechanisms.

The captured seven-day plan changed from a request scan plus per-request account
lookup and a temporary grouping B-tree to a grouped request coroutine followed
by account lookups. Both plans use `idx_requests_account_timestamp` for the
request scan; the outer top-ten sort remains.

## Bounded comparisons

Used Bun SQLite on the production database with `readonly: true`,
`PRAGMA query_only=ON`, and `busy_timeout=100`. Each comparison pair used a fixed
cutoff and a short read transaction for identical rows. Reversed execution order
for the second pair. Each profiling process had a 20-second external deadline.
No production writes, migrations, ANALYZE, checkpoint, database copy, or service
action was performed. No all-time production query was run.

| Range/filter | Before, ms (two runs) | After, ms (two runs) |
| --- | --- | --- |
| 1h | 4.4, 3.0 | 1.0, 0.9 |
| 24h | 35.4, 32.7 | 22.6, 24.7 |
| 7d | 343.7, 330.4 | 213.0, 211.5 |
| 30d | 860.1, 800.2 | 592.6, 555.7 |
| 7d, one account | 44.0, 44.2 | 28.9, 28.4 |

Every pair returned deeply equal rows, including row order and floating-point
values. The seven-day account-performance phase improved by 36–38%. This does
not establish the same percentage improvement for the full endpoint: totals
and burn rate are unchanged, and live traffic/caches affect timing.

Artifacts from this session:

- `/tmp/profile-analytics-followup.ts` and `/tmp/analytics-followup-queries.json`:
  real-handler SQL, bindings, plans, and initial timings.
- `/tmp/compare-analytics-followup.ts` and
  `/tmp/analytics-followup-account-candidate.json`: paired seven-day comparison.
- `/tmp/compare-analytics-followup-ranges.ts` and
  `/tmp/analytics-followup-range-measurements.json`: narrow, wide, and filtered
  comparisons.

## Validation and limits

The focused analytics and SSE suites pass 166 tests across 17 files. The new
account tests check aggregation before the account join and cover all six
supported ranges, shared account names, missing and NULL accounts, mixed/NULL
billing, NULL costs, model/project/account/status filters, and empty results.
The existing unscoped golden response and section-bind tests continue to pass.

The accompanying SSE cleanup hands each extracted frame directly to its parser,
removing the duplicate delimiter split. LF/CRLF tests verify that an undelimited
final `message_delta` contributes its output-token count during flush; existing
fragmentation, multiline, Unicode, terminal, and payload-free diagnostic tests
remain in place.

This work does not establish the cause of startup event-loop stalls, guarantee
cache reuse improvements, or benchmark the revised production endpoint. The
revised production endpoint requires a separate promotion and observation window.

The workspace build, lint, and TypeScript checks passed. Claude Fable 5.1
reviewed both changes and found only a stale parser-name comment, which was
corrected. It found no behavioral issues.
