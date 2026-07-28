---
name: rate-limiting
description: Rate limiting, usage windows, cooldowns and recovery in ClankerMux. Read this before touching 429/529 handling, cooldowns, account selection or routing, usage polling, the usage cache, rate-limit display in the dashboard, or the accounts.rate_limit_* columns.
---

# Rate Limiting, Usage & Recovery

Most of what follows was expensive to derive — some of it from production log
forensics — and is not obvious from the code, which contains at least one comment
that is provably wrong (see `references/429-signals.md` § Disproven comments).

## The mental model in one paragraph

Anthropic reports account usage as a set of **windows** (5h, weekly, …) via a
state endpoint we **poll**. It separately rejects individual requests with 429s
carrying headers that describe *why*. When a 429 means the account itself is
spent, the proxy writes a **cooldown** (`rate_limited_until`) that removes the
account from routing until a deadline. Everything the dashboard shows is a
**projection** of that state — it never feeds routing. An account comes back
either when its cooldown expires, or when polling observes the quota recovered.

## The 429 decision ladder

`proxy-operations.ts`, in order:

```
reprobe
  → out_of_credits            (long floor, no burst-retry)
  → account-wide exhausted    (weekly OR 5h session spent; no burst-retry)
  → family-weekly safety net  (fails over WITHOUT an account-wide cooldown)
  → transparent burst-retry   (classify429Transient → hold & re-probe)
  → model fallback / no-fallback / all-models-exhausted
  → response-processor generic path
```

Earlier rungs are more specific and win. **Order is load-bearing** — the
account-wide and family rungs sit before burst-retry precisely so a spent window
is never misread as a transient burst. The account-wide rung's DEADLINE is still
`extractCooldownUntil`, never the window's `resets_at`: a stale-cache false
positive must not be able to create a multi-day lock.

`classify429Transient`:

1. non-OAuth-Anthropic → not retryable
2. account-wide hard status → not retryable *(dead in practice — see references)*
3. **fresh capacity, `minHeadroom > 0` → retryable** ← the real burst signal
4. stale/absent/zero headroom: a REJECTING status → not retryable; else
   `x-should-retry: true` → retryable

## What actually blocks routing

```ts
isAccountAvailable = !paused && (!rate_limited_until || rate_limited_until < now)
```

That is the whole routing contract. Independently, an account can still be
excluded per-request by: the family-weekly gate, the 529 provider-overload
breaker, context-window fit, and API-key account/class pinning.

## Background loops

| Loop | Cadence | Behaviour with a LOCKED account |
|---|---|---|
| Usage poller | 90s active / ~10min idle (demand-aware) | **keeps polling** — the only observation channel |
| Auto-refresh scheduler | scheduled | **skips locked accounts** by SQL |
| Usage snapshots | 2 min | Limits-tab history |
| Integrity | quick 6h / full 24h | — |
| Codex spend coordinator | on traffic | Codex windows/credits |

## Invariants — do not break these

1. Representative utilization returns `null`, never `0`, on no evidence.
2. The presented status never influences routing.
3. `family_weekly_exhausted_429` must never apply an account-wide cooldown.
4. `out_of_credits` floors must expire or clear on a real successful request —
   never be wiped by polling.
5. A new `RateLimitReason` needs all three follow-through sites
   (`references/429-signals.md` § Cooldown reasons).
6. Per-IP burst cooldowns must never be released on account-quota evidence —
   they are unrelated limits, and clearing one re-storms it. This is why the
   capacity-restored clear is gated on `QUOTA_DERIVED_RATE_LIMIT_REASONS` and
   NOT on "anything except `out_of_credits`": `upstream_429_with_reset`, which a
   burst inherits, is excluded.
7. Status vocabulary lives ONCE in `packages/core/src/rate-limit-status.ts`.
   It was duplicated in four places, which is exactly why `rejected` — the value
   Anthropic actually sends — was recognized by none of them.
8. Soft demotions are applied as ONE partition over the union of all demotion
   reasons, never as sequential partitions (`references/routing-gates.md`).
9. Anything that bypasses the ordinary attempt loop must test POSITION against
   `routing.primaryAttemptAccountId`, not membership in the candidate list
   (`references/routing-gates.md`).
10. Never add a 5h term to HARVEST ranking — unused 5h capacity is not lost
    budget (`references/routing-gates.md` § The 5h window is nested).

## References

| File | Covers |
|---|---|
| `references/usage-windows.md` | The window taxonomy from `GET /oauth/usage`, representative utilization, NEAR_LIMIT recovery ordering |
| `references/429-signals.md` | What Anthropic actually sends on a 429 (measured over 1,145 production 429s), the cooldown-reason taxonomy, known dead code and disproven comments |
| `references/routing-gates.md` | Soft demotions, the pool-liveness reserve, position-vs-membership, display as a projection |
| `references/recovery.md` | How a locked account comes back; the capacity-restored path |
