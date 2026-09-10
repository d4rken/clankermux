# Routing table implementation and acceptance

Routing rules replace active combos and per-account model mappings. Existing legacy database rows remain inert for additive upgrades and historical request display; they are not imported into rules automatically.

## Destination isolation

A client API key permits one account, a list of providers, or the ordinary unpinned pool. The first enabled rule matching both the key and requested model wins. Its pool intersects the key's destinations and any global/header account selection. Responses requests also exclude official Anthropic destinations. An empty intersection fails locally; no later rule or model fallback widens it.

Targets are resolved once per request for each authorized account. Literal and requested-model rules terminate mapping. Default rules use the central provider defaults: Codex Fable/Mythos → `gpt-6-astra`, Opus → `gpt-5.6-sol`, Sonnet → `gpt-5.6-terra`, Haiku → `gpt-5.6-luna`; Qwen Claude families → `coder-model`; other models/providers retain the requested ID. Adapters preserve that target through format conversion. Retries and recovery waits retain the frozen route, and dispatch checks both current permission and the final serialized model.

## Account permissions

Each account authorizes its discovered IDs plus manual additions. Discovery uses that account's authenticated catalogue, never a shared or bundled list. Unsupported/custom backends can use manual IDs. Unknown, complete, and explicitly empty sets are distinct. Only an explicit account-pool literal rule can assert a model while discovery is unknown. Complete discovery or an explicit empty set removes that exception.

Backend, API key, or persisted identity changes invalidate evidence; ordinary OAuth token rotation does not. Refresh preserves manual IDs and the last good catalogue on failure. A generation check prevents an old refresh or editor save from overwriting a newer configuration. Request-triggered discovery is coalesced and bounded; background discovery runs at startup and approximately hourly. Definitive model rejection, including errors inside HTTP 200 event streams, temporarily suppresses only the exact account/model pair.

## Dashboard and API

The existing Models page is labeled **Client Models** (its `/models` URL is unchanged) and curates the model catalogue presented to harnesses. It does not authorize account destinations. The Routing page has its own `/routing` URL. The Routing tab supports rule creation, editing, enable/disable, deletion, and ordering. Account “Permitted models” shows discovery status and edits manual IDs. API key “Allowed destinations” controls the isolation boundary. Request details include routing attempts and the frozen rule snapshot, separating requested, resolved, outgoing, and upstream-reported models. Failed attempts do not create duplicate usage rows. Raw-response model observation is bounded; an unavailable reported model remains null.

Admin endpoints:

- `GET/POST /api/routing-rules`, `PUT/DELETE /api/routing-rules/:id` (new rules append atomically)
- `PUT /api/routing-rules/reorder` with `{ "ids": ["..."] }`
- `GET/PUT/POST /api/accounts/:id/model-permissions` (POST refreshes)
- `GET /api/requests/:id/attempts`

Account/key deletion is refused while routing or destination settings reference it. Request retention deletes its attempts and unused snapshots. Parentless attempts, including internal/local operations, are pruned after a day.

## Acceptance sequence

1. Create an experiment API key with providers `codex` and `openrouter`. Ensure the chosen Codex account permits `gpt-6-astra`.
2. Add a rule matching that key and exact requested Fable 5.1 ID, pooling Codex, with literal target `gpt-6-astra`. Verify the exact ID emitted by the installed Claude Code version.
3. Run real Claude Code against the proxy with the experiment key. Check normal text, streaming, tool use/results, cancellation, and count_tokens. Inspect request attempts for destination and model integrity.
4. Change the rule to OpenRouter and literal `deepseek/deepseek-v4-pro` (or another account-permitted model), after adding/discovering that ID on the OpenRouter account. Repeat the same checks.
5. Exercise Codex and optionally OpenCode through the Responses-compatible ingress with the same destination restriction.

Automated acceptance uses mocked upstreams. Live results below use an isolated branch server; deployment remains a separate operation. Automated inference must not exercise official Anthropic accounts. The authenticated local `HEAD /api/hello`, Messages, count_tokens, and local models surfaces remain available.


## Live acceptance — 2026-09-10

Executed from `cnc` with Claude Code 2.1.266 and Codex 0.153.4, using their underlying binaries and temporary settings. The branch server listened on local port 8081, reached through an SSH reverse tunnel on `cnc` port 18081. Its separate database contained only Codex and OpenRouter accounts and an experiment key pinned to those providers. No official Anthropic account was present. Production redeployments do not change this server, database, or tunnel. The tests do share provider quotas; the lab copied only the unexpired Codex access token, never its rotating refresh token.

