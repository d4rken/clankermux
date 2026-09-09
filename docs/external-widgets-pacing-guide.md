# Widget handover: replacement public API

This replaces the earlier pacing integration. The route prefix remains
`/public/v1`; the former pacing, runway and workload-headroom resources are
removed. Update consumers together with the server deployment.

1. Poll `/workloads`. Select `class:anthropic`, `class:codex`, or `family:fable`.
2. Render `weekly.outcome` with `weekly.quality`, `weekly.reason` and
   `weekly.coverage`. Coverage is explicit; never reconstruct it from accounts.
3. Interpret `weekly.pace.state` before the signed `changePct`. Estimates,
   reached search limits and unavailable results mean different things.
4. Show `availability.availableAccounts` independently. Five-hour learning
   does not exclude useful weekly evidence. Family availability can differ
   from its parent class; the pools overlap.
5. Open `/accounts` for per-window usage and the single `forecast` object.
   `prediction`, the overall utilization gauge and the default-candidate flag
   are removed. Window forecast outcomes already compare exhaustion to reset.
6. Use `/status` for service readiness, `/stops` for block history, and
   `/stream` for request activity. There is no public burn ratio or combined
   headroom headline.

Availability and weekly forecasts have separate computation timestamps. The
weekly period ends at the next known weekly reset, not after it and not after a
full week. Stop using advice when its deadline passes or evidence becomes stale.

A small display can show “Claude · weekly risk · 5/5 modeled” and “5 available
now.” Add “estimated pace -25%” only for a supported estimate with full coverage.
For `reduction_limit`, say “tested cut insufficient”; for `increase_limit`, say
“tested increase fits.” Never render either limit as an exact recommendation.

Read the [API reference](public-api/README.md) for field semantics, model
assumptions, all endpoint schemas, complete examples and SSE behavior. The model
holds per-account burn fixed; it does not guarantee agent counts or uninterrupted
execution after demand shifts between accounts.
