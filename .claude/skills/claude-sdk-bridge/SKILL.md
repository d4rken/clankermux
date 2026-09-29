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
  each: another key's turn (409), ids that do not name every awaited call
  exactly once, name one it does not wait on, or that an earlier round
  handed out (409 "stale tool results"), shutdown (503). The same holds for
  a released park (below). A live query also refuses a result over
  `MAX_TOOL_RESULT_CHARS` (500,000 characters of text) with 400
  `sdk_bridge_tool_result_too_large`, delivers nothing and stays parked.
  Claude Code would hand the model a 2 KB preview of it, naming a file the
  model has no tool to read. A result with an image is exempt: Claude Code
  cannot store it in a file and never previews it (`previewedChars`). A
  released park's resume, a rebuilt history and a dead continuation carry
  results as message content, which Claude Code sends whole, so they take
  no such check. The published contract says only that a larger result
  may be refused, and that no other is rejected with this code (the body
  and context-window limits still apply).
- **History header.** Every leg's response, JSON or SSE, success or error,
  carries `x-clankermux-sdk-bridge-history` (`SDK_BRIDGE_HISTORY_HEADER`):
  the turn row's history mode, plus `; reason=<rebuildReason>` when there is
  one. A continuation leg and a refused one report their turn's decision,
  read before any teardown the refusal causes; another key's refusal
  (`otherOwner`) sends none. A released park keeps the decision in its
  resume descriptor (`history`; absent in parks stored before, which then
  send no header). A start refused before its turn exists (`reject()`)
  sends none. Both adapters and the router's
  Chat error rebuild copy it to the client, next to `x-clankermux-request-id`.
- **Released parks.** Parked for `sdk_bridge_park_release_ms` (2 min), a
  query is released instead of held: token revoked, process group SIGTERMed
  (SIGKILL after the grace), and only then the parked MCP handlers closed.
  Never `interrupt()`, `close()` or an MCP answer while the child lives:
  each writes a synthetic result into the transcript, and a later plain
  resume of that session carries it instead of the real one. The session
  file moves to `<workRoot>/released-parks/` (temp + fsync + rename) and a
  `sdk_bridge_released_parks` row records it (`preparing` → `released` →
  `claimed` → `consumed`) with an immutable resume descriptor; the turn row
  reads `released`. The client's results claim it (a second claimant gets
  409 stale), fork it under a new id and run Claude Code with `resume` +
  `resumeSessionAt` at the last envelope of the message that made the calls
  (envelopes arrive after `message_stop`), the final user message as one
  prompt. On resume Claude Code drops calls with no result from the chain
  before it looks for `resumeSessionAt`, and restores them only when it
  classifies the tail as an interrupted turn (an attachment or a tool
  result before the calls). A prompt Claude Code wrote nothing after (every
  turn of a resumed session) or text before the calls in the same message
  gets them dropped for good: "No message found with message.uuid". So the
  resumed session's `load()` (never its file) also returns one user entry
  answering, as a child of the resume point, every awaited call on its
  chain and every other one without a result of its own (a descendant of
  the entry holding the call, or one naming it as
  `sourceToolAssistantUUID`) (`FileSessionStore.appendOnLoad`);
  `resumeSessionAt` cuts it off
  before any model call. The listener writes `consumed` before the first
  model call goes out. A gone session file falls back to a flattened dead
  continuation.
  Parks survive restarts. The database lease (`sdk_bridge_park_lease`, one
  row) is the only authority over them: taken only when free, already this
  process's token, or its holder's process gone (pid and /proc start
  time). Every write to a park or to a turn a park owns carries the lease
  token in the same statement or transaction and changes nothing without
  it, so whatever a process still has in flight after losing the lease
  (declared dead, or dispose) is harmless. That includes the turn row's
  own writes: the original turn's `TurnRecorder` is fenced right before
  its first release writes the park (writes it already queued included,
  since each reads the token when it runs), and a resumed turn's recorder
  and the refusal legs of a released one carry the token from the start;
  they pass it to `finishTurn`, `bumpTurnCounters`, `insertLeg` and
  `finishLeg`. Ordinary turns pass none and are never fenced. Each claim has a generation (`claim_id`), and an unclaim or a
  consumed mark names the one it belongs to, so a late unclaim of an
  earlier claim never releases a newer one. Refused or failed writes leave
  the park `reconciling` (indexed, not claimable) and the maintenance pass
  retries them, one pass at a time and one write per park at a time, until
  the database agrees; a park is `released` locally only after a
  confirmed write. New files go to
  `released-parks/<sha256(realpath(db))[:16]>` under the holder's work
  root, and each record stores its file's absolute path, so a new holder
  on another work root recovers them where they are. A path is accepted
  only as `<root>/released-parks/<namespace>/<uuid>.jsonl` with no symlink
  anywhere on its chain: the root is this process's own work root or one
  whose real path is itself, and `released-parks`, the namespace directory
  and the file are each checked with lstat. The check runs at recovery,
  again when a resume claims the park, and before any park file is deleted
  (close, forget, expiry, a failed publish): a refused path is logged and
  left alone, only its record goes. The orphan sweep lists this process's
  own directory only when it too is reached without a symlink.
  Recovery runs before `installSdkBridge` exposes the transport, bounded
  by `recoveryStartupMs` (each DB call with a short busy-retry budget);
  it builds the index privately and publishes it only when every row was
  handled. Preparing and consumed records and unusable ones (size or resume
  point wrong; the full chain is checked when a resume claims the park)
  end their turns, and a file goes only after its close is confirmed.
  Stale claims return to `released`. Every recovery attempt, the ones the
  maintenance pass starts after another holder exits included, raises the
  "recovering" barrier before its first await and lowers it only once the
  new index is published or the lease is found to be another's: meanwhile
  the bridge is unavailable and tool results that match no live query
  answer 503 with Retry-After (also through the proxy). While another live
  process holds the lease, each maintenance tick's lease check raises it
  for that one database call. Any database failure fails the attempt, which
  is retried with backoff. Turn rows record their owning process, and
  only turns whose process is gone are closed. Everything from a resume's
  claim to its launch is one sequence with one rollback; a resume that
  ends before its first model call gives the park back (after waiting for
  a consumed mark in flight). Parks expire after
  `sdk_bridge_released_park_ttl_ms` (24 h, `expired`, 504). Shutdown releases
  parked turns, including ones that park during the drain, and dispose
  drains outstanding park writes before giving the lease up.