| Path | Result |
| --- | --- |
| Claude Code requesting Fable 5.1 → Codex Astra | Streaming text, real Read tool, and session resume passed with the reported model `gpt-6-astra`; both bare and normal settings-isolated runs passed. |
| Codex requesting Astra → Codex Astra | Native Responses shell execution and resume passed. |
| Claude Code requesting Fable 5.1 → OpenRouter DeepSeek V4 Pro | Real Read and resume passed with normal Claude Code, default high effort, and no test budget flag. Low-effort runs executed Read but wandered into unrelated tool calls and exhausted the four-turn limit. |
| Codex requesting Astra → OpenRouter DeepSeek V4 Pro | Translated custom execution tool ran `cat fixture.txt` and returned the real nonce; session resume passed. The model recovered from an initial tool-input mistake. |
| Switching an existing Astra conversation to DeepSeek | Codex resume passed. Claude Code received an upstream refusal; its UI attributed that refusal to the requested Fable model. This is not a successful cross-provider Claude continuation. |
| Metadata/auth | Authenticated hello HEAD returned 204, models returned 200, missing credentials returned 401, and an unpermitted model failed locally with 403. |
| Token counting | Codex returned a local successful count with no upstream send. OpenRouter returned 404 for count_tokens; that optional endpoint is unavailable on this tested route. |
| Nonstreaming | Astra and DeepSeek returned successful JSON with the actual destination model and nonzero token usage. |
| Large request | One 1,056,867-byte synthetic Astra request completed in 5.47 seconds (154,472 input tokens). This is a single sample, not a load benchmark. |
| Cancellation | Real Claude Code interruption before first text canceled the Astra request. A direct streaming DeepSeek request received text and then disconnected at 1.414 seconds; the upstream attempt ended one millisecond later. A real Claude Code after-text upstream abort was not established. |

The tool fixture contained `ROUTING_TOOL_NONCE=violet-cedar-731`. Success required observed tool execution and that value, not just a zero CLI exit status. Raw Claude message-start events reported the destination model, and Claude accepted them; no response-model alias was added. OpenCode was absent during this first round; its later acceptance results are recorded below.

Muse was unavailable under the OpenRouter account's allowed-provider policy. The user selected testing an alternative instead of changing that policy; DeepSeek V4 Pro was present in the account-authenticated catalogue. The account's provider allowlist was not changed.

### Corrections from live testing

- Preserve OpenRouter provider-policy errors, including their actionable upstream 404 body, rather than misclassifying them as model entitlement failures. They do not suppress model membership. Genuine model-rejection terminal messages identify the resolved targets and include the requested alias separately.
- For OpenRouter destinations outside `anthropic/*` and `claude-*`, apply effort-only system-message configuration updates to the current top-level output configuration in conversation order. Preserve message text, role, position, and other fields. Anthropic targets remain byte-preserving. Unknown controls, malformed top-level configuration, and non-JSON bodies remain unchanged for upstream validation.
- Translate Responses `additional_tools` conversation items, namespaced functions, and custom tools. Deterministic names preserve namespace and tool kind across tool choices, history, streaming, nonstreaming, and resume. Custom tools use an `{input: string}` JSON representation and return to Codex as raw custom-tool input. The requested grammar is included as descriptive guidance; constrained decoding is unavailable through this translation. Malformed returned custom arguments fail the response rather than becoming empty successful calls. Nested tool namespaces are explicitly unsupported and return a tagged client error. Native Codex payloads remain unchanged.
- Responses translation exposes the upstream-reported model when available instead of substituting the requested alias.

### Remaining limits

Token usage was retained with non-Claude model IDs. Cost is still the existing local catalogue estimate, not OpenRouter's invoice amount. Several cached DeepSeek responses have a null cost because the local catalogue lacks a cache rate, although OpenRouter supplies `usage.cost`; successful uncached responses have nonzero estimates. This is a pricing limitation, not a reason to relabel model identity.

These checks demonstrate routing and harness compatibility for the tested versions and cases. They do not guarantee model instruction-following quality, acceptance of every resumed conversation, every Responses built-in tool, or support for every provider-specific extension. The original model-routing isolation and exact serialized-model checks remain in force on all sends.

