# Public API consumer improvements: implementation plan

Historical document. The replacement contract is documented in [the public API reference](public-api/README.md).

Status: implemented and reviewed with a partner agent. The sections below record the agreed design and acceptance criteria.

## Objective and scope

Make public quota forecasts understandable to small displays without requiring each consumer to reconstruct planning intervals, missing-data policy or workload advice.

Implement four additive improvements: explicit interval semantics, next-reset absence reasons, server-derived advisory states, and published JSON Schema with validated examples. Preserve all existing `/public/v1/*` paths, schema identifiers, field values and calculation semantics. No new endpoint, database migration, provider request, deployment or widget implementation is needed for this change.

## 1. Explicit planning intervals

Add `intervalKind: "fixed_horizon"` to the `/workload-headroom` and `/runway` envelopes. Add `intervalKind: "until_next_weekly_reset"` inside each non-null workload `nextReset` object. Both descriptive enums include an `other` fallback.

Keep timestamps in their canonical locations rather than repeating them in each row:

| Interval | Start | End |
| --- | --- | --- |
| Workload row's long-horizon fields / runway headline | Envelope `generatedAt` | `generatedAt + horizonMs` |
| Workload `nextReset` fields | Envelope `generatedAt` | `nextReset.resetsAt` |

Document this mapping beside the fields in the DTO, schemas and consumer guide. `nextReset` means **until** the earliest usable future weekly deadline among the workload scan inputs, never after it. Deadline selection precedes learning/readability exclusions, so do not claim only successfully projected accounts determine it. Keep `nextReset: null` when there is no usable deadline; do not manufacture an interval or rename existing fields.

The first version deliberately adds an interval discriminator rather than duplicating `startsAt`/`endsAt` measurements. A derived end timestamp is unnecessary for this change.

## 2. Explain absent next-reset headroom

Extend core `NextResetGuidance` to retain the reason its headroom is absent, and serialize it as `nextReset.headroomAbsence`. Define a separate public next-reset absence enum so existing closed enums keep their meanings and values:

| Value | Meaning |
| --- | --- |
| `learning_accounts` | The forecast cannot be established yet because burn evidence is still being learned. |
| `structural_evidence` | The numeric next-reset figure was withheld by the existing measured-evidence gate. |
| `bound_broken_by_credits` | Modelled credits prevent a valid family bound. |
| `beyond_probe_range` | A valid probe ran but did not find a threshold within its range. |
| `not_projected` | No numeric adjustment can be derived from this outcome. |
| `other` | A future/unrecognized reason. |

The field is null exactly when a numeric next-reset headroom is present. Compute the reason in core where the evidence and probe result are available; do not infer it in the DTO from the long-horizon row.

Precedence when several limitations coexist: unknown outcome with learning accounts gives `learning_accounts`; other unknown, exhausted or no-account outcomes give `not_projected`; credits invalidating a family bound give `bound_broken_by_credits`; structural evidence withholding gives `structural_evidence`; otherwise a projected outcome without a threshold gives `beyond_probe_range`. Unknown internal cases map to `other`. The selected reason explains one barrier to numeric advice, not every possible issue. `learning_accounts` can coexist with missing evidence and does not by itself authorize the `learning` guidance state below. Preserve existing long-horizon `headroomAbsence` unchanged.

When the entire `nextReset` object is null, its absence already means no usable weekly deadline. Document this directly rather than adding another redundant row-level field. Older servers may omit `nextReset` altogether.

## 3. Server-derived advisory state

Add a scalar `guidanceState` to each workload row and each non-null `nextReset` object. The row state uses the long horizon; the nested state uses only the next-reset interval. Do not add this state to `/pacing` or derive it from `burnRatio`.

Use one pure classifier with this ordered policy:

| Condition | State |
| --- | --- |
| Unrecognized outcome or inconsistent inputs | `other` |
| Explicit `no_accounts` outcome | `no_accounts` |
| Unknown outcome explained entirely by still-learning accounts | `learning` |
| Other unknown outcome | `unknown` |
| Forecast omits eligible accounts, or projection evidence is structural/missing | `uncertain` |
| Fully covered, measured `out_now` outcome | `exhausted` |
| Fully covered, measured, finite positive headroom with `margin` | `increase` |
| Fully covered, measured, finite positive headroom with `deficit` | `reduce` |
| Fully covered, measured forecast with no numeric adjustment | `unquantified` |

Use all-listed-account evidence before labelling an unknown result `learning`; a mixture of unreadable and learning accounts must not promise that time alone will resolve it.

For `unquantified`, use the existing `outcomeKind` to distinguish reaching the interval end (`beyond_horizon`) from projected exhaustion (`runway`). Neither implies unlimited capacity or a recommendation for an extreme reduction. `uncertain` tells compact consumers to withhold prescriptive advice while larger consumers can show qualified raw forecasts.

Coverage must account for every eligible account, including rejected/unopened family accounts that never enter the next-reset scan. Current pool eligibility/readability is horizon-independent, so reuse the assembled row coverage for both intervals and add tests proving excluded account IDs agree across the two scans. Do not derive complete coverage solely from `nextReset.outcome` or double-subtract unopened accounts. Carry the actual missing/learning evidence into the classifier, rather than assuming a measured outcome proves complete coverage. Existing public counts retain their existing semantics. If implementation reveals a horizon-dependent exclusion, resolve that distinction before sharing its coverage with guidance.

