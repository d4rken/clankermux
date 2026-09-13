---
name: provider-integration-limits
description: Cross-provider integration constraints in ClankerMux that are invisible from the code — upstream endpoints that do not exist, client-side misbehaviour mistaken for proxy defects, and one known unfixed converter. Read this before changing provider adapters, token counting, cost attribution, or cross-provider routing.
---

# Provider integration limits

Every entry here was established by live experiment against a real provider.
None of it is visible from the source, and several entries exist to stop a
client-side or upstream behaviour being diagnosed as a proxy defect.

## OpenRouter has no `count_tokens` endpoint

`POST /v1/messages/count_tokens` returns **404** on that route. Token counting
for **default-endpoint** OpenRouter accounts is therefore done locally, in
`packages/providers/src/local-token-count.ts`. Accounts configured with a custom
endpoint still count upstream — the guard is literally
`provider === "openrouter" && !customEndpoint`.

## Switching provider mid-conversation mislabels refusals

Resuming a Claude Code session after re-routing it from Astra to DeepSeek
reproduces a refusal whose upstream response is HTTP 200 with
`stop_reason: refusal`. Claude Code's own UI names the requested **Fable** alias,
so it reads as a refusal by the Fable model. It is not: the resolved and reported
model is DeepSeek. Client-side display behaviour, not a proxy defect.

## DeepSeek rejects `thinking.block_binding`

OpenCode adds Fable 5.1 thinking-binding controls automatically because of the
requested model name. DeepSeek via OpenRouter rejects the resulting
`thinking.block_binding` field with **HTTP 400**. Fixed in the OpenCode client
config (its own opt-out); no proxy change was made, and nothing strips the field
automatically.

## Client cancellation is client-dependent, and the record is mixed

Establish which case you are in before concluding anything about proxy
behaviour.

**Did NOT reproduce** — prompt cancellation, first signal:

| Case | Client exit after signal | Upstream abort after client abort |
|---|---:|---:|
| curl Responses, at upstream headers | 1 ms | 14 ms |
| OpenCode 1.18.30, at step start | 64 ms | 2 ms |
| OpenCode 1.18.30, before first text | 68 ms | 4 ms |

**DID reproduce** — the client held roughly **ten seconds** until SIGTERM:

- OpenCode v1 with `@ai-sdk/openai-compatible`, during active output on
  OpenRouter. In the instrumented repeat the proxy received ingress abort only
  at termination and closed its upstream reader 2 ms later.
- OpenCode Responses on DeepSeek: both SIGTERM and SIGINT trials needed the
  runner's second signal, upstream completing ~10,027 ms after the first.

Root cause unconfirmed. No proxy patch was made, and downstream disconnect
propagates promptly once it arrives.

## The Codex non-Chat converter is knowingly unfixed

The overlapping tool-call buffering and early-close defect that was fixed for
Chat Completions still exists in the Codex **Messages and Responses** converter.
It is deliberately unfixed and flagged nowhere in the code.
