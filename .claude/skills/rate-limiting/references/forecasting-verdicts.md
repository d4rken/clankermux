# Forecasting: what was measured and rejected

Each entry below is a closed question. Re-proposing one costs a backtest run to
arrive at the same answer.

## Backtest winners are NOT the shipped estimators

The backtest selected **`naive`** for the five-hour window from its tuning
range, locked at commit `ab6e3455`. What actually ships for five-hour is the
least-squares regression in `computeUsagePrediction`
(`packages/core/src/usage-prediction.ts`), called from
`build-account-predictions.ts`. Never read a backtest winner as a description of
production behaviour.

For the seven-day window the lifetime average **is** the primary estimator. Its
rationale lives in `build-account-predictions.ts`'s own doc comment; do not
restate it here.

## The blind protocol

`trailing-7d` scores better in-range and is deliberately **not** promoted. The
protocol locks the winner from the tuning range only; promoting an estimator
because it looks better on the scoring range is peeking.

## EWLS recency weighting — rejected

Exponentially-weighted least squares, τ tuned on the tuning range, scored on
held-out data:

| Window | EWLS | best baseline |
|---|---:|---|
| `five_hour` | F1 **0.186** | 0.202 (`naive`), 0.195 (`lifetime`) |
| `seven_day` | F1 **0.625** | 0.715 (`lifetime`) |

The point estimate is the wrong sign, not merely unproven. No EWLS code remains
in the tree.

## Ledger-burn feasibility — negative

`f`, the share of account-wide burn belonging to a scoped workload, is **not
derivable from what the proxy records**. The token-to-percent relation measured
indistinguishable from a future-token placebo, and the entry requirement —
resolution finer than the provider's 1 % grid — is unmet. This is why
scoped-workload counterfactuals (`workload-headroom.ts`) are **bounded** rather
than measured.

## Relaxed forecast-confidence gate — rejected

The production one-hour gate stays. The candidate raised 27 extra exhaustion
warnings across five accounts; 9 were followed by exhaustion (**33 % precision**).
The development partition had no observed exhaustions among its scored points,
so that figure rests on the held-out partition alone.

## Absorption taper — rejected

A fixed **0.6** coefficient for the demand absorbed by survivors after an
account exhausts was proposed and rejected. The survivor slope table reads flat
after a peer death, and a fixed coefficient would be tuned on the same run that
judges it.

## Redistribution model for Fable — rejected

Its input contract covers **account-wide** windows only, not per-model. It
cannot express Fable's scoped (`weekly_scoped:<family>`) limits, which is
exactly why family headroom is a bound.
