# Chat Completions implementation and acceptance

Implemented 2026-09-11 from `docs/chat-completions-handover.md`, on
`feat/chat-completions-ingress` in `.claude/worktrees/chat-completions-ingress`.
Base: `72d0b78f`, including the routing followups and local token counting.
This document replaces the initial implementation plan with the final design,
support contract, and observed validation. The feature and release integration are prepared for promotion as 2026.9.47.

## Endpoint and supported fields

`POST /wire/openai/v1/chat/completions` accepts the usual
`Authorization: Bearer <client-key>`. Use `/wire/openai/v1` as the base URL for
`@ai-sdk/openai-compatible`. Existing key/account pins, routing rules and model
permissions determine eligible destinations. Initial provider support is **Codex
and OpenRouter**; official Anthropic accounts are always excluded. A permitted
OpenRouter account still uses its existing Messages transport.

| Input | Support |
| --- | --- |
| `model` | Required; requested identity is preserved for routing and audit |
| `messages` | Text strings or text-only content arrays; user/assistant conversation |
| `system` / `developer` message roles | Leading instructions from one role family; no mid-conversation instruction messages |
| `tools`, `tool_calls`, tool results | Function tools, object JSON arguments, stable IDs, complete call/result history, multiple calls/results |
| `tool_choice` | `auto`, `none`, `required`, or a declared function |
| `stream` | JSON or SSE; internal provider request always streams |
| `stream_options.include_usage` | With `stream:true`; one final usage chunk, then `[DONE]` |
| `max_tokens`, `temperature`, `top_p`, `stop` | OpenRouter only; explicit values preserved, never silently clamped |
| Assistant `reasoning_content` | String replay through OpenRouter as unsigned thinking; Codex excluded for such a request |
| `n` | Only 1 |
| `response_format` | Only `{"type":"text"}` |
| `strict` in function definition | Only absent or false |
| Images/audio/video/files, JSON/schema output, legacy functions, `max_completion_tokens`, `parallel_tool_calls`, `reasoning_effort`, penalties, seed, vendor routing fields | Rejected with 400; unknown fields also rejected |

Nonempty assistant reasoning replay becomes a Messages thinking block; its required
`signature` key is the empty string, explicitly unsigned. This preserves the text
without fabricating a provider signature. Empty strings are preserved too.
OpenRouter/DeepSeek acceptance below verifies this exact representation. Support
for unsigned reasoning is not verified across all OpenRouter models; models that
require signed reasoning can reject it upstream. A mixed Codex/OpenRouter key
replaying reasoning narrows to OpenRouter on that turn. Signed or
encrypted reasoning state and cross-provider continuation are outside this scope.

When a Chat request omits `max_tokens`, OpenRouter uses the service configuration
`chat_completions_max_tokens` (default **8192**, positive safe integer). An explicit
client cap wins. This default was accepted by `deepseek/deepseek-v4-pro`; it is not
a discovered per-model ceiling and is not verified for every OpenRouter model.
Codex applies its own backend output policy and rejects explicit client caps.
Where a model counts reasoning against its output budget, that budget can be
exhausted before answer text; `length` with empty content is a truthful outcome.

## Routing, conversion and accounting

The new `@clankermux/openai-chat-adapter` validates and translates once, then calls
the existing Messages proxy with the authenticated key identity and original abort
signal. It owns no account selection, provider fetch, pricing, or usage writer.

A trusted WeakMap context transfers Request → RequestMeta → provider Request and
raw Response. Client headers cannot supply it. Capability filtering occurs after
pins, rules, permissions and suppression, within the existing destination set, and
is included in the frozen route snapshot. Retries use the same compatible set.
A 429 from one OpenRouter account can retry another permitted OpenRouter account;
it cannot fall into an incompatible Codex conversion and turn into a cap-related
400. Send-time permission/model/capability checks remain authoritative.

A request with no permitted route returns 403. A route whose supported destinations cannot honor
an explicit field returns 400 `unsupported_parameter` with `param`. An internal
send-time capability mismatch is a 403 authorization invariant failure. Neither
case widens the key's destinations.

All tool names are deterministically encoded internally. This avoids Codex's
Claude-specific `Read`, `WebSearch`, `Skill`, and `StructuredOutput` mutations;
client-facing names and call IDs are restored. Chat Codex arguments stream directly,
so overlapping calls retain independent blocks and the adapter enforces the argument
limit before tool completion. Incomplete turns close all remaining blocks and retain
partial arguments with `length`/`content_filter`; successful turns with unfinished
calls fail visibly. Consecutive tool results become
one Messages user turn. Persisted request payloads use the translated Messages
shape, not the original Chat JSON.

