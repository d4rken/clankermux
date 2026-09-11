# Routing follow-ups — 2026-09-11

Release scope: `2026.9.42`. The implementation started from `30a68011` and was integrated with main `451680da`, which already includes OpenRouter cost tracking. This report records the implementation and investigation results; the serving release is verified separately during promotion.

## Ownership

- Chat Completions ingress: [handover for another agent](chat-completions-handover.md).
- OpenRouter cost tracking: implemented separately and merged into main as `451680da` (`2026.9.41`); preserved by this release.
- Legacy database cleanup: postponed by the user.

## Implemented: local OpenRouter token counting

OpenRouter now answers Anthropic `POST /v1/messages/count_tokens` locally, including through `/wire/anthropic`. OpenRouter accounts with a custom endpoint retain upstream counting and recording. Codex continues to count locally even with a custom endpoint. Codex and default-endpoint OpenRouter accounts share the existing Codex estimate:

`max(1, ceil((text characters + document payload characters) / 3) + image count * 2000)`

Successful responses retain `{ "input_tokens": ... }` and add `x-clankermux-token-count-source: local-estimate`. This is an advisory heuristic, not a model-specific tokenizer or a guaranteed conservative estimate. It can underestimate inputs, including some languages and code; the image allowance is fixed. Image base64 length does not inflate the text estimate. Document payloads retain the existing estimate.

The shared helper validates JSON and basic model/messages structure, returning 400 for malformed input. This also tightens the existing Codex endpoint: missing model/messages or invalid message roles previously received an estimate and now receive 400. Counting does not require the inference-only `max_tokens` field or upstream credentials. It makes no upstream inference request and creates no billable request/usage row. Attempts record `local_success` or `local_reject`, with outgoing/reported model absent.

Destination pins, the frozen route, current account/model permissions, suppression, and operator pause still apply. A capacity-exhausted pool can answer locally through an eligible destination; a policy-excluded destination cannot. Since `2026.9.43`, account-pinned and provider-pinned keys can also receive a local count when their authorized destination has no available upstream capacity. The fallback runs before capacity-related pin errors, rechecks current routing permissions, and still rejects paused accounts, organization-permission failures, and endpoints that require upstream counting. It never substitutes an account outside the authorized route. Other providers' counting behavior is unchanged.

Validation: the original feature passed lint then typecheck and **10,036 backend tests across 631 files**. Release integration with main passed lint then typecheck and **10,065 backend tests across 637 files, 0 failures**. Integration corrected a pre-existing database test that expected a usage-less re-save to erase the reported model; pricing deliberately preserves it. The test now also proves that updating the reported model leaves the requested model unchanged; runtime database behavior was not changed. Focused coverage includes normal/forced routing, malformed input, permission revocation, suppression, provider pins, paused/exhausted accounts, forged synthetic headers, unchanged Codex counting, custom-endpoint upstream counting/recording, request-recording exclusions, and dashboard ingress retraction for local 200/400 counts. No UI changes; the separate DOM lane was not run.

Live CNC checks used an isolated key restricted to Codex/OpenRouter and a rule resolving to `deepseek/deepseek-v4-pro`: text returned 35 tokens; images with 100 and 100,000 base64 characters both returned 2,066. All three returned 200 with the estimate marker, produced local-success audits, no outgoing/reported model, no associated usage rows, and zero observed upstream inference requests. Background metadata discovery is separate from inference.

## Investigated: cancellation

The historical approximately 10-second delay did not reproduce against actual OpenRouter/DeepSeek through the CNC SSH tunnel:

| Client / cancellation point | Signal | Client exit after signal | Proxy upstream abort signal after client abort |
| --- | --- | --- | --- |
| curl Responses / upstream headers | SIGINT | 1 ms | 14 ms |
| OpenCode 1.18.30 / step start | SIGINT | 64 ms | 2 ms |
| Original retained OpenCode runner / step start | SIGINT | 64 ms | Prompt cancellation observed |
| OpenCode 1.18.30 / before first text | SIGTERM | 68 ms | 4 ms |

No test needed a second signal. In the instrumented controls, client abort and the upstream reader's AbortError occurred in the same millisecond. The original runner's generic success predicate expected completed text/tool output, so its `passed: false` is not a cancellation failure; exit and abort evidence determine this result.

The historical attempts remain unexplained: their audit finished about 10,027–10,029 ms after the first signal and reported an upstream stream failure. Both the original runner and current controls signaled the process group; controlled testing included the SSH tunnel. External instrumentation did not install process signal handlers. These results justify no proxy cancellation patch and do not establish the historical root cause or prove when a provider stopped computation/billing.

## Still open: Claude Code cross-provider continuation

A Claude Code session routed to Codex/Astra successfully executed a real Read tool and returned its fixture nonce (two turns). Resuming that same session after switching its route to OpenRouter/DeepSeek reproduced a refusal: the upstream response was HTTP 200 with `stop_reason: refusal`, and the resolved/reported model was DeepSeek. Claude Code's UI named the requested Fable alias; that label does not identify the provider that refused.

A fresh DeepSeek conversation was not a passing control: the CLI exited successfully but returned empty output with no observed tool execution; two upstream responses ended with one output token each. Consequently the evidence does not isolate cross-provider history as the cause. An OpenRouter generation metadata lookup returned 404 and supplied no additional explanation.

No history, system instructions, or thinking data were silently stripped, and no thinking-signature cause was established. The next compatibility investigation needs a working fresh Claude Code baseline for the selected OpenRouter model, followed by a benign continuation comparison. Until then, this model/harness combination remains unverified; no automatic retry or transcript transformation was added.

## Test environment

Live experiments used a separate local server/database and CNC temporary profiles. The lab contained only Codex/OpenRouter accounts, a copied unexpired Codex access token without refresh credentials, and its own restricted client key. No official Anthropic account was present. Permanent CNC harness configurations and production keys were preserved. Temporary lab processes, tunnels, credential-bearing database, and remote profiles were removed after exporting sanitized evidence.