- **Known conditions of released parks.** A development database created
  at the unshipped `2523c6d7` schema (`sdk_bridge_released_parks` with
  `session_file`, no `claim_id`) has to be reset: that table is created
  with `CREATE TABLE IF NOT EXISTS`, so its columns never change in place.
  Turn rows written before `owner_pid` existed count as owned by a dead
  process and are closed by the next lease holder; that assumes upgrades
  are sequential (a production restart drains the old version before the
  new one starts), never two versions running on one database at once.
- **Dead continuations.** Tool results no live query holds, sent with the
  assistant message that made the calls, start a new query with
  `rebuild_reason = dead_continuation`: the history and the results are
  flattened into the prompt. Never a transcript: resuming a transcript that
  ends in tool calls, Claude Code drops the calls as interrupted and the
  results with them ("No response requested." / "(no content)" upstream).
  `resumeSessionAt` avoids that only for Claude Code's own transcript (a
  released park); a synthetic one is refused at that point ("No message
  found with message.uuid").
- **Client tool calls in the reply.** A streamed `tool_use` reaches the
  client only once its block stops with input that parses as a JSON object,
  then whole (start, one `input_json_delta`, stop); only then is it the leg's
  (`ReplyComposer`). One cut off mid-input (the stream died and Claude Code
  fetches the message again) or truncated at a `max_tokens` stop is withheld,
  and Claude Code's MCP call of it, if it makes one, gets an error result at
  once (`cutOffResult`) instead of parking. A block starting while one is
  buffered fails the reply with 502. So clients see no tool arguments stream
  on bridged turns; text and thinking still do. A non-streamed message's
  calls carry whole inputs and go out at once.
- **Text sent with tool results** goes to Claude Code before the results,
  while it still waits on the MCP calls; it then sends it after them in the
  same model request. Sent after the results, it became a turn of its own
  whose answer reached nobody.
- **Superseding.** A new start turn of a conversation whose query is parked
  on tool calls tears that query down (`aborted`, "superseded"), and ends
  its released parks the same way.
- **Deadline.** `sdk_bridge_turn_deadline_ms` is an active-time budget:
  parked and released time is not counted, and each resume moves the inner
  `deadlineAt` to what is left.
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
- `effort` is set only when the planned model takes one
  (`claudeModelTakesEffort`: Opus 4.5 and every model from 4.6 on), lowered
  to its family's range (`clampEffortToModel`). Haiku 4.5, Sonnet 4.5 and
  older models run at Claude Code's default.
- A `[1m]` model goes to Claude Code as is. Claude Code turns the suffix into
  the 1M beta header and sends the bare id, so the inner route plans both
  forms (`sdkBridgeCandidatesForModel`). Only `claude-opus-5-5[1m]`,
  `claude-fable-5-1[1m]` and `claude-sonnet-5[1m]` (`oneMillionContextBase`)
  are permitted through their bare id and published at a 1M window. Family
  rules and bare-id suppressions apply to them. A route that would send any
  suffixed id directly (not bridged) answers 400
  `model_suffix_requires_claude_code`.
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
- `DISABLE_AUTO_COMPACT` turns off both automatic and reactive compaction;
  microcompaction needs a query source the SDK never uses.
  `real-claude-context.integration.test.ts` pins each, with a control that
  shows it firing without the setting. If Claude Code ever reports a rewrite
  anyway (a `system` message `compact_boundary` or `microcompact_boundary`,
  or a `hint_clears` message), the turn fails with 502
  `sdk_bridge_context_rewritten`, a release under way included (no park is
  stored). After the client's reply went out (a settled side request, or a
  finishing turn), the turn is settled as `completed` at once
  (`settleDelivered`): the rewrite goes to its `error_message`, the process
  is stopped, nothing Claude Code reports later changes the turn, and its
  session is not resumed. A turn's outcome (`done`, the counters) and
  whether its session may be resumed (`resumable`, what `register` offers
  the conversation) are separate.