Requested, resolved, outgoing and reported model identities remain distinct.
A stream chooses the upstream model known at its first message, or the verified
outgoing model when absent, and keeps that value stable across its chunks. A model
reported only later cannot change earlier bytes; JSON aggregation can use that
late report. Raw audit observes upstream before conversion and keeps reported model
null when none was observed. The requested alias is never a response fallback.

Usage comes from the existing provider pipeline. Chat normalizes additive Messages
input/cache counters to Chat prompt totals, preserving absent usage rather than
inventing zero counters. There is no second request or usage finalizer in the
adapter. Existing OpenRouter pricing is unchanged.

A live replay snapshot (account identifier omitted) recorded:

```json
{
  "requestedModel": "deepseek/deepseek-v4-pro",
  "pin": {"accountId": null, "providers": ["openrouter"]},
  "excludeOfficialAnthropic": true,
  "chatRequirements": {"fields": ["max_tokens", "reasoning_content"]},
  "targets": [{"provider": "openrouter", "upstreamModel": "deepseek/deepseek-v4-pro", "targetSource": "identity"}]
}
```

The mixed-provider narrowing/retry case is covered by the integration test; the
live excerpt reflects the deliberately OpenRouter-pinned test key.

## Response and failure contract

SSE emits a role chunk, text/reasoning/tool deltas, a finish chunk, optional usage,
and `[DONE]` only after a valid terminal event. Opening tool deltas include empty
arguments; interleaved calls retain independent contiguous Chat indices.

Finish mapping: end turn/stop sequence → `stop`; max tokens/context window exceeded
→ `length`; tool use → `tool_calls`; refusal → `content_filter`. Server-tool
`pause_turn` and unknown terminal semantics fail visibly instead of claiming the
task completed. Unknown content/events are intentionally strict. Partial tool JSON
is preserved for length/filter termination; malformed successful arguments fail.

HTTP errors use `{error:{message,type,param,code}}`, including authentication and
dispatch errors, and preserve status and Retry-After. After streaming headers, a
protocol error emits an error envelope and closes without a successful finish or
`[DONE]`. JSON mode returns 502 for malformed, errored or prematurely ended streams.
Codex Chat conversion no longer manufactures success on EOF; unknown incomplete
reasons fail rather than pretending a known token limit was reached.

Request bodies are bounded at 16 MiB; JSON aggregation at 16 million decoded
serialized characters; SSE frames/tool arguments at 1 MiB in decoded string
lengths; error bodies at 64 KiB. Gzip/deflate requests are
bounded after decompression. UTF-8 and fragmented CRLF SSE are parsed incrementally.
Readers are canceled on disconnect and after protocol completion, with no extra tee.

## Real OpenCode tests on CNC

Tests ran through `ssh cnc`, using isolated XDG profiles, fixture directories and
temporary pinned client keys. A private branch server/database ran on localhost
through SSH reverse forwards. Only unexpired Codex access credentials and the
OpenRouter key were copied into the temporary lab database; no refresh tokens,
background refresh, or official Anthropic inference. Permanent client configs and
keys were preserved. Production key/request overlap checks returned zero.

Versions: installed **OpenCode 1.18.30**, then separately installed npm `tui-v2`
preview **0.0.0-tui-v2-202606261840**. The registry had no stable 2.x version.
The preview is compatibility evidence for that pinned build, not a stable v2 claim.

Actual v1 request capture with `@ai-sdk/openai-compatible` confirmed the Chat path,
`max_tokens:4096`, tools, `tool_choice:auto`, and `stream_options.include_usage:true`.
Auxiliary/title requests can add `reasoning_effort:low`. Acceptance runs specified
`--title` to avoid an auxiliary title request. OpenRouter's main requests used stock
controls; Codex used this explicit isolated plugin:

```js
export const ChatProfile = async () => ({
  "chat.params": async (_input, output) => {
    delete output.maxOutputTokens;
    delete output.options.reasoningEffort;
  },
});
```

Register its absolute `file://` URL in the profile's `plugin` array. Do not use
OpenCode pure mode for that profile: it disables explicit plugins. Tests disabled
auto-update, default plugins, project/Claude configs, LSP downloads and file watching.
This is a compatibility profile; an unmodified Codex-bound Chat request containing
`max_tokens` is deliberately rejected before inference. The actual v1 negative test returned:

```json
{"error":{"message":"No permitted destination can honor Chat Completions field \"max_tokens\"","type":"unsupported_parameter","param":"max_tokens","code":"unsupported_parameter"}}
```

