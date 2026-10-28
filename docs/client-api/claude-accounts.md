# Claude accounts from other clients

Only Claude Code reaches a Claude account (Anthropic OAuth or Claude API key)
directly: a request on `/wire/anthropic` from a client configured as Claude
Code that also identifies itself as Claude Code. No other request does,
`/wire/openai` (pi, Codex, OpenCode in OpenAI mode) included. When routing
picks a Claude account for one, ClankerMux runs real Claude Code for that turn
through the Claude Agent SDK, and Claude Code's model calls go to the account
through the normal pipeline. The client keeps executing its own tools: each
tool call is handed back to it, and its results resume the same Claude Code
run. Only Messages turns (`POST /v1/messages`) are served this way; such a
client's `count_tokens` and other requests go to other providers, or are
refused when the client may use no other.

There is nothing to configure beyond having the Claude models in the client's
catalogue, which follows from the client's allowed destinations. To keep a
client off Claude accounts, exclude the Anthropic providers in its
destinations.

What differs from a direct request:

* Claude Code's own system prompt is sent. For pi, pi's prompt is appended
  to it without pi's own opening, tool list, rules and documentation
  pointers; everything after those (project context files, skills,
  `APPEND_SYSTEM.md`, the working directory, extension sections and text
  extensions add) reaches the model unchanged. A replaced prompt
  (`SYSTEM.md`, a subagent persona) is sent whole. pi must declare its
  prompt layout with `x-clankermux-pi-prompt` (`0.87`, `0.99`, `1.0`, `1.2` or `1.3`); the
  layouts ClankerMux serves are listed at `clankermux.piPromptVersions` in the
  `/wire/openai/v1/models?clankermux_metadata=1` response. A pi turn is
  refused with a 400 rather than sent without your instructions when the
  header is missing or names another version
  (`sdk_bridge_prompt_unsupported`), when `</tools>`, `</rules>` or
  `</docs>` appears more than once or pi's opening lacks the sections that
  follow it (`sdk_bridge_prompt_malformed`), or when the forwarded text
  contains pi's opening line at the start of a line, or both `docs/custom-provider.md` and
  `docs/packages.md`, which subscription accounts answer with a 400
  (`sdk_bridge_prompt_refused`). OpenCode's, Codex's, oh-my-pi's and Qwen
  Code's system prompts are not sent. A client ClankerMux does not recognize
  (curl, an SDK, your own program), on a key whose application is generic or
  unset, has its system prompt appended unchanged.
* When a Claude account answers "You're out of extra usage" before any of the
  reply went out, the request moves on to destinations that are not Claude
  accounts (the next alias stage, or the rest of the pool), skipping the other
  Claude accounts. With none left, you get that 400. Once the reply has
  started streaming, the error ends the stream instead.
* `temperature` and `top_p` are ignored. Stop sequences (`stop`), a
  `tool_choice` that forces or forbids tool use, server tools (any tool
  with a `type` other than `custom`, such as Anthropic's web search) and
  `output_config.format` together with tools are rejected with a 400 naming
  the field, unless another destination in the route can serve the request.
* A client's auxiliary requests (pi's recap and session title) send
  `x-clankermux-side-request: session-fork-v1` with the conversation's session
  header, its history, and one new user message. They run on a copy of the
  conversation's Claude Code session, with its tools declared but every call
  refused (`tool_choice: "none"` is accepted here), so the conversation's
  next turn resumes as if they never happened. If the model still calls a
  tool, the text before the call is the answer; a call with no text is a 502
  `sdk_bridge_side_request_tool_call`. The answer is one model call's: a
  reply cut off at the output limit ends there, with stop reason
  `max_tokens`. Nothing is rebuilt for them: a conversation with no stored
  session gets a 409 `sdk_bridge_side_request_no_session`, and a history
  that is not the stored one plus one user message a 409
  `sdk_bridge_side_request_prefix_mismatch`. Another header value, a blank
  one included, is a 400 (`sdk_bridge_side_request_unknown`). On a route
  that is not served this way the header does nothing.
* `max_tokens` applies to each model call, not to the whole reply.
* Tool calls are not streamed: a model message's calls arrive whole once the
  message ends, and only when all of them completed. Text and thinking still
  stream.
* Each user turn starts a Claude Code process, which adds 1–3 s. A
  conversation resumes across turns only when the client sends a session
  header (pi does); otherwise each turn rebuilds it from the history.
* Each process uses about 250 MB of memory. At most 8 run at once
  (`sdk_bridge_max_processes` in `clankermux.json`); requests beyond that get
  a 529 with Retry-After.
* A Codex request whose model alias or fallback lands on a Claude account is
  answered by Claude through this path; that account is not skipped.
