# Handover: showing PACE instead of RUNWAY on the usage widget

For whoever is changing the desk widget. It currently renders the quota runway
("when does the pool run dry"). The goal is to render **pace** instead: at a
glance, should I run more agents right now or fewer.

Everything below is live on the ClankerMux proxy as of 2026-09-04. No auth, no
credential: `/public/v1/*` is a read-only unauthenticated mount.

---

## 1. The one thing to get right

**The pace headline is NOT on `/public/v1/pacing`.** It is on
`/public/v1/runway`, which the widget already fetches.

That looks backwards, so here is why: the figure lives where it is computed.
The pool-level pace headroom comes out of the runway scan, and the wire contract
forbids publishing one measurement in two places. So:

| Question | Endpoint | Field |
|---|---|---|
| Add load or shed it? (the headline) | `/public/v1/runway` | `worstStatedOutcome.headroomPct` + `.headroomDirection` |
| Which class, and how is it spending? | `/public/v1/pacing` | `classes[]` |

If you only change one thing, change the runway panel to render
`headroomPct`/`headroomDirection` instead of `exhaustsAt`. You do not need the
pacing endpoint at all for a working v1.

---

## 2. Why pace and not runway

They answer different questions and routinely disagree — correctly.

The runway asks *when does quota run out*. The pool has several accounts with
staggered reset times and requests fail over between them, so the pool survives
long after any individual account fills up. On a normal day the runway reads
`∞` while every single account is projected to hit 100% before its own reset.
Both true. The runway is therefore a poor "should I slow down" signal: it is
binary and it is usually `∞`.

The **pace headroom** asks *how much more (or less) load can this pool take*. It
is a counterfactual: the server re-runs the whole runway scan at perturbed burn
rates and reports where the verdict flips. That is the number that maps onto
"run more agents / run fewer".

---

## 3. The headline field

```jsonc
// GET /public/v1/runway
{
  "schema": "clankermux.public.runway.v1",
  "generatedAt": "2026-09-04T09:13:55.251Z",
  "horizonMs": 1209600000,
  "coverage": { "activeKeyCount": 11, "statedKeyCount": 11, "unobservedKeyCount": 0 },
  "worstStatedOutcome": {
    "kind": "beyond_horizon",
    "exhaustsAt": null,
    "causes": [],
    "earliestExhaustsAt": null,
    "latestExhaustsAt": null,
    "headroomPct": 31,            // <-- the bar
    "headroomDirection": "margin" // <-- the sign
  }
}
```

`headroomDirection` is a closed enum: `"margin" | "deficit" | "other"`.

- **`margin`** — you have room. `headroomPct: 31` means the pool would have to
  burn 31% faster before it started running out inside the horizon.
- **`deficit`** — you are over. `headroomPct: 40` means **cut by at least 40%**.
  This is a genuine threshold, not a sample: the server verified that pace and
  every slower probed pace also clears. You can safely cut more.

**The sign lives in the enum, not in the number.** `headroomPct` is always
positive. A client that renders the number and ignores the direction will show a
required 40% cut as 40% of spare capacity. Do not do that.

### Null is not zero, and it means opposite things

`headroomPct` and `headroomDirection` are both `null` when no figure can be
stated. **Which end of the scale that is depends on `kind`:**

| `kind` | headroom null means | Render as |
|---|---|---|
| `beyond_horizon` | **Good.** Robust past the +50% probe cap. | Bar pegged full right, or "plenty" |
| `runway` | **Bad.** No slowdown down to −50% reliably clears. | Bar pegged full left, or "cut hard" |
| `out_now` | Out of quota now. No projection to vary. | "Out" |
| `unknown` / `no_accounts` | Nothing measured. | Blank / "no reading" |

You must read `kind` alongside. Rendering either null as a zero-width bar or a
"0%" says the pool is exactly on the edge, which is wrong in both directions.

---

## 4. Per-class context (optional, `/public/v1/pacing`)

One record array, `classes[]`, nothing nested inside it. Live sample:

```jsonc
{
  "schema": "clankermux.public.pacing.v1",
  "generatedAt": "2026-09-04T09:13:50.239Z",
  "bindingClassId": "codex",        // the class that constrains you first
  "fiveHourOutlookTone": "neutral", // pool-wide 5-hour verdict
  "classes": [
    {
      "classId": "codex",
      "label": "GPT",
      "utilizationPct": 64,          // the class's LEAST-USED account
      "leastUsedAccountId": "1cae47ec-…",
      "burnRatio": 1.06,             // 1.0 = exactly on pace
      "burnTone": "warning",
      "outlookTone": "warning",
      "reportingCount": 1,
      "eligibleTotal": 1,
      "willRunOut": 1,
      "alreadySpent": 0,
      "resetsAt": "2026-09-07T04:10:06.000Z",
      "resetsAtAccountId": "1cae47ec-…",
      "singlePointOfFailure": true,  // one account, no failover
      "fiveHourRoom": 0,
      "fiveHourRunningHot": 0,
      "fiveHourWaiting": 0,
      "fiveHourUnavailable": 0,
      "fiveHourUnknown": 1,
      "fiveHourUnread": true,        // see below
      "nextLiftAt": null,
      "nextLiftAccountId": null
    }
  ]
}
```

Things that will bite:

- **`burnRatio` is per-account, not pool-level.** It describes the class's
  least-used account. It will disagree with the headline headroom and that is
  not a bug — on the live pool right now Claude reads `1.09` ("slightly over")
  while the pool headroom reads `+31%` ("room to spare"). The headroom is the
  one that answers the agent-count question; the burn ratio is context.
- **`burnRatio: null`** means the server declined to state one — usually a
  window too young to divide by. Do not substitute `1.0`; that reads as
  "perfectly on pace", the most reassuring possible answer from the least
  reliable input.
- **`fiveHourUnread: true`** means that class has *no 5-hour reading at all*
  (Codex/GPT never reports one — this is permanent, not an error). Rendering it
  as `fiveHourRoom: 0` = "no capacity" is wrong: zero-with-room is a measured
  absence of capacity, this is an absent measurement.
- **Account references are IDs only.** Names live on `/public/v1/accounts`;
  join on `leastUsedAccountId` / `resetsAtAccountId` / `nextLiftAccountId` if
  you want to display one.
- **Tones** (`burnTone`, `outlookTone`, `fiveHourOutlookTone`) are closed enums:
  `neutral | success | warning | destructive | other`. They are published rather
  than left to you because the thresholds behind them are policy and would drift
  if re-derived. Handle `other` — it is the forward-compat escape hatch.

---

## 5. Suggested bar

A centred bar with zero in the middle:

```
   cut  ←────────────┼────────────→  add
        -50%         0         +50%
```

- `direction: "margin"` → fill right, width ∝ `headroomPct`
- `direction: "deficit"` → fill left, width ∝ `headroomPct`
- null + `beyond_horizon` → pegged full right
- null + `runway` → pegged full left
- null + `out_now` → full left, distinct colour

**Treat it as a three-state signal, not a dial.** The figure is a counterfactual
at 1% grid resolution, and it moves for reasons that are not you changing
behaviour: an idle overnight stretch shifts measured pace by more than the whole
margin. It went from `+23%` to `+31%` over four hours of lighter use this
morning. Green / amber / red on wide bands will age better than a precise
readout.

---

## 6. Polling

- `/public/v1/pacing` is memoised server-side with a **60 s TTL** and
  single-flight. Polling faster than 60 s returns the identical payload (same
  `generatedAt`) and gains nothing.
- `/public/v1/runway` is not memoised but is an expensive scan. 60 s is a
  sensible floor for both.
- Both send `Cache-Control: no-store`.
- Both are GET-only; anything else gets a 405.
- Schema ids are pinned per resource. Adding a field never changes them; a
  removal or a semantic change would ship as `/public/v2`. Refuse a schema id
  you do not recognise.

---

## 7. What not to build

Do **not** recompute the burn ratio client-side from `/public/v1/accounts`. It
looks like simple arithmetic (`utilizationPct` over elapsed window) and it is
not: window duration varies by provider and some report their own per reading,
accounts have to be grouped into servable classes (a Claude request cannot be
served by a GPT account), there is a guard that withholds the ratio when the
window is too young to divide by, and the tone thresholds are policy. All of
that lives in `@clankermux/core` and is served precisely so no client has to
reimplement it. Four separate ways to get it subtly wrong.

---

## Source pointers (ClankerMux repo)

- Wire contract and all DTO mapping: `packages/http-api/src/handlers/public/dto.ts`
  (the header comment is the normative contract)
- Pace probes: `packages/core/src/capacity-runway.ts` — `probePaceMargin`,
  `probePaceDeficit`, `runwayPaceHeadroom`
- Pacing scan: `packages/core/src/pacing-scan.ts`
- Public readers: `packages/http-api/src/services/public-{runway,pacing}.ts`
- Wire guards (extend these if you request a field): 
  `packages/http-api/src/handlers/public/__tests__/dto.test.ts`
