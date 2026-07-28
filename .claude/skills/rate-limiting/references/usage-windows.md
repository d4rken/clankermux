# Usage windows

## `GET /oauth/usage`

| Window | Meaning | Notes |
|---|---|---|
| `five_hour` | rolling 5h session | nullable: `null` = absent (Codex retired it), `{0,…}` = live at 0% |
| `seven_day` / `limits[weekly_all]` | **account-wide** weekly | the flat form wins when both exist |
| `seven_day_oauth_apps` | Claude Code's own weekly | NOT captured by the normalizer's `weeklyAll`; read separately |
| `limits[weekly_scoped]` | per model **family** | family gate + display only; never account-wide |
| `extra_usage` | overage / purchased credits | deliberately EXCLUDED from the account-wide figure |

**Representative utilization** = MAX across the account-wide windows.

> **Returns `null`, never `0`, when there is no evidence.** A `limits[]`-only
> payload once collapsed to `0` — read as "plenty of headroom" — and falsely
> cleared a cooldown. Any new consumer must preserve `null`-means-unknown.

## NEAR_LIMIT recovery ordering

Within the NEAR_LIMIT bucket the primary sort key is `recoveryDeadline`: when the
account STOPS being near-limit. A 5h-bound account recovers in hours and returns
to full HARVEST capacity; a weekly-bound one is out for days.

Three properties, each a correction from review — do not "simplify" them back:

1. **`max`, not weekly-first.** When BOTH axes bind, the constraint persists
   until the LATER reset.
2. **No `weeklyResetMs` fallback.** An unknown `bindingWeeklyResetMs` ⇒
   `Infinity` (sorts last). Falling back to `weeklyResetMs` would use an
   unrelated, *healthier* weekly window's reset.
3. **`extra_usage` is RESETLESS** ⇒ `Infinity`, even when another axis is also
   bound. It is folded into `bindingUtilization` but has no reset, so an account
   it binds never self-recovers.

`CapacitySignal.sessionResetMs` and `.extraUsageUtilization` exist for exactly
this: neither is recoverable from the aggregates (`soonestResetMs` is a min()
that loses which window it came from; `bindingUtilization` is a max() likewise).
