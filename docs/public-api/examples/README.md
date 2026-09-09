# Public API example payloads

Every JSON file here is a **complete successful payload**, with invented names,
IDs and measurements. They illustrate the wire contract; separate scenario
files are not observations of the same account pool. Validate them with
`bun run public-api:check`.

The base files cover status, accounts, runway, stops and pacing. The five
`stream.*.json` files cover the JSON event variants, one event per file. SSE
control events and heartbeat comments are transport framing, not JSON payloads.

| Workload example | Interpretation |
| --- | --- |
| `workload-headroom.json` | Measured next-reset margin and a longer-horizon deficit coexist. |
| `workload-headroom.learning.json` | All accounts need more burn evidence; no numeric adjustment. |
| `workload-headroom.structural.json` | Weak projection evidence suppresses prescriptive advice. |
| `workload-headroom.partial-coverage.json` | Measured projections still omit eligible capacity. |
| `workload-headroom.exhausted.json` | Fully covered measured quota exhaustion now. |
| `workload-headroom.probe-limit.json` | No threshold within probe range: outcome distinguishes room from shortfall. |
| `workload-headroom.family-bound.json` | Raw conservative family deficit with uncertain guidance; structural evidence withholds the nested numeric adjustment. |
| `workload-headroom.family-credits.json` | Credits prevent a valid family headroom bound; weak next-reset evidence also makes guidance uncertain. |
| `workload-headroom.no-weekly-deadline.json` | No usable next-reset interval can be stated. |
| `workload-headroom.missing-fable.json` | A class row without a Fable row does not prove unlimited family capacity. |

`increase` and `reduce` are advisory states. Percentages describe approximate
thresholds at the existing probe resolution, not tested-safe automatic scaling
targets. `uncertain` suppresses directional advice while retaining raw forecast
fields for qualified detail. Null never means zero or unlimited capacity.

The family-bound example was produced by `computeWorkloadHeadroom` and the
public serializer from an invented Anthropic account: 70% weekly use, 80%
scoped Fable use, both resetting in two days, and 1% five-hour use resetting in
one hour. It includes the overlapping class and family rows. The structural
scoped estimate prevents a precise next-reset recommendation even when the
longer-horizon raw conservative bound is numeric.