### Isolation and cleanup

The final production check found zero matching test request IDs and zero requests under the experiment key. After exporting sanitized harness summaries, attempts, and usage, the owned branch server and SSH tunnels were stopped. The temporary account database (including copied credentials and raw payloads), experiment key, and remote test directory were deleted. The feature worktree and partner remain available. No production deployment, commit, merge, or push was performed.

### Final validation

- Backend/unit suite: 9,869 passed, zero failures, 622 files (149.62 seconds), before the final malformed-input guards from partner review.
- Dashboard DOM suite: 143 passed, zero failures, 20 files.
- Lint, then TypeScript checking: passed.
- Production build and `git diff --check`: passed.

One earlier suite invocation omitted Bun from the subprocess PATH; its sole failure was the logger import-order subprocess failing to locate `bun`. The complete rerun above used the correct PATH and passed.

After the final partner-review input guards, the affected adapter, OpenRouter, routing, audit, and model-error suites passed again: 198 tests, zero failures, 11 files. Lint followed by type checking and the whitespace check also passed again. The guards leave valid live-tested requests unchanged.


## Pi and Oh My Pi acceptance — 2026-09-10

Installed persistently on `cnc`:

- Pi **0.85.1**, current official package `@earendil-works/pi-coding-agent`, in `~/.local/share/pi-cli`, available as `~/.local/bin/pi`. Installed with the project's recommended `--ignore-scripts`; Node 24.21.0 was already available.
- Oh My Pi **18.1.16**, official standalone `omp-linux-x64` release, in `~/.local/opt/omp/18.1.16`, available as `~/.local/bin/omp`. The download matched the release's SHA256SUMS; no separate Bun installation was needed.

A new temporary database and reverse tunnel recreated the isolated branch lab. Only Codex and OpenRouter accounts were copied; Codex refresh credentials and API-key fallback were absent. Both harnesses used a minimal environment, separate `PI_CODING_AGENT_DIR` directories, temporary sessions and work directories, disabled extensions/skills, and only `read`, `write`, `edit`, and `bash`. Neither harness received an upstream provider credential. The lab client key permitted only Codex and OpenRouter. Missing authentication returned 401, and an unprovisioned model returned the branch-specific local 403 before any upstream send.

Both harnesses support explicit custom-provider APIs `anthropic-messages` and `openai-responses`. Tested client configuration:

| Setting | Messages | Responses |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:18081/wire/anthropic` | `http://127.0.0.1:18081/wire/openai/v1` |
| `api` | `anthropic-messages` | `openai-responses` |
| Requested model | `claude-fable-5-1` | `gpt-6-astra` |

Pi reads `models.json` and uses `"apiKey": "$ROUTING_EXPERIMENT_KEY"` for environment interpolation. Oh My Pi reads `models.yml` and uses `apiKey: ROUTING_EXPERIMENT_KEY` (environment-name-or-literal semantics). Both configurations supplied a custom model row with text input, reasoning enabled, a 200,000-token context limit and 4,096-token output limit; tests selected low thinking. These are local client settings, not discovered backend capabilities. The test URLs require the temporary reverse tunnel; the installed binaries remain available after lab cleanup, while test credentials and configurations do not.

### Additional compatibility corrections

- Accept Responses easy input messages whose `type` is omitted, and string message content. Previously these valid Pi/Oh My Pi messages were dropped: DeepSeek received an empty messages array, causing a 400 or a system-only response. User/assistant text and tool history now survive translation; system/developer text is lifted into the Anthropic system prompt using the existing instruction ordering. Native Responses bodies retain the original message shape.
- Routing audit now recognizes a fully framed successful terminal event before HTTP EOF. Pi and Oh My Pi close native Responses connections after `response.completed`; those successful calls previously acquired a false stream-failure audit error. Declared protocol failures, incomplete responses, and interrupted pre-terminal streams still record errors. Oversized SSE events are skipped within the observation bound without disabling inspection of subsequent events.

The regression tests first reproduced both defects. Coverage includes omitted message types, string content, instruction roles, function-tool history, unchanged native context, split/CRLF SSE framing, cancellation after completion, real failure/incomplete events, pre-terminal truncation, and a complete event following an oversized one.

### Results after the corrections