Keep `headroomPct`, `headroomDirection` and `headroomBasis` as the canonical numeric/bound facts; do not duplicate them inside an advice object. Family bounds remain qualified even when direction is stated. Class/family IDs remain `class/anthropic`, `class/codex`, `family/fable`; absent family rows mean no forecast, not unlimited capacity.

These states are advisory and describe the snapshot at `generatedAt`. Clients still own freshness, expired-deadline handling, localization and presentation. No server `stale` state or automatic concurrency target will be introduced.

### Limits that must be explicit

- The current margin probe returns the first failing 1% grid step. An existing margin is an approximate threshold, not a tested-safe instruction to increase by exactly that percentage. Preserve the numbers and correct comments that claim otherwise.
- `projectionBasis` characterizes the baseline outcome's evidence; it is not a guarantee about every hypothetical probe. The measured gate is a minimum qualification, not a new accuracy promise.
- Guidance describes quota, not guaranteed immediate routing availability or capacity for a pinned API key. Retain `/pacing`, `/accounts` and `/runway` as complementary signals.
- Safe automatic scaling, separate safe-adjustment values, probe-confidence redesign and new forecast algorithms are outside this increment.

## 4. Publish the public contract and examples

Publish one JSON Schema per resource under `docs/public-api/schemas/`: status, accounts, runway, stops, pacing, workload-headroom and stream events. Use JSON Schema Draft 2020-12. Link them and examples from a public API index and the README.

Generate schemas from the exported public DTO types using a development-only TypeScript schema generator, with a small reviewed manifest for entry types, resource identifiers and compatibility requirements. Do not generate schemas from internal account/request types. Keep schema validation and generation out of request handling.

The generator/manifest must pin resource `schema` strings to their actual constants, add date-time formats and count/range constraints that TypeScript alone cannot express, and recursively allow unknown object fields. Produce genuine Draft 2020-12 schemas through a compatible generator or tested conversion, not by relabelling a different dialect. Retain UTF-8 byte-limit assertions in producer tests: JSON Schema `maxLength` counts characters and cannot enforce the 96-byte display-string limit.

The schemas must describe ISO timestamps, nullable measurements, enums and resource schema identifiers. Consumers must accept unknown object fields. Additive fields introduced in this change are optional in the compatibility schema so existing v1 responses still validate; current-producer tests separately require the new fields. Track this optional-field list explicitly in the generator manifest.

The stream schema covers the public JSON event union. Document SSE framing, `connected`/`server-shutdown` control events and heartbeat comments separately; they are not JSON records. Error-response status/shape is also documented separately from successful resource schemas.

Use development-only schema validation (Ajv with date-time format support) to check real serialized DTO fixtures and committed examples. Add a reproducibility check so generated artifacts cannot drift from DTO changes. Keep producer privacy/allowlist tests strict even though consumer schemas allow unknown fields.

Examples should include every resource plus workload cases for measured margin/deficit, contradictory short/long horizons, learning, structural evidence, partial coverage, exhausted quota, null probe result, credits breaking a family bound, missing next-reset deadline and missing Fable row. Use invented data and explicitly identify abbreviated fragments versus complete payloads.

## Implementation sequence

1. **Core evidence and classification:** extend next-reset results with absence reasons and the evidence required for interval-specific guidance; add the pure classifier and focused behavioral tests. Preserve forecast/probe numbers.
2. **Public mapping:** add interval kinds, next-reset absence and guidance states through named-field serializers; update current-payload fixtures and public wire guards.
3. **Schemas and examples:** add the development tooling, seven generated schemas, validator/reproducibility scripts and current/legacy compatibility cases.
4. **Consumer documentation:** update the integration guide and small-display summary, add the API index, and make superseded handover sections clearly historical. Correct any conflicting safe-margin descriptions touched by this work.

## Validation and acceptance

- Core tests: `packages/core/src/__tests__/workload-headroom.test.ts`, focused classifier tests, and `packages/core/src/capacity-runway.test.ts` for preserved probe semantics.
- Public tests: `packages/http-api/src/handlers/public/__tests__/dto.test.ts`, `packages/http-api/src/services/__tests__/public-workload-headroom.test.ts`, and `packages/http-api/src/services/__tests__/workload-headroom-scan.test.ts`.
- Assert every legacy serialized field remains identical for the same inputs after removing only the newly added fields. Include class/family, credits, unknown, partial and contradictory-interval fixtures.
- Assert no numeric advisory direction is emitted for incomplete/weak evidence, no null-to-zero coercion occurs, and no long-horizon explanation is reused for a different interval.
- Extend enum fallback, ISO-instant/duration, privacy allowlist, string-limit, object-depth and array-depth guards. Additions introduce no arrays; keep the ESP32 parser limits.
- Validate examples and actual DTO output against schemas; validate a pre-change response against the compatibility schema and require new fields from the current producer. Regeneration must leave no diff.
- Run focused Bun tests, `bun run typecheck`, read-only Biome checks on touched source files, and `git diff --check`. Broaden testing only if shared changes warrant it.

## Rollout

Ship the server changes and contract artifacts together. Clients can first add support for optional metadata and guidance states while retaining existing raw-field support. After deployment, switch their headline to the server state when present; older servers remain readable. Verify representative live responses before changing widget headline behavior. Do not hardcode deployment status into timeless contract documentation.

No existing endpoint or field is removed, renamed or given new semantics, so this remains public v1. A future change to existing headroom meaning would require separate versioning consideration.