- `CLAUDE_CODE_NO_MODEL_FALLBACK=1`: without it a refusal on Fable 5.1 or
  Opus 5.5 is retried on `claude-opus-4-8`, which the inner listener refuses
  as unplanned. With it the refused message reaches the client with
  `stop_reason: refusal`, and the turn is `completed`: the error result
  Claude Code reports after a refusal does not fail it. Its session keeps
  the refused exchange as the client has it, so the next turn resumes it.
  A reply that ends on anything but `tool_use` after forwarding a call (a
  refusal after a tool_use) settles the turn the same way, with that
  reason in its `error_message`: the started calls are answered as aborted,
  the process ends at once, and the next turn rebuilds.
- Every tool is listed with `anthropic/maxResultSizeChars` at
  `MAX_TOOL_RESULT_CHARS`. Without it Claude Code previews any result over
  50,000 characters, and answers one over 25,000 tokens (it counts them
  with `/v1/messages/count_tokens`) with an error string instead. The
  declaration skips that token check for text; a result with an image
  still takes it and is cut to 25,000 tokens, hence
  `MAX_MCP_OUTPUT_TOKENS=100000000`.
- A client `document` block in a tool result reaches Claude Code as the
  text `[document omitted]` (`toMcpResult`): MCP results carry no documents.