| Test | Codex / `gpt-6-astra` | OpenRouter / `deepseek/deepseek-v4-pro` |
| --- | --- | --- |
| v1 tool execution + text | Completed `read`, returned exact random fixture value | Completed `read`, returned exact random fixture value |
| v1 history replay | Recalled same value in resumed session, no tools | Recalled same value in resumed session, no tools |
| v2 preview tool execution + text | Passed | Passed |
| v2 preview history replay | Passed, no tools | Passed, no tools |
| Default output cap | No cap sent | Omitted client cap serialized as 8192; returned `CHAT_OK` |
| v1 cancel before text | Client exited in 64 ms; upstream fetch ended 29 ms after SIGINT | Client exited in 32 ms; upstream fetch ended 19 ms after SIGINT |
| v1 cancel during output | Active text observed; client exited in 65 ms, upstream reader ended in 38 ms | SIGINT did not disconnect the client; see limitation below |
| v2 preview cancel before text | Client exited in 64 ms; upstream ended in 28 ms | Client exited in 67 ms; upstream ended in 30 ms |
| v2 preview cancel during output | Client exited in 64 ms; upstream ended in 36 ms | Client exited in 64 ms; upstream ended in 28 ms |

OpenRouter tool replay initially exposed the unsupported `reasoning_content` field;
a regression test and lossless unsigned-text conversion fixed it. Both client
versions then completed the tool round trip and history test. After correcting the
Codex overlapping-call converter, a fresh v1 tool round trip and resumed history
test also passed against the changed branch server.

**OpenRouter SIGINT limitation:** in two v1 runs, OpenCode remained connected for
10 seconds after SIGINT during active output. The harness then sent SIGTERM. In the
instrumented repeat, the proxy received ingress abort only at termination and closed
its upstream reader **2 ms later**. Thus prompt SIGINT cancellation for that client
scenario is not a passing acceptance claim. Actual downstream disconnect propagates
promptly; upstream computation/billing termination is not independently observable.
The pinned v2 preview passed both cancellation phases on both providers; this does
not establish that all v1/v2 signal-handling scenarios behave alike.

Millisecond comparisons across CNC and the local host are approximate wall-clock
measurements; the ingress-to-upstream 2 ms interval used one host clock.
Timing instrumentation was a single pass-through fetch reader plus ingress abort
listener, with no tee and no prompt/credential logging. Cancellation was triggered
only while an inference request remained active, using first upstream text for the
during-output case. Earlier uninstrumented pre-header attempts were excluded from
timing claims because the observer initially did not record fetch rejection.

## Automated validation and review

Focused adapter/provider/routing tests cover authentication/dispatch, strict field
validation, text/JSON/SSE, tool names and interleaving, UTF-8 fragmentation, error
bodies, limits, absent usage/models, forced routes, one send/finalization, frozen
capability failover after 429, and cancellation before headers/before text/during
text/JSON on both providers with no retry. Existing Messages/Responses regression
coverage runs in the full backend lane. DOM tests run in their separate process.

- `bun run lint` followed by `bun run typecheck`: passed after the final source corrections.
- Focused adapter, routing integration and Codex provider regression tests: **392 passed**, 14 files.
- Separate `bun run test:dom`: **150 passed**, 21 files.
- Full `bun test` backend lane: **10,161 passed**, 639 files, zero failures.

The persistent `claude-opus-5[1m]` partner reviewed the implementation and follow-up
corrections. Completion requires its review of these exact changes and the partner
helper's `reviewed` check. Findings incorporated include
stable streamed model identity, opening tool arguments, reader cleanup, preserving
upstream HTTP/error diagnostics, strict Codex terminal handling, and partial
overlapping-tool termination. Speculative
model-specific inference probes were not run against Anthropic; those limitations
remain documented above.

Follow-up outside this change: the original Codex buffering/early-close behavior
for overlapping tools remains in non-Chat ingress. This change deliberately scopes
the fix to Chat; the Messages/Responses converter owner should investigate that
existing behavior separately.

Temporary lab servers, SSH forwards, client keys, credential database, CNC profiles,
fixtures and the separate preview installation were removed after sanitized evidence
export. These acceptance runs preceded release preparation; production promotion
and its smoke test are separate from the isolated lab evidence above.


## Release integration — 2026.9.47

Integrated main `e7ff5b7b` into the feature worktree before release. Shared routing
conflicts preserve Devin's canonical targets and response normalization alongside
Chat capability filtering and per-attempt context. The integration review found
that Devin's unresolved-alias diagnostic could overwrite Chat rejection messages;
the diagnostic now applies only to non-Chat requests. Both new regression cases
failed before this guard and passed afterward.

- Integrated full backend lane: **10,398 passed**, 658 files, zero failures.
  This run started before the final diagnostic guard; final coverage for that
  correction is the focused run below.
- Separate DOM lane: **166 passed**, 23 files, zero failures.
- Final focused Chat adapter, all Codex provider tests, routing integration,
  Devin route/dispatch and server dispatch: **542 passed**, 19 files.
- Final lint followed by typecheck: passed, no lint fixes or warnings.

The Clients page remains a separate follow-up. Promotion uses the repository's
revision-pinned release procedure, followed by an isolated OpenCode smoke on CNC.
