# Chat Completions ingress handover

## Goal

Add `POST /wire/openai/v1/chat/completions` so clients that speak OpenAI Chat Completions can use ClankerMux. The current OpenAI mount serves Responses, Responses compact, and models; an authenticated Chat Completions request currently receives 404. This is not the legacy text-only `/v1/completions` API.

The user assigned this work to another agent. OpenRouter request pricing is independently owned by a different agent. The original routing agent is handling cancellation, cross-provider continuation, and optional token counting. Keep those changes separate and coordinate shared files before integration.

## Existing design to preserve

- Routing redesign shipped as `d56dea01` (2026.9.39); branch from current `refs/heads/main`, which may have advanced. Follow `.claude/CLAUDE.md` and use an isolated worktree.
- Existing ingress: Anthropic Messages and OpenAI Responses. Some outgoing provider adapters already speak Chat Completions; that does not implement incoming Chat Completions. The OpenRouter provider currently uses its Messages-compatible endpoint.
- Client API-key account/provider pins are the destination boundary. Rules select within that boundary; permissions authorize resolved models per account. Mapping happens once, and retries retain the frozen routing policy. Preserve send-time checks and attempts recording.
- Accept the usual `Authorization: Bearer <client-key>` through existing API-key authentication and pin resolution. Keep the OpenAI mount an explicit route allowlist; legacy `/v1/completions` remains unsupported.
- The wire format must not choose the destination provider. Use existing non-Anthropic experiment restrictions; do not introduce a path that bypasses pins or silently reaches official Anthropic accounts.
- Keep requested, resolved, outgoing, and reported model identities distinct. Do not disguise the actual model with the client's alias.
- Emit the upstream-reported model when available; if absent, use the verified outgoing target rather than inventing upstream confirmation or substituting the requested alias. Keep the audit's reported-model field null when unobserved.

## Suggested implementation scope

Add a client adapter into the existing routing/account-selection pipeline. Reuse existing format converters where semantics match, but do not assume conversion is lossless or duplicate routing policy in the adapter. Assess whether any native path can preserve more request detail without bypassing policy.

Support ordinary conversation messages, tool definitions/calls/results, JSON and streamed responses, finish reasons, usage, errors, and cancellation. Define a supported-field matrix before implementing: particularly images, structured output, reasoning controls, parallel tools, `n`, and streaming usage. Reject unsupported semantics clearly instead of silently discarding them. The initial scope need not implement every vendor extension, audio/video feature, or legacy functions format.

Return OpenAI-compatible error envelopes, including authentication, validation, routing rejection, and upstream errors; existing shared paths often produce Anthropic-shaped errors. Define how failures after streaming headers are sent terminate the Chat Completions stream. Pricing, general cancellation investigation, cross-provider history refusal, token counting, and database legacy cleanup remain outside this agent's scope; endpoint-specific cancellation behavior is still part of acceptance.

## Source map

- `apps/server/src/wire-mounts.ts`: currently allowlists three OpenAI routes.
- `apps/server/src/request-router.ts`: authenticated ingress dispatch and existing Responses handler.
- `packages/openai-responses-adapter/src/`: existing client-adapter structure, streaming and tool translation.
- `packages/openai-formats/src/`: shared format conversion helpers.
- `packages/proxy/src/{routing-service,resolved-route,routing-dispatch,routing-response-audit}.ts`: routing, permissions, send checks, audit.
- `packages/providers/src/providers/openai/provider.ts`: outgoing Messages-to-Chat conversion; OpenRouter currently has a separate Messages path.
- `docs/routing-table-implementation.md`: harness acceptance evidence and known limitations.

## Acceptance

1. Mocked tests for auth, endpoint dispatch, JSON/streaming text, multi-turn tools, errors inside HTTP 200 streams, cancellation before text and during output, and no duplicate usage recording.
2. Prove denied destinations never receive a request; rule/pin conflicts fail locally; final serialized models and attempt audit match the chosen route. Preserve Messages/Responses behavior.
3. Run a real client that actually emits Chat Completions. OpenCode's `@ai-sdk/openai-compatible` adapter is a useful case: it was unsuitable for our current Responses-only mount. Test text, observed tool execution, history replay, and cancellation against Codex/Astra and an available OpenRouter model where supported.
4. `ssh cnc` has OpenCode, Pi, OMP, Codex, and Claude Code. Permanent Pi/OMP/OpenCode keys are pinned to Codex/OpenRouter. Preserve their normal configs; use isolated test profiles. Never print/copy secrets into documentation or run scripted inference against official Anthropic accounts.
5. Run relevant tests, then repository-required lint and typecheck in that order after source edits. Full backend and DOM lanes are separate. Report supported/unsupported features and actual live evidence. Merge/deploy only under the user's applicable shipping authorization; main checkout is not the serving release.