- Options: `tools: []` (`["WebSearch"]` for a hosted web search, below), `settingSources: []`, `skills: []`, `plugins: []`,
  `strictMcpConfig`, `verbatimPrompts`, `systemPrompt.snapshot: false` (a
  resume renders the current policy's prompt), and
  `pathToClaudeCodeExecutable` always set (skips a libc probe that blocks the
  event loop).

## Hosted web search

A Responses request whose only tool is a hosted `web_search` gets a real
search: Claude Code's own WebSearch. The docs' "Hosted web search on Claude
models" is the client contract. Claude Code gets the results back as a
tool result, so its answer carries no `web_search_result_location`
citations and the Responses reply no `url_citation` annotations (pi-web-search
then reports 0 citations and relies on `action.sources`). Synthesizing
annotations from URLs in the text was declined on 2026-09-29.

- **Request.** The Responses adapter never puts the tool in the translated
  body (every other destination drops it, as before). `planHostedWebSearch`
  records it in the native context as `hostedWebSearch: {required,
  allowedDomains}` only when it is the only tool (not mixed with function,
  custom or `additional_tools`) and `tool_choice` is not `none`;
  `required` is `tool_choice: "required"` or a named web search. The
  bridged attempt copies it to `SdkBridgeTurnMeta.hostedWebSearch` and,
  once `startTurn` has returned a response, marks it served ("handled by
  the bridge", not "a search completed"; a start that throws fails over
  unmarked); the adapter logs the old "Skipping unsupported/built-in
  tool type" warning only for requests no bridge served, and an info line
  for a mixed request. The body carries no `tool_choice` for it, so the
  field policy never sees one. A malformed `tools` or `additional_tools`
  answers the adapter's usual 400. `external_web_access: false`
  (cached results only) is carried as `externalWebAccess: false`, and the
  bridge refuses that turn with 400 `web_search_cache_only_unsupported`
  before any claim, so it displaces no parked turn and starts no query.
- **Options.** With the flag, `tools: ["WebSearch"]` and `allowedTools`
  adds `WebSearch`; nothing else of Claude Code's own. With
  `allowedDomains`, a PreToolUse hook (`webSearchDomainHook`) sets
  `allowed_domains` on every call, keeps a narrower list the model chose,
  drops `blocked_domains` (the API takes one list or the other) and denies
  a call naming a domain outside the list. Side requests never get it.
- **Sub-request.** Measured on CLI 2.1.280 (`real-claude.integration.test.ts`
  prints it): WebSearch makes its own streamed `/v1/messages` call on the
  turn's own model (the bare id for `[1m]`, with the 1M beta), with
  `tools: [{type: "web_search_20250305", name: "web_search", max_uses: 8}]`,
  system "You are an assistant for performing a web search tool use" and
  user text "Perform a web search for the query: …". Sonnet 5 and Haiku
  force the tool (`tool_choice: {type: "tool"}`, thinking disabled); Opus
  5.5 and Fable 5.1 send `tool_choice: auto` and may answer without
  searching. The model is always in the frozen plan, so neither the inner
  listener nor `sdkBridgeCandidatesForModel` has a rule for it; it is an
  ordinary inner `requests` row. The provider's
  `usage.server_tool_use.web_search_requests` is not persisted on that row:
  no part of the gateway reads it today, so usage and cost reporting carry
  no per-search fees.
- **Reply.** The WebSearch `tool_use` becomes a `server_tool_use` block
  (`name: "web_search"`, input `{query}` only) and the SDK's
  `SDKUserMessage.tool_use_result` (a `WebSearchOutput`) a
  `web_search_tool_result` (`ReplyComposer.onWebSearchResult`), queued
  until no other block is open, taken once per call. `webSearchOutcome`:
  result groups are a completed search (URLs deduplicated, none is fine);
  "Web search error: <code>" in `results` is a failed one with that code;
  commentary with `searchCount: 0`, `is_error` (a hook denial included), or
  a missing or invalid output fails with `unavailable`. A call still
  unanswered at the reply's end fails the same way. A call becomes the
  leg's only once its block completes, as a client tool call does (above):
  a streamed message cut off inside a
  WebSearch input (Claude Code then fetches the call again, or not) drops
  that partial call, which never gets a result and never counts. At a new
  upstream message a forwarded block the cut left open is closed on the
  wire with what it carried. The Responses adapter
  turns the pair into one `web_search_call`, its slot reserved at the
  invocation.
- **Required.** `endLeg` checks for a completed search before
  `composer.finish()`: without one the turn is torn down with 502
  `web_search_not_performed`, JSON before the head, an SSE `error` (so
  `response.failed`) after it. The first message_start commits a streamed
  head, so a streamed turn practically always gets the SSE form. A refusal
  without a search fails the same way.
- **History.** The search blocks are not in `legContent()`, so the
  registered digests are the text answer's, which is what a Responses
  client sends back (its `web_search_call` items do not translate). The
  next turn resumes; Claude Code's transcript keeps its real WebSearch
  call. A search-only turn has no client tools, so it never parks and no
  resume descriptor carries the flag.
- **Journal.** The turn line carries `webSearchCount` (WebSearch calls) and
  `webSearchRequests`, the sum of Claude Code's `WebSearchOutput.searchCount`
  over their results. It is not the provider's
  `usage.server_tool_use.web_search_requests`, which nothing persists.

## Claude Code's environment block

The inner listener removes Claude Code's environment block from every
`/v1/messages` and `count_tokens` body before dispatch
(`stripEnvironmentBlocks`, `environment-block.ts`). Nothing else in Claude
Code's requests is changed.

- **What it is.** The attachment pass Claude Code runs between tool calls
  adds, once per session, `# Environment` / `You have been invoked in the
  following environment:` with the child's working directory
  (`<workRoot>/gen-<id>/cwd`), git state, platform, shell and OS, and
  `# Environment update` / `Primary working directory: <new> (was <old>)`
  whenever one changes. A released park resumed after a restart lands on a
  new generation, so the update names both sandbox paths. The transcript
  keeps the block, so every later call resends it. pi's model then reported
  two working directories, pi's `<cwd>` and "the latest environment update"
  (seen live 2026-09-27). The turn-start pass is skipped for
  `verbatimPrompts`, so a turn's first call never has it.
- **Why no option stops it.** Only `CLAUDE_CODE_SIMPLE` (`--bare`) and
  internal fork flags skip it; bare mode replaces the `claude_code` preset
  with `CWD: <path> Date: …` and takes API keys only.
  `CLAUDE_CODE_DISABLE_ATTACHMENTS` and `excludeDynamicSections` leave it.
  The directory is `realpath(process.cwd())`, so it cannot name the
  client's path without that path existing on this host.
- **Where it lands.** Always in a `role: "system"` message: bare for Opus
  and Fable, wrapped in `<system-reminder>` for Sonnet, sharing its message
  and often its text block with the model-identity reminder (which stays)
  and with text the client typed alongside tool results. Never inside a
  `tool_result` (parallel calls with image results included) and never in
  the top-level `system`, drop policy included.
- **Ownership.** Only a block whose working directory (both paths, for an
  update) is one of this bridge's sandboxes, `<workRoot>/gen-<id>/cwd`
  under the work root as configured or as resolved, is taken. The same
  block naming any other directory is the client's (a pasted excerpt, a
  flattened history) and passes untouched. Only system messages are
  searched, bare paragraphs and `<system-reminder>` wraps alike; a wrap it
  shares keeps its other paragraphs. A user message is the client's and is
  never changed, even when it names this bridge's sandboxes. Trailing
  whitespace and CRLF line ends are tolerated. Parks recovered from another
  work root keep their old generation's block.
