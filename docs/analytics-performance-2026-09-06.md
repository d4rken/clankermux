# Analytics query performance, 6 September 2026

Implemented two query changes without schema changes: totals aggregate the filtered requests once, and tool-error queries for windows of 24 hours or less drive their joins from the request timestamp range. The 7-day, 30-day, and all-time tool queries retain SQLite's choice of join order, including when filters are present. Filters, aggregates, ranking/limits, response fields, and NULL behavior remain the same.

## Evidence and measurements

Inspected `/home/darken/.config/clankermux/clankermux.db` through Bun SQLite 3.53.2 with `readonly: true`, `query_only=ON`, and a 100 ms busy timeout. No production migrations, ANALYZE, checkpoints, writes, or service actions were performed. No full database copy or all-time production query was needed.

Captured the handler's actual SQL/binds and `EXPLAIN QUERY PLAN` for `range=24h&sections=totals,routing,toolCallErrors`. The range contained approximately 18,988 requests. Compared the original and replacement statements twice, using the same captured cutoff and a short read transaction around each pair to keep its rows stable. Every pair produced identical JSON rows, including order and floating-point values.

| Query | Before, ms (two runs) | After, ms (two runs) | Plan change |
| --- | --- | --- | --- |
| Totals | 136, 128 | 33, 32 | 18 request range scans → one |
| Tool totals | 2,118, 4,854 | 439, 263 | Full tool-call scan → request range plus tool request-ID probes |
| Tool timeline, including top-tools CTE | 12,303, 12,287 | 713, 655 | Two full tool-call scans → request range joins |
| Top error messages | 183, 195 | 66, 51 | Full error-table scan → request range plus error request-ID probes |

The totals plan previously selected covering indexes for most metrics but performed four separate request-table range scans for project-attribution counters. A single aggregate needs one table range scan. It preserves `COUNT=0` versus `SUM/AVG=NULL` on empty results and keeps the existing bind order through the filtered CTE.

Tool queries previously chose `SCAN tc` / `SCAN te`, followed by request-ID/timestamp probes. The production statistics estimated 740,116 request rows, 89,111 tool-call rows, and 3,974 error rows. The bounded `CROSS JOIN` gives the timestamp range priority and uses existing tool request-ID indexes. The timeline may still build a Bloom filter; no index was added.

Routing's four queries measured 485, 194, 257, and 203 ms during the initial pass. Their plans already used request timestamp range scans, primary-key routing lookups, and account lookups. No routing rewrite was justified by this inspection.

Timings vary with live traffic and OS/SQLite caches: the initial pass measured totals at 223 ms and the tool timeline at 3,006 ms, while the subsequent paired baseline timeline reached 12.3 s. These are bounded local comparisons, not production endpoint latency or a controlled load benchmark. A subsequent bounded 30-day check found a regression for pinned top error messages; see the review follow-up below.

Local reproduction artifacts from this session:

- `/tmp/clankermux-analytics-baseline-queries.json`: captured original SQL, binds, timings, and plans.
- `/tmp/clankermux-profile-analytics.ts`: initial read-only profile.
- `/tmp/clankermux-compare-analytics.ts`: original/replacement comparisons.
- `/tmp/clankermux-analytics-direct-before-latency.ts`: pre-change handler source.

## Review N4: wide-range comparison and final policy

A bounded read-only comparison of the top-error-messages query over 30 days covered 345,528 requests. It used the same production connection safeguards above, a fixed cutoff, and a read transaction around each pair. The entire probe had a 20-second process deadline and completed in under two seconds of query time. It did not run the full dashboard handler or any all-time query.

| Execution order | Original planner choice, ms | Request-first pin, ms |
| --- | --- | --- |
| Original, then pinned | 138 | 949 |
| Pinned, then original | 99 | 294 |

Both pairs returned identical JSON rows. The original plan scanned the smaller error table and probed the existing request-ID/timestamp covering index. The pin instead visited the 345k-request timestamp range and probed error rows. Reversing execution order retained the regression, despite the cache effect on absolute timings.

Final policy: tool queries pin request-first only when the configured window is at most 24 hours. This retains the demonstrated 24h improvements and applies to its narrower 1h/6h subsets. The 7d, 30d, and all-time views leave planning to SQLite, even with filters. This is a conservative boundary at the measured beneficial range, not a claim that time alone guarantees selectivity. It adds no count queries, dynamic thresholds, or indexes. The tradeoff is forgoing possible improvements in selective wide-range views until they are measured; it avoids extending the pin to unmeasured 7d views or the demonstrated 30d regression. Active-session policy and the totals rewrite are unchanged.

Only top error messages were benchmarked at 30d: their regression is enough to reject a blanket wide-range policy. Wide-range tool totals and timeline remain unmeasured. Artifacts: `/tmp/clankermux-analytics-wide-range-review.ts` and `/tmp/clankermux-analytics-wide-range-review.log`.

## Validation and unresolved symptoms

Initial validation passed 140 analytics tests across 16 files and the workspace TypeScript check. After N4, the targeted plan, tool-error, and golden-response suites passed 53 tests across three files; the workspace TypeScript check, targeted lint, and whitespace checks passed. The new query-plan tests reproduce production cardinality estimates in an in-memory fixture, assert a single totals scan, and assert indexed request-first tool joins for the 1h, 6h, and 24h ranges. They also assert that 7d, 30d, and all-time queries remain unpinned with and without filters, and verify combined-filter tool results across all four policies/ranges. Behavioral checks cover empty/NULL totals, NULL accounts, combined filters, tool totals/buckets/messages, and the existing unscoped golden response. Existing tests cover all-time results, ranking limits, cache/speed metrics, costs, and project attribution.

The dashboard worker already runs synchronous SQLite reads off the main thread, closes its connection after each response, and does not open an explicit transaction around the whole handler. This inspection did not establish the cause of the 10.2 s metadata jobs, 2.9 s main-thread stalls, 415.5 MiB WAL peak, or SQLITE_BUSY retries. Shorter analytics statements reduce how long those statements retain read snapshots, but that is not evidence these changes resolve those other symptoms. The async writer is outside this change's ownership.

No unresolved implementation decision requires coordination. Deployment and production follow-up remain with the coordinator.
