# How a locked account comes back

| Path | Trigger | Works today? |
|---|---|---|
| Natural expiry | `rate_limited_until < now` | yes |
| Successful response | a 200 clears the lock | yes, but unreachable while locked (router skips it) |
| Auto-refresh success | token refresh clears the lock | no — the scheduler skips locked accounts |
| **Capacity restored** | polling observes the quota recovered | **yes — live since the early-reset-recovery fix** |

**There is no reset notification.** Early recovery can only ever be detected by
observing the polled number drop — which is why the poller keeps running against
locked accounts.

## The capacity-restored path

Formerly dead for two months (see `429-signals.md` § Known dead code). It works
like this:

1. The poller REPORTS, level-triggered, on **every** successful poll where the
   representative utilization is a number **below 100**: `{ accountId,
   utilization, extraUsageUtilization, fetchStartedAt }`. Level, not edge —
   an account locked while its windows sat at 40% never produces a `100 → <100`
   crossing. `null` never reports (see `usage-windows.md`).
2. `apps/server/src/capacity-restored.ts` decides. It refuses, with a distinct
   greppable token, when: the reason is not quota-derived (`ineligible_reason`),
   `rate_limited_at` is absent (`missing_rate_limited_at`, fails CLOSED), the
   cooldown is not strictly older than `fetchStartedAt`
   (`cooldown_newer_than_evidence`), or the atomic UPDATE matched no row
   (`cas_mismatch`). Success logs `capacity_restored_clear`.
3. The DB compare-and-clear re-asserts deadline + write instant + exact reason +
   the causal boundary in ONE `UPDATE`.
4. A released account is selectable again with streak 0 and no deadline, so a
   dedicated **capacity-restored marker** admits exactly one probe. It is never
   time-expired and is retained on `cooldown_reapplied` / `abandoned`. The
   global force-account override in `proxy.ts` bypasses account selection
   entirely, so the one-probe guarantee explicitly excludes it.

Level-triggering heals a REFUSED or MISSED clear — not an incorrect one.
Correlating `capacity_restored_clear` with a subsequent 429 on the same account
is the signal that an early release was wrong.