- **Never an invalid request.** Only system messages are dropped, and not
  one whose removal would leave no message or end the request on an
  assistant turn. An emptied block's `cache_control` moves to the nearest earlier block that
  can take one: block-form messages only (a string message is never turned
  into blocks), passing over thinking and empty text, stopping at a block
  that has its own. With none, the breakpoint goes.
- **Deterministic.** The same input always gives the same output, so
  earlier messages stay identical across calls, resumes and released-park
  resumes: Opus 5.5 and Fable 5.1 refuse signed thinking whose history
  changed ("bound to a different conversation"), and the mock upstream
  does the same. A stripped body is parsed and re-serialised once per call;
  an untouched one is forwarded byte for byte.
- **Drift.** A text left in place that still names the work root next to
  `Primary working directory:` or `# Environment` is logged once per turn
  at debug, as is a user message holding text like it under the work
  root: a new CLI wording
  shows up there before anyone reads a transcript.
- **The cut.** Thinking signed before this change is bound to a history
  that held the block, so the first call of such a conversation after
  promotion (in practice a released park, the only session that survives a
  restart) gets the API's 400 "Invalid `signature` in `thinking` block. The
  block is bound to a different conversation. …", which the mock upstream
  returns word for word. Claude
  Code drops the refused thinking from its session and asks again at once,
  reading the cached prefix; it never sends that thinking again. The proxy
  passes that one error ("bound to a different conversation") to a bridged
  call instead of retrying it without thinking (`thinkingSignatureError`
  in `proxyWithAccount`): its retry left the thinking in Claude Code's
  session, and every later call was refused and retried (measured: three
  refusals in three calls). Every other thinking error, bridged or not,
  keeps the retry. Cost of the cut: one refused call per such
  conversation, and the turn's `inner_error_count` counts it.
- **Decision.** The user chose stripping on 2026-09-28 over leaving it
  (and over a stable directory under the work root, which the model would
  still read as a second cwd). Cited for it: Anthropic's LLM gateway guide
  requires only the `anthropic-beta` and `anthropic-version` headers to be
  forwarded unchanged, and #48236 and #52988. Its known cost: after a tool
  round a request carries the model reminder without the environment
  block, a pairing genuine Claude Code does not send.

## Bumping the Agent SDK or Claude Code