| Harness | Interface | Astra via Codex | DeepSeek V4 Pro via OpenRouter |
| --- | --- | --- | --- |
| Pi 0.85.1 | Messages | Read, resume, write/read/edit/bash passed | Read, resume, write/read/edit/bash passed |
| Pi 0.85.1 | Responses | Read, resume, write/read/edit/bash passed | Read, resume, write/read/edit/bash passed |
| Oh My Pi 18.1.16 | Messages | Read, resume, write/read/edit/bash passed | Read, resume, write/read/edit/bash passed |
| Oh My Pi 18.1.16 | Responses | Read, resume, write/read/edit/bash passed | Read, resume, write/read/edit/bash passed |

Each read test used a new random nonce absent from the prompt; resume had to recall it from saved history. Coding required observed calls to all four tools, changing a Python file from `print(7 + 5)` to `print(11 + 5)`, executing it, and reporting the observed result `16`. All eight combinations passed on the corrected server. Native Responses audit errors disappeared on the successful reruns.

Both harnesses also passed Astra-to-DeepSeek continuation on both interfaces: they recalled the original nonce from an Astra history and read a new fixture through DeepSeek. An initial test incorrectly put that fixture in the runner's new working directory; both harnesses restore the session's original working directory. The corrected tests restored the pre-switch history and placed the new fixture there. The initial file-not-found runs are retained separately in evidence and are not counted as passing continuation cases.

Model display belongs partly to the harness: Pi Messages reported the returned upstream model, while Oh My Pi Messages retained the configured Fable name; both Responses clients retained the configured Astra name in their own events. Proxy attempts independently recorded the actual upstream model and matched the requested/resolved/outgoing destination. Client labels therefore do not prove which provider ran the request.

These are bounded compatibility checks, not a coding-quality benchmark or an exhaustive test of every harness extension, model, history shape, or provider. No Chat Completions endpoint was added. The earlier OpenRouter pricing and optional token-counting limitations remain.

Validation after these changes: **9,891 backend tests passed across 622 files**, **143 DOM tests passed across 20 files**, lint followed by type checking passed, and the production build passed. The focused adapter/audit run passed 173 tests across eight files. No commit, merge, push, or production deployment was performed.

After-text process interruption was established for Pi Responses → Astra, Pi Messages → DeepSeek, and Oh My Pi Responses → DeepSeek. Their upstream attempts ended 3, 3, and 13 ms after the recorded SIGTERM respectively. These are CLI process-interruption checks, not interactive keyboard tests. For Oh My Pi Messages → Astra, both attempted after-text interruptions arrived after the upstream had already completed; this combination's active after-text cancellation remains unproven. Those completed calls correctly retained successful audit outcomes.

Sanitized evidence is retained at `/tmp/routing-pi-evidence-20260910/` (49 harness summaries, 105 request/attempt records, usage, outgoing request shapes, and isolation checks). All 104 upstream sends matched their resolved models and used only Codex or OpenRouter. Production contained zero matching test request IDs and zero requests under the lab key. The branch server and reverse tunnel were stopped; the local temporary credential database and remote test keys, profiles, sessions, and fixtures were deleted. The two installed harness binaries remain available on `cnc`; existing Claude Code and Codex settings were not changed.

## OpenCode acceptance and permanent setup — 2026-09-10

Installed OpenCode **1.18.30** on cnc from the official opencode-ai npm package under ~/.local/share/opencode-cli, available as ~/.local/bin/opencode. The platform installer was inspected before running it; it selected and verified the installed native binary. Automatic updates were disabled for reproducible testing and in the permanent configuration.

The branch lab was recreated with a separate database, a loopback reverse tunnel, only Codex/OpenRouter accounts, an experiment key pinned to those providers, and manually permitted Astra/DeepSeek targets. Codex refresh credentials and API-key fallback were absent. OpenCode used isolated XDG config/data/cache/state directories, a minimal environment, disabled plugins/project configuration, and permissions for read/edit/bash only. Its write and apply_patch tools fall under edit permission. Session sharing was disabled in the lab.

OpenCode explicitly selects the supported wire formats through its SDK package:

| Interface | Provider package | Lab baseURL | Requested model |
| --- | --- | --- | --- |
| Messages | @ai-sdk/anthropic | http://127.0.0.1:18081/wire/anthropic/v1 | claude-fable-5-1 |
| Responses | @ai-sdk/openai | http://127.0.0.1:18081/wire/openai/v1 | gpt-6-astra |

