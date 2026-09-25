---
name: claude-sdk-bridge
description: How ClankerMux serves non-Claude-Code clients (pi, Codex, OpenCode on /wire/openai) on official Anthropic accounts by running real Claude Code through the Agent SDK. Read this before touching packages/claude-sdk-bridge, the sdk-bridge-inner routing mode, officialAnthropicVia, the bridged attempt in proxy-operations, or the Claude Code child's options and environment.
---

# Claude Agent SDK bridge

A Responses or Chat request (`/wire/openai`) is never sent to an official
Anthropic account (`anthropic`, `claude-oauth`, `claude-console-api`) by a
direct fetch. When routing lands such a request on one, ClankerMux runs real
Claude Code (`@anthropic-ai/claude-agent-sdk`, bundled CLI) for the turn, and
Claude Code's own model calls come back through ClankerMux's normal Anthropic
pipeline. The client keeps executing its own tools.

## Architecture map

- **Floor.** The Responses and Chat adapters mark `denyDirectOfficialAnthropic`
  in their in-process WeakMap contexts. Ingress turns that into
  `RequestMeta.officialAnthropicVia = "sdk-bridge"`. No header can set or clear
  it. `/wire/anthropic` is `"direct"` and never bridged.
- **Route construction** (`routing-service.ts`, `resolved-route.ts`) reads
  `sdkBridge.availability()` once. Unavailable or shutting down: official
  Anthropic accounts are excluded with the reason. Available: they stay
  candidates, except when the body carries a field the bridge refuses
  (`sdkBridgeRefusedField` in `@clankermux/types`, shared with the bridge's
  own parse). Then they are excluded, and a route left empty by that alone
  answers the bridge's 400 naming the field.
- **Outer bridged attempt** (`handlers/sdk-bridge-attempt.ts`, branched in
  `proxyWithAccount` / `proxyForcedAccount` before cache staging and token
  resolution). It runs none of the account machinery: no cooldowns, no
  401/429/529 classification, no probes, no holds, no `forwardToClient` row.
  Its response is final. Only `SdkBridgeUnavailableError` (bridge
  infrastructure) fails over to the next outer candidate. An inner 429/529
  never relaunches Claude Code on another outer candidate. Its subclass
  `SdkBridgeCapacityError` (process or rebuild cap) fails over too, and when
  it was the last failure the give-up terminals answer its 529 and
  Retry-After instead of their own 503; later official candidates of the same
  request skip the bridge (`sdk-bridge-capacity.ts`).
- **Frozen `SdkBridgeRoutePlan`.** Built after alias-stage selection and
  candidate ordering: the official Anthropic subset, in order, with the
  outer-selected account preferred, the key identity and the turn id. Inner
  calls install their route from it and never re-resolve pin, rules, force or
  alias (`initializeSdkBridgeInnerRoute`).
- **Inner calls.** The bridge's private `Bun.serve` on `127.0.0.1:0` takes a
  per-turn token, attaches the trusted `SdkBridgeInnerContext` by WeakMap and
  calls `dispatchProxyRequest` in `sdk-bridge-inner` mode. That mode is not
  `isInternal` (maintenance traffic). Inner requests are always `"direct"`, so
  there is no re-entry. They are ordinary `requests` rows with
  `sdk_bridge_turn_id`; token and cost truth lives there. A body over
  `maxHistoryBytes` is refused with 413 before it is read.
- **Inner accounting.** `inner_call_count` counts rows begun
  (`onInnerRequestStarted`, from `forwardToClient`'s `begin` or a synthetic
  terminal); `inner_error_count` counts error outcomes, listener refusals
  included, so it can exceed the call count. A 2xx SSE reply reports its
  outcome when the stream ends, from what it carried: an `error` event counts
  as its status, a missing `message_stop` as 502. `handleProxy` returns the
  wrapped response, which is the one Claude Code must read.
- **Continuations bypass routing.** A request whose final user message (the
  trailing user messages, merged: Chat sends text typed with tool results as
  a user message after them) holds `tool_result` ids a live query waits on
  *now* goes straight to that query (`continueParkedSdkBridgeTurn`), before
  any route is built. The bridge refuses, with one `continue` leg recorded
  each: another key's turn (409), ids that do not cover every awaited call or
  that an earlier round handed out (409 "stale tool results"), shutdown (503).