Run the real-binary suites (the two `real-claude*.integration.test.ts`
files here and the server's `claude-sdk-bridge.integration.test.ts`) in the
namespace before landing a bump. Where user namespaces are unavailable they
skip, printing why, and prove nothing: run them on a host that has them.
"never shows the model Claude Code's own directories, only the client's" in
`real-claude.integration.test.ts` fails if a new CLI renders the
environment block in a wording `stripEnvironmentBlocks` no longer matches;
update the patterns and the unit fixtures in `environment-block.test.ts`
from what the new binary sends. "recovers a released park whose thinking
was signed before the cut, with one refused call" fails if Claude Code
stops recovering refused thinking on its own.

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
  appended whole.

It strips rather than selects because pi's extensions append to the
prompt: claude-context returns pi's prompt plus raw guidance after `<cwd>`,
pi-subagents appends `<advertised_subagents>`, both as forced prompts. The
head is the only part that draws the subscription 400. pi's stock
construction renders it first; a collapsed custom→stock session and the herdr
child path do not, and are refused.

pi declares its layout in `x-clankermux-pi-prompt` (threaded as
`SdkBridgeTurnMeta.piPromptVersion`). Layouts are keyed by head
(`HEADS` in `pi-prompt.ts`); releases with a byte-identical head share an
entry. A version is supported only while it has fixtures under
`__tests__/fixtures/pi-prompts/<version>/`, written by
`scripts/generate-pi-prompt-fixtures.ts` from the installed pi release's
own builder and the claude-context and pi-subagents code that rewrites the
prompt. Regenerate and review the fixtures when a pi release changes the
head, pi-ai's system-message collapse, or the rendering of the extensions
above. Discovery lists the versions at
`clankermux.piPromptVersions` in the OpenAI-shape
`/v1/models?clankermux_metadata=1` response, so pi can warn before a turn
is refused.

All refusals are `400 invalid_request_error`:

| `error.code` | When |
| --- | --- |
| `sdk_bridge_prompt_unsupported` | header missing, or a version without fixtures |
| `sdk_bridge_prompt_malformed` | `</tools>`, `</rules>` or `</docs>` more than once anywhere, or the stock preamble not followed by the full head |
| `sdk_bridge_prompt_refused` | the forwarded text carries pi's preamble line at a line start, or both `docs/custom-provider.md` and `docs/packages.md`; subscription accounts answer those with a 400. A persona embedding its parent's pi prompt lands here too |

The single leading system message is the layout's contract. pi's
clankermux provider (openai-responses, no `compat`) sends only that:
pi-ai's `resolveTranscript` collapses every later system message into it,
patching sections in place and appending new ones at the end. A
mid-session tools change stays inside the head and is stripped with it. A
session whose replaced preamble goes back to stock comes out as the stock
preamble with `tools`, `rules` and `docs` after everything else; that is
refused as `incomplete_head`, as agreed with the pi side (none of its
extensions does it). If pi ever sends mid-conversation system messages to
ClankerMux, that comes with a new `x-clankermux-pi-prompt` value. A
pi-subagents child placed through herdr today puts its boundary text before
pi's head and is refused by the trigger check until the pi side moves it.

Continuations never run the policy: the live query keeps its prompt. A
resume or rebuild runs it again, and `snapshot: false` makes Claude Code
render that prompt rather than the stored one.

## Side requests

`x-clankermux-side-request: session-fork-v1` marks a client's auxiliary
request (pi's recap and session title: the main turn's body replayed with
its reply and one new prompt, `tool_choice: "none"`, a capped output) that
must not become the conversation's next turn. Only a bridged attempt acts
on it; on any other route the header does nothing.

- **Proxy.** One reading of the header, `sdkBridgeSideRequestMode`: null
  when absent, `""` when blank, which is a declaration and never an
  ordinary turn. It reaches the bridge as `SdkBridgeTurnMeta.sideRequest`,
  and a request carrying it never takes the continuation shortcut. Routing
  lets `tool_choice: none` through only for the exact value
  (`sdkBridgeRefusedField(body, { sideRequest })`), and skips the field
  refusal for any other value, so the bridge answers it with its own code.
- **Verification.** `ConversationStore.peek` reads `current` without the
  busy lock and changes nothing; it waits only for a session already
  settling, at most `settleWaitMs`. The body (`parseTurnBody`, which unlike
  a turn's parse requires no final user message) must be `current`'s
  messages plus exactly one user message (`messagesAfter`). A stored empty
  reply is nothing in the digests, and its replay an assistant message that
  normalizes away; it still ends the stored conversation. Nothing is
  rebuilt.
- **Run.** The `side_request` parse admits `tool_choice: none`. The query
  resumes a copy of `current` (`FileSessionStore.fork`) with the new message
  as its prompt and the replayed tools exactly as a turn would get them
  (same names, schemas, `allowedTools` and MCP server): `tools` open the
  cached prefix, and the history's `tool_use` blocks need them defined.
  Model, effort and `max_tokens` are as for any turn, and the system-prompt
  policy applies. It holds no claim and no conversation key, so it never
  registers, supersedes nothing and is superseded by nothing. The copy is an
  unregistered session and goes at close: success, failure, client
  disconnect or shutdown.
- **Tool calls.** `maxTurns: 1`, and every call gets an MCP error result at
  once ("Tools are disabled in a side request"); nothing parks and no
  `tool_use` reaches the client. A model message ending in a call settles
  the reply: its text is the answer (`end_turn`), and a call with no text
  is a 502 `sdk_bridge_side_request_tool_call`.
- **One model call.** A `max_tokens` stop settles the reply too, truncated,
  with `max_tokens` as its stop reason. Once the reply is settled the turn
  token is revoked, so a recovery call is refused before it spends output
  past the client's cap, and whatever Claude Code reports afterwards
  (`error_max_turns`, a failed call) leaves the turn as it was.
- **Accounting.** It counts against `maxProcesses`. Its row has
  `sdk_bridge_turns.kind = side_request` (`turn` otherwise), and the
  `sideRequests` counter counts it next to `turnsStarted`.

| Answer | When |
| --- | --- |
| 409 `sdk_bridge_side_request_no_session` | no session header, no completed turn stored, or its files gone |
| 409 `sdk_bridge_side_request_prefix_mismatch` | the history differs from the stored one, or anything other than one user message follows it: nothing, an assistant message, an unregistered main turn |
| 400 `sdk_bridge_side_request_unknown` | any other header value, a blank one included |
| 400 `invalid_request_error` | tool results in the new message |
| 502 `sdk_bridge_side_request_tool_call` | the model answered with a tool call and no text |

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
- **"Resumed session (account change)".** A matching history resumes even
  when the preferred account differs from the previous turn's; the turn
  records `rebuild_reason = account_change`. The resumed transcript sends
  thinking signed under the earlier account's org, which other orgs accept
  (production, 46 days: no signature 400 across 5 orgs). A rebuild would
  gain nothing: `/wire/openai` clients never return signed thinking.

## Monitoring and troubleshooting

Every finished turn logs one line, `SDK bridge turn <id> <status>`, whose
JSON payload has `"event":"sdk_bridge_turn"`: warn for `failed`,
`timed_out` and `expired`, info otherwise. It is logged only when the write
that finished the row landed, in the same queued step, so a finish that
lost to another path or was fenced out logs nothing. The step is not atomic
across SQLite and the journal: a crash between the commit and the log loses
the line, and the row stays authoritative. A finish write that throws logs
`"event":"sdk_bridge_turn_finish_failed"` at warn instead.

```
journalctl -u clankermux --since "-1h" -o cat --no-pager | grep '"event":"sdk_bridge_turn"'
```

The logger writes to the console, and so to the journal, only at
`LOG_LEVEL=DEBUG` (the `debug.conf` drop-in) or with `CLANKERMUX_DEBUG=1`.
Without either, lines go only to `$CLANKERMUX_LOG_DIR/app.log`, by default
`clankermux-logs/app.log` in the unit's private `/tmp`.

- `source`: `live` (the process that inserted the turn), `resumed_park` (a
  released park's resume) or `park_close` (a released park ended by expiry,
  supersession or recovery).
- `historyMode` / `rebuildReason`: `resume` continues the conversation's
  stored session; `rebuild_*` rebuilt it from the client's history, and the
  reason says why. `resume_extended` (always `continuation`, or
  `account_change`) is a history that is the stored conversation plus
  messages the client got elsewhere, typically another model's turns in
  pi: the stored session is forked and those messages are appended after
  its last assistant entry (`FileSessionStore.forkExtended`), so Claude
  Code replays its own bytes, date and model system messages included. A
  tail it cannot append (an open or foreign tool call, thinking, a
  transcript without a clean leaf) takes the full rebuild with the same
  reason. A post-compaction pi turn is `rebuild_transcript; reason=compaction`
  under a new `conversation_key_hash`: pi puts its summary first, which
  changes the key, and `compaction` then means a longer conversation is
  stored under the same client session. Without one it stays `unknown`.
- `firstCall`: `input`, `cacheRead` and `cacheCreation` of the query's first
  top-level model call, by message id, filled in from its `message_delta`
  and its assistant envelope. On a `resume` turn it should read almost the
  whole conversation from cache. `cacheRead: 0` with a large
  `cacheCreation` means the resumed prompt missed the cached prefix. On a
  `resume_extended` turn it should read the stored conversation's prefix
  (about what its last call read and wrote) and write the appended tail,
  so its read share is lower by design.
- `tokens`: Claude Code's own totals for the query, a cross-check. Billing
  truth is the inner `requests` rows.
- `legs`, `toolRounds`, `innerCalls`, `innerErrors`: the row's counters as
  written before the finish; `live` lines only.
- On `resumed_park` and `park_close` lines the identity comes from the
  park's resume descriptor and row: `model` is the id the client named,
  as on `live` lines, `historyMode` the turn's own decision (null for parks
  stored before it was kept), and `systemPromptPolicy` is null. A
  descriptor that cannot be read leaves the identity out.

Startup closes turns whose process is gone without listing them: one warn
line, `"event":"sdk_bridge_turns_closed"`, with `count`.

**Management API** on `127.0.0.1:8090`. Log in with
`curl -c jar -H 'content-type: application/json' -d '{"password":"…"}' .../api/auth/login`,
then pass `-b jar`:

- `GET /api/analytics/sdk-bridge-health?range=24h` (`1h`, `6h`, `24h`,
  `7d`, `30d`, `all`; default `7d`): counts by status, kind, history mode,
  rebuild reason, harness and account, error groups, timings, recent
  failures.
- `GET /api/sdk-bridge-turns/<turn id or leg request id>`: the row, its legs
  and its inner requests.
- `GET /api/system/status`: the `sdkBridge` block (see Resources).

**SQL**, read-only only. The path guard prompts on `~/.config`.

```
DB="file:$HOME/.config/clankermux/clankermux.db?mode=ro"

# Turns that did not complete in the last day
sqlite3 -header -column "$DB" "SELECT id, datetime(started_at/1000,'unixepoch','localtime') AS started, kind, status, http_status, error_type, substr(error_message,1,100) AS error FROM sdk_bridge_turns WHERE started_at >= strftime('%s','now','-1 day')*1000 AND status NOT IN ('completed','running','released') ORDER BY started_at DESC;"

# History mode and rebuild reason per day
sqlite3 -header -column "$DB" "SELECT date(started_at/1000,'unixepoch','localtime') AS day, kind, history_mode, coalesce(rebuild_reason,'-') AS reason, count(*) AS turns FROM sdk_bridge_turns WHERE started_at >= strftime('%s','now','-7 days')*1000 GROUP BY 1,2,3,4 ORDER BY 1 DESC, 5 DESC;"

# Each resumed turn's first inner call: MISS read nothing, LOW read under 80% of a >10k prompt.
# Plain resumes only: a resume_extended first call writes its appended tail by design.
sqlite3 -header -column "$DB" "WITH first AS (SELECT r.sdk_bridge_turn_id AS turn_id, r.status_code, r.input_tokens AS input, r.cache_read_input_tokens AS cache_read, r.cache_creation_input_tokens AS cache_creation, row_number() OVER (PARTITION BY r.sdk_bridge_turn_id ORDER BY r.timestamp, r.id) AS n FROM requests r JOIN sdk_bridge_turns t ON t.id = r.sdk_bridge_turn_id WHERE t.history_mode = 'resume' AND t.started_at >= strftime('%s','now','-7 days')*1000) SELECT f.turn_id, datetime(t.started_at/1000,'unixepoch','localtime') AS started, t.kind, t.status, f.status_code, f.input, f.cache_read, f.cache_creation, round(100.0*f.cache_read/nullif(f.input+f.cache_read+f.cache_creation,0),1) AS read_pct, CASE WHEN f.cache_read = 0 THEN 'MISS' WHEN f.input+f.cache_read+f.cache_creation > 10000 AND f.cache_read < 0.8*(f.input+f.cache_read+f.cache_creation) THEN 'LOW' ELSE '' END AS flag FROM first f JOIN sdk_bridge_turns t ON t.id = f.turn_id WHERE f.n = 1 ORDER BY t.started_at DESC;"

# Thinking-binding refusals (the upstream text is kept in requests.error_message, capped at 300 characters)
sqlite3 -header -column "$DB" "SELECT r.sdk_bridge_turn_id, datetime(r.timestamp/1000,'unixepoch','localtime') AS at, r.account_used, t.history_mode, t.rebuild_reason, t.status AS turn_status FROM requests r JOIN sdk_bridge_turns t ON t.id = r.sdk_bridge_turn_id WHERE r.status_code = 400 AND r.error_message LIKE '%bound to a different conversation%' ORDER BY r.timestamp DESC LIMIT 20;"

# Released parks, and who holds the park lease
sqlite3 -header -column "$DB" "SELECT p.turn_id, p.state, t.status AS turn_status, datetime(p.created_at/1000,'unixepoch','localtime') AS parked, datetime(p.expires_at/1000,'unixepoch','localtime') AS expires, p.file_bytes, json_array_length(p.awaited_tool_use_ids) AS awaited FROM sdk_bridge_released_parks p LEFT JOIN sdk_bridge_turns t ON t.id = p.turn_id ORDER BY p.created_at DESC;"
sqlite3 -header -column "$DB" "SELECT dir, pid, datetime(acquired_at/1000,'unixepoch','localtime') AS since FROM sdk_bridge_park_lease;"
```

**What normal looks like** (all 28 completed resumed turns stored on
2026-09-28, from 2026-09-24 on). Over each turn's inner calls, 96.5% of
prompt tokens were cache reads on average, 83.3% at the lowest. First calls
alone averaged 88%. Small conversations (4–6k tokens) read 68–77%, because
the new message is a large share of them. Two first calls read nothing at
15–19k tokens, each smaller than its previous turn's last call (3cd94fee on
09-24, a3e4dc27 on 09-28): that is the shape of a resume that missed its
cache, and neither is explained yet. No inner call had drawn a
thinking-binding refusal.