The @ai-sdk/openai-compatible package selects Chat Completions and is unsuitable for this proxy mount. Actual requests confirmed Responses selection, real tools, and replayed conversation history rather than dependence on previous_response_id.

| Destination and interface | Read and resume | Coding task | Astra-to-DeepSeek continuation |
| --- | --- | --- | --- |
| Astra / Messages | Passed | Passed with write/read/edit/bash | — |
| Astra / Responses | Passed | Passed with apply_patch/read/bash | — |
| DeepSeek / Messages | Passed after client thinking opt-out | Passed after client thinking opt-out | Passed after client thinking opt-out |
| DeepSeek / Responses | Passed | Initial failure; guided rerun passed | Passed |

Reads used fresh random nonces absent from the prompt; resume recalled the saved nonce. Cross-provider continuation also read a new fixture. Coding required actual creation and editing of calculation.py and execution yielding 16, not merely a successful tool status.

### Client compatibility and quality limits

OpenCode automatically adds Fable 5.1 thinking-binding controls because of the requested model name. DeepSeek rejected the resulting thinking.block_binding field with HTTP 400. The existing proxy preserved that actionable provider restriction and did not suppress model permission. OpenCode's own opt-out fixed the request:

    provider.routing.models["claude-fable-5-1"].options.thinking =
      { "type": "adaptive", "blockBinding": false }

The successful outgoing body retained thinking.type=adaptive and omitted block_binding. No proxy source change or automatic stripping was needed. This option matters for Fable-alias Messages experiments against targets that reject the extension; the permanent Responses/Astra configuration does not emit it. Astra had accepted the original Messages test path.

DeepSeek's first Responses coding run produced two invalid apply_patch hunks, followed by a malformed patch that OpenCode reported as Success despite making no change. The actual script returned 12, and the test correctly failed. A separate bounded rerun with explicit guidance that a hunk header must be exactly @@, plus a final file read, applied the edit and returned 16. This is a model/tool-format limitation; it is not evidence of lost proxy payloads or an unconditional coding-quality pass.

On DeepSeek Messages, SIGINT after the first step_start event closed the upstream attempt 31 ms later. Responses did not settle after the first interrupt: both the SIGTERM and SIGINT trials required the runner's second termination signal after ten seconds, with upstream completion around 10,027/10,029 ms after the first signal. These headless CLI process-interruption checks do not prove interactive keyboard cancellation or after-text cancellation. Prompt first-interrupt cancellation on the tested Responses path remains open.

### Evidence, production setup, and cleanup

Sanitized lab evidence is retained in /tmp/routing-opencode-evidence-20260910/: 22 harness summaries, 53 requests/attempts, outgoing shapes, usage, and isolation checks. All 52 upstream sends matched their resolved models and used only Codex or OpenRouter. No lab request ID or experiment-key request appeared in production; all lab attempts finished. Original failures are retained separately from successful reruns.

After lab testing, the permanent production key **cnc (opencode)** was created with provider pins **codex + openrouter**. Its secret is stored only in ~/.config/clankermux/opencode.key on cnc (mode 0600); ~/.config/opencode/opencode.json references that file, uses @ai-sdk/openai at http://clankermux.greenkingdom:8080/wire/openai/v1, allows only the custom ClankerMux provider, and defaults both model and small_model to clankermux/gpt-6-astra. The normal CLI is available as opencode. No lab permission overrides were copied into the permanent configuration.

A separate intentional production smoke test used the saved configuration without model/provider overrides. It returned OPENCODE_PRODUCTION_OK, HTTP 200, from Codex-2 / gpt-6-astra. The running fc577c7a release's independent Responses exclusion of official Anthropic destinations was checked in its actual source, including the global-force path. The routing redesign was not deployed; this production check covers the existing native Responses route and new key/config only. Existing Claude Code, Codex, Pi, and OMP keys/configurations were unchanged.

The lab server and tunnel were stopped and their closed ports verified. Temporary local account credentials, remote test profiles/sessions/fixtures, and local copies of the new production secret were removed. OpenCode and its permanent production configuration remain installed.

This follow-up changed only the acceptance report in the repository; no proxy source changes were needed. The earlier 9,891 backend / 143 DOM validation remains the latest full-suite result. Live results, including failed cases and remaining limits, are recorded above. git diff --check passed; no commit, merge, push, or deployment was performed.