- **Dead continuations.** Tool results no live query holds, sent with the
  assistant message that made the calls, start a new query with
  `rebuild_reason = dead_continuation`: the history and the results are
  flattened into the prompt. Never a transcript: resuming a transcript that
  ends in tool calls, Claude Code drops the calls as interrupted and the
  results with them ("No response requested." / "(no content)" upstream).
- **Text sent with tool results** goes to Claude Code before the results,
  while it still waits on the MCP calls; it then sends it after them in the
  same model request. Sent after the results, it became a turn of its own
  whose answer reached nobody.
- **Superseding.** A new start turn of a conversation whose query is parked
  on tool calls tears that query down (`aborted`, "superseded").
- **Accounting.** `sdk_bridge_turns` (one per Claude Code query) and
  `sdk_bridge_turn_legs` (one per outer HTTP request; the leg id is the
  client's `x-clankermux-request-id`). Legs have no `requests` row.
  `GET /api/sdk-bridge-turns/:id` takes a turn id or a leg id.

## Child options and environment

The environment is an allowlist built from nothing (`childEnv` in
`options.ts`); never pass `process.env`. PATH is an empty dir, HOME,
CLAUDE_CONFIG_DIR and TMPDIR live under the process's own generation
directory, `gen-<id>/` in the work root
(`$XDG_CACHE_HOME/clankermux/claude-agent-sdk`, inside the unit's
ReadWritePaths). Everything there is 0700/0600 and written without
following symlinks (`work-dirs.ts`). Startup removes earlier generations
whose `owner.json` pid is gone; dispose removes its own. A closed query's
session files and Claude Code's own transcript under
`claude-config/projects/` are deleted. The directories the earlier layout
kept directly under the work root (`sessions`, `claude-config`, …) are only
made private, never deleted: no pid says whether a process still uses them.

- `CLAUDE_CODE_MAX_RETRIES=0`. Retries belong to the proxy's inner calls,
  which fail over across accounts. With the CLI's own backoff the proxy's
  60 s overload breaker/hold and the pool-exhausted Retry-After (about 49 s)
  stack on top of it: measured with retries=2, a persistent 529 took 665 s
  and an all-accounts 429 took 98 s to reach the client. In the spike an
  all-accounts 429 took 594 s with the CLI's backoff and 0.7 s without.
- **Never set `CLAUDE_CODE_ENTRYPOINT`.** Traffic is honestly labelled
  `cc_entrypoint=sdk-ts`; setting it would misdeclare the billing class.
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` carries the client's `max_tokens`. It bounds
  each model call, not the turn: after a `max_tokens` stop Claude Code asks
  the model to continue under the same limit, and the client sees one reply
  ending `end_turn`. The CLI caps it at the model's ceiling (a client 200000
  went upstream as 128000).
- Also pinned: `ENABLE_TOOL_SEARCH=false` (the CLI decides tool search per base
  URL, account and flag rollout otherwise), `DISABLE_AUTOUPDATER`,
  `CLAUDE_CODE_DISABLE_ATTACHMENTS`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_AUTO_COMPACT`,
  `ENABLE_CLAUDEAI_MCP_SERVERS=0`.
- Options: `tools: []`, `settingSources: []`, `skills: []`, `plugins: []`,
  `strictMcpConfig`, `verbatimPrompts`, `systemPrompt.snapshot: false` (a
  resume renders the current policy's prompt), and
  `pathToClaudeCodeExecutable` always set (skips a libc probe that blocks the
  event loop).

## System prompt policies

`system-prompt-policy.ts` picks the policy by harness, once per start turn,
and records it as `sdk_bridge_turns.system_prompt_policy` with
`system_prompt_detail` (JSON, never the prompt text). A policy returns a
typed outcome and never throws; a refusal goes through `reject()` before
the conversation claim, so it supersedes no parked turn and leaves a
`rejected` row with its `pre_head` leg.

- `drop` (every harness but `pi`): the `claude_code` preset alone.
- `pi-head-v1` (`clientHarness === "pi"`, `pi-prompt.ts`): when the text
  starts with pi's stock preamble followed by `<tools>`, `<rules>` and
  `<docs>`, that head and the blank line after it are removed; everything
  after it is appended to the preset byte for byte and never parsed. Any
  other text (a replaced preamble, a forced prompt without the head) is
  appended whole. pi's section updates to `tools`, `rules`, `docs`, or the
  preamble back to stock are removed; every other update and every
  `Removed system prompt section` message stays.

It strips rather than selects because pi's extensions append to the
prompt: claude-context returns pi's prompt plus raw guidance after `<cwd>`,
pi-subagents appends `<advertised_subagents>`, both as forced prompts. The
head is the only part that draws the subscription 400, and pi always
renders it first.

pi declares its layout in `x-clankermux-pi-prompt` (threaded as
`SdkBridgeTurnMeta.piPromptVersion`). Layouts are keyed by head
(`HEADS` in `pi-prompt.ts`); releases with a byte-identical head share an
entry. A version is supported only while it has fixtures under
`__tests__/fixtures/pi-prompts/<version>/`, written by
`scripts/generate-pi-prompt-fixtures.ts` from the installed pi release's
own builder and the claude-context and pi-subagents code that rewrites the
prompt. Only a pi release that changes the head or the update wording
needs new fixtures. Discovery lists the versions at
`clankermux.piPromptVersions` in the OpenAI-shape
`/v1/models?clankermux_metadata=1` response, so pi can warn before a turn
is refused.

All refusals are `400 invalid_request_error`:

| `error.code` | When |
| --- | --- |
| `sdk_bridge_prompt_unsupported` | header missing, or a version without fixtures |
| `sdk_bridge_prompt_malformed` | `</tools>`, `</rules>` or `</docs>` more often than the head and its updates account for (at least once is always allowed), or the stock preamble not followed by the full head |
| `sdk_bridge_prompt_refused` | the forwarded text carries pi's preamble line at a line start, or both `docs/custom-provider.md` and `docs/packages.md`; subscription accounts answer those with a 400. A persona embedding its parent's pi prompt lands here too |

pi's clankermux provider (openai-responses, no `compat`) sends one leading
system message: pi-ai's `resolveTranscript` collapses every later system
message into it, patching sections in place and appending new ones at the
end. A mid-session tools change therefore stays inside the head and is
stripped with it. A session whose replaced preamble goes back to stock
comes out as the stock preamble with `tools`, `rules` and `docs` after
everything else, which is refused as `incomplete_head`. Separate
`Updated system prompt section` messages only arrive from a model with
`supportsMidConvoSystemMessages`; the Responses adapter folds them into
`system`, the Chat adapter refuses instruction messages after the first
non-instruction one. Fixtures carry a `transport` saying which shape they
are.

Continuations never run the policy: the live query keeps its prompt. A
resume or rebuild runs it again, and `snapshot: false` makes Claude Code
render that prompt rather than the stored one.

## How a failed turn reaches the client

The inner call Claude Code gave up on in the current leg decides
(`mapInnerOutcome`); an earlier leg's outcome never does. Without one, the
failure was Claude Code's own (`mapClaudeCodeFailure`), and only a typed
cause changes its 502. Overflow is recognised in one place,
`isContextOverflow` in `errors.ts`.

| Source | Client answer |
| --- | --- |
| Inner 400 saying "prompt is too long" or "input length and `max_tokens` exceed context limit", or coded `context_length_exceeded` | 400 `invalid_request_error`, `code: context_length_exceeded`; the first wording keeps its token counts, the second its message |
| Inner 400 while Claude Code's cause is overflow | the same overflow 400 |
| Other inner 4xx except 401 and 403 (400, 402, 404, 413, 429, …) | same status and type |
| Inner 403 | 403 `permission_error` |
| Inner 503, 529 | same status, with Retry-After |
| Inner 401, other 5xx | 502 `api_error` |
| A streamed inner `error` event | the status its type stands for (`anthropicErrorStatus`), with its `code`, then as above |
| `terminal_reason` `prompt_too_long`, `blocking_limit`, `rapid_refill_breaker`; an error assistant message, result text or SDK exception saying "Prompt is too long" | 400 `context_length_exceeded` |
| `max_output_tokens` assistant error, `error_max_turns`, `error_max_structured_output_retries`, `error_during_execution`, exit without a result | 502 `api_error` |

`blocking_limit` is Claude Code refusing before any model call: with
`DISABLE_AUTO_COMPACT` it is what an oversized history usually meets, so
that path has no inner outcome.

The adapters pass `error.code` through (trimmed, 128 characters at most),
and use the type when there is none. A Chat client that asked for JSON gets
a mid-stream error's own status only for 400, 413, 429 and 529, the last two
with Retry-After; anything else answers 502. A 401 or 403 there would tell
an OpenAI SDK client its own key is bad.

A continuation is compared on the model string the client wrote, never the
upstream model an alias resolves to. When the caller's own parked turn is
answered under another model, `findContinuation` tears that turn down and
answers null, so the same request routes normally and starts a fresh turn on
the new model (a `dead_continuation` rebuild). Another key's results are
still refused, and stale or partial ones keep their own 409.

## Behaviour that looks like a bug and is not

- **pi's own prompt text is never forwarded whole.** Stock pi's system
  prompt reproducibly draws a 400 "out of extra usage" from subscription
  accounts (gotgenes/pi-packages#883), which is why `pi-head-v1` removes
  pi's head and checks the rest. An "out of extra usage" 400
  from an inner call reaches the client verbatim and changes no account.
- **"Failed to authenticate".** The CLI reports any 403 from its base URL that
  way. The inner listener rewrites a ClankerMux 403 to 400 for the child, and
  the bridge never passes the CLI's credential wording to the client
  (`sanitizeMessage` in `errors.ts`).
- **Tool names.** The Messages API allows `^[a-zA-Z0-9_-]{1,64}$`, and Claude
  Code sends an MCP tool as `mcp__<server>__<tool>`. The server is named `c`
  (prefix `mcp__c__`); a name that would overflow becomes
  `t_<first 16 hex of sha256(name)>`. Chat tools arrive as `cmux_chat_` plus 48
  hex (58 characters), so without the alias every Chat tool overflowed.
  `ToolNames` is the only place names are converted.
- **Several inner rows per model turn.** Retries are off, but Claude Code still
  makes extra calls (output-limit recovery, non-streaming fallback under a new
  message id).
- **Resume needs a session header.** Without one every user turn is a fresh
  session rebuilt from the client's history; nothing resumes on a digest match.

## Resources

Measured 220–270 MB RSS per Claude Code child (about 220 MB each with four
turns parked).
`sdk_bridge_max_processes` defaults to 8; parked queries count against it.
`/api/system/status` reports live, parked, cap and peak RSS (VmHWM).

## Tests

- Unit tests inject a fake `queryFn` (`__tests__/fixtures/fake-sdk.ts`).
- Real-binary tests (`packages/claude-sdk-bridge/src/__tests__/real-claude.integration.test.ts`,
  `apps/server/src/__tests__/claude-sdk-bridge.integration.test.ts`) re-execute
  under `unshare -rn` with only loopback, assert 1.1.1.1 is unreachable, and
  talk to `fixtures/mock-upstream.ts`. Where user namespaces are unavailable
  (Ubuntu 24.04's AppArmor userns restriction) they skip with the reason
  printed. They never run with egress, and never against a real account.
- Driving the bridge by script or by hand against a real account is forbidden;
  see "Never curl the Anthropic endpoint" in `.claude/CLAUDE.md`.

## Prior art

- **pi-claude-bridge**: parked MCP handlers, tool-use id pairing, raw JSON
  schemas, history rebuild rules. Its phantom-tool deadlock (122914dd) is why a
  `tool_use` for a tool the client does not have is dropped, never forwarded.
  Its audit found an orphaned child making 1,416 requests in 59 min, which is
  why teardown revokes the turn token before `interrupt()`, `close()` and the
  process-group kill.
- **rynfar/meridian**: lineage classification of rebuilds, sub-agent session
  keys (a client's title/summary helper must not resume the main
  conversation), Retry-After on every 429/503/529. Unframed history replay
  produced invented `Human:` turns (meridian#619), so a flattened fallback is
  framed with a provenance note. Its PreToolUse-deny + `maxTurns: 1` design
  writes synthetic denials into the transcript; parking avoids that.
- **Agent SDK issues**: the prompt iterable must stay open until `result`
  (SDK#348, closing it kills parked MCP calls); terminal events can go missing
  (SDK#403, #427), hence the idle watchdog, suspended while parked; `result`
  can carry `is_error: true` under `subtype: "success"`.