## Resources

Measured 220–270 MB RSS per Claude Code child (about 220 MB each with four
turns parked).
`sdk_bridge_max_processes` defaults to 8; parked queries count against it,
released ones do not (a resume needs a free slot, else 529).
`/api/system/status` reports live, parked, released, cap and peak RSS
(VmHWM), the session bytes and why parked turns are not being released.

Session files (generation sessions and released parks) are held under
`sdk_bridge_session_bytes_ceiling` (2 GiB, soft) by a periodic pass that
evicts idle conversations, least recently used first. When live and
released sessions alone exceed it, parked turns stay parked under the
parked timeout instead of being released; new turns are never refused. The
DB cleanup worker never deletes a `running`/`released` turn or one a park
still owns.

## Tests

- Unit tests inject a fake `queryFn` (`__tests__/fixtures/fake-sdk.ts`).
- Real-binary tests (`packages/claude-sdk-bridge/src/__tests__/real-claude.integration.test.ts`,
  `apps/server/src/__tests__/claude-sdk-bridge.integration.test.ts`) re-execute
  under `unshare -rn` with only loopback, assert 1.1.1.1 is unreachable, and
  talk to `fixtures/mock-upstream.ts`. Where user namespaces are unavailable
  (Ubuntu 24.04's AppArmor userns restriction) they skip with the reason
  printed. They never run with egress, and never against a real account.
  The mock binds each signed thinking block to the history before it and
  refuses a call whose history changed, as the API does.
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
