# Model cache policy

Client-key discovery can opt into metadata using
`GET /wire/openai/v1/models?clankermux_metadata=1` or
`GET /wire/anthropic/v1/models?clankermux_metadata=1`.
Read `data[i].clankermux.cachePolicy`. The Codex discovery shape selected by
`client_version` uses `models[i].clankermux.cachePolicy`.
The native response without the opt-in parameter is unchanged.

```ts
interface ModelCachePolicy {
  mode: "explicit" | "implicit" | "none" | "unknown";
  defaultTtlMs?: number;
  supportedTtlMs?: number[];
  refreshOnReuse?: boolean;
  expiry: "unavailable" | "estimated" | "exact";
  source: "gateway-policy" | "unknown";
  ttlAnchor?: "request_start" | "request_end" | "unknown";
  ttlSemantics?: "configured" | "minimum" | "typical" | "unknown";
}
```

`implicit` means the documented route offers automatic caching. `explicit`
means caching uses explicit breakpoints supplied by the client or gateway. On services with both modes,
discovery describes the automatic default; an explicit request can have a
different lifetime. Policy does not establish that any particular prompt was
cached, and a model's cache prices do not establish retention.

`defaultTtlMs` describes the documented default for that mode, conditional on
a cache write or reuse. `supportedTtlMs` lists selectable values that survive
the gateway's request conversion. A fixed default can be known even when the
client cannot select a TTL. OpenAI discovery does not distinguish Responses from Chat Completions, whose
translator does not accept TTL controls. It therefore omits selectable OpenAI
TTLs even on Codex-adapter routes that can pass native Responses through.

`configured` describes a specified lifetime, `minimum` a lower bound rather
than an eviction deadline, and `typical` an observation in provider documentation
that cannot support a verified expiry estimate. Missing fields remain unknown.
Advisory `cacheRetention` metadata below can still provide a labelled display window.
`expiry: "unavailable"` can coexist with a TTL when the timestamp anchor is
undocumented. No route currently reports `exact` expiry.

Each alias is resolved against every eligible account and its effective target
model. Only agreeing fields survive. Selectable TTLs are intersected, not
combined. An unknown route prevents borrowing a verified route's policy.
Unresolved permissions, missing routes, and enrichment timeouts still leave
policy absent. A resolved but unverified route returns:

```json
{"mode":"unknown","expiry":"unavailable","source":"unknown"}
```

No policy response contains account IDs, endpoints, routing details, thinking
levels, or session state. Discovery metadata is neither persisted nor shared
with clients that cannot discover the model.

## Built-in provider coverage

Coverage and sources checked on 2026-09-18. These are caching capabilities,
not cache-hit guarantees. Unrecognized models do not inherit a familiar model's
TTL. Known Claude aliases and dated OpenAI IDs resolve to their documented
family policy.

| Provider | Published policy | Lifetime information |
|---|---|---|
| Anthropic / Claude Console API | Explicit for known Claude IDs and aliases on Anthropic ingress | 5-minute default, 5-minute/1-hour choices, refresh on reuse, request-start anchor, minimum semantics, estimated expiry. |
| Codex subscription | Implicit for known GPT and reasoning model families, through either wire dialect | Retention unavailable. OpenAI API retention is not a contract for the ChatGPT subscription backend. |
| OpenAI-compatible | Resolve verified official API endpoints and model families, as below | Arbitrary custom origins remain unknown. The adapter's actual default is the direct OpenAI API. |
| Anthropic-compatible | Resolve explicitly configured official Anthropic, OpenRouter, MiniMax, Z.ai, xAI and DeepSeek endpoints | A missing endpoint remains unknown because runtime provider configuration can replace the default. |
| Z.ai | Implicit for GLM language models | No fixed TTL documented. |
| MiniMax | Implicit for M2.1/M2.5/M2.7/M3 and documented highspeed variants; explicit for M2/M2-Stable on Anthropic ingress | Automatic retention depends on load. Explicit M2 uses five minutes and refreshes on hits, but has no documented request-start/end anchor. |
| Grok / xAI | Implicit for Grok language model families | Entries may be evicted at any time; no numeric lifetime. |
| OpenRouter | Model-specific: Claude explicit on Anthropic ingress; OpenAI, DeepSeek, GLM, Grok, Kimi and Gemini 2.5+ implicit; selected Qwen IDs explicit | Claude 5-minute/1-hour choices; OpenAI modern API minimum where documented; no common request timestamp anchor. Router aliases such as `openrouter/auto` remain unknown. |
| Kilo | Unknown | Client-side caching documentation does not establish a gateway-wide model policy. |
| Alibaba Coding Plan | Unknown | The subscription endpoint does not publish the general Model Studio API's cache contract. |
| Qwen OAuth | Unknown | OAuth and the API-key product have distinct contracts. |
| Ollama | Unknown | `keep_alive` controls model residency, not prompt-prefix retention; versions and backends vary. |
| Ollama Cloud | Unknown | No substantiated prompt-cache lifetime contract. |
| MiMo Token Plan | Unknown | The Token Plan endpoint publishes no prompt-cache lifetime contract. |
| Devin | Unknown | Cache usage counters do not establish a policy for its Codeium endpoint. |

Anthropic cache controls are lost in OpenAI-to-Anthropic translation, so those
translated routes remain unknown rather than advertising usable explicit TTLs.
Fixed-endpoint providers such as Z.ai, MiniMax and Grok ignore stored custom
endpoint values; inert values do not change their policy.

## Official compatible endpoints

Endpoint matching requires the exact HTTPS origin and supported API base path.
Lookalike domains, nonstandard ports, credentials, query strings and unrelated
paths do not inherit policy. Generic endpoint configuration does not make an
arbitrary service OpenAI or Anthropic.

| API | Recognized base | Model scope and policy |
|---|---|---|
| OpenAI | `https://api.openai.com` or `/v1`; Codex adapter with exact `/v1/responses` | GPT-5.6/Sol/Terra/Luna and GPT-6 Astra/Sol/Luna: automatic, 30-minute minimum, refreshed on reuse. Earlier supported GPT/o-series: automatic with typical retention, no numeric default. No documented request-start/end anchor, so no countdown. |
| DeepSeek | `https://api.deepseek.com` or `/v1`; Anthropic-compatible `/anthropic` | DeepSeek chat/reasoner and language model families: automatic, no fixed lifetime. |
| Moonshot | `https://api.moonshot.ai` or `/v1` | Kimi and Moonshot families: automatic, no documented lifetime. |
| Groq | `https://api.groq.com/openai/v1` | Only `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `openai/gpt-oss-safeguard-20b`: automatic, two hours without use. Anchor unknown, expiry unavailable. |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | Gemini 2.5/3 language model families: automatic, no implicit TTL. Explicit cache objects are a separate API capability. |
| DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1`, `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, and Beijing/Singapore workspace domains | Legacy Beijing Qwen routes use gateway-injected explicit caching on verified IDs: five minutes, refreshed on reuse, anchor unknown. Other covered routes use the exact shared regional implicit-caching list, with no numeric lifetime. |
| xAI | `https://api.x.ai` or `/v1` | Same language-model policy as the Grok provider. |
| Z.ai | `https://api.z.ai/api/paas/v4` or `/api/coding/paas/v4` | Same automatic GLM capability, no TTL. |
| MiniMax | `https://api.minimax.io` or `/v1` | Documented automatic M2.1/M2.5/M2.7/M3 models, no fixed TTL. |
| OpenRouter | `https://openrouter.ai/api/v1` | Same model-specific coverage as its built-in provider. |
| Mistral and other endpoints | Unverified | Mistral documents an optional cache key but not model coverage or lifetime. No policy is inferred from that parameter alone. |

The DashScope scope uses exact published model IDs because regional lists
differ. The legacy Beijing adapter injects explicit breakpoints, so
`qwen3.6-plus` and `qwen3-coder-plus` publish a five-minute explicit policy there.
On Singapore and workspace origins, the gateway does not inject those
breakpoints: `qwen3-coder-plus` has implicit caching, while the explicit-only
listing of `qwen3.6-plus` does not establish implicit caching. Coding Plan and
Qwen OAuth never inherit these API policies.
OpenRouter's ten-minute sticky-routing timeout is also not a prompt-cache TTL.

## Advisory retention estimates

Read `data[i].clankermux.cacheRetention` (or
`models[i].clankermux.cacheRetention` in Codex discovery) alongside `cachePolicy`.
Every enriched model receives an advisory estimate, including unfamiliar models
and unresolved routes. An enrichment timeout still returns `clankermux: {}`.
Estimates never change verified policy, routing, cache bridging or paid background
requests. They are display advice, not selectable upstream TTLs.

```ts
interface ModelCacheRetention {
  basis: "documented" | "inferred" | "heuristic";
  retentionMs: number;
  typicalRangeMs?: [number, number];
  semantics: "configured" | "minimum" | "typical" | "heuristic";
  confidence: "high" | "medium" | "low";
  anchor: "request_start" | "request_end";
  anchorBasis: "documented" | "assumed";
  refreshOnReuse: boolean;
  refreshBasis: "documented" | "assumed";
  sources: Array<{ url: string; note: string }>;
  note: string;
}
```

`basis` describes the numerical duration's provenance. `documented` means the
source applies to the resolved service and model; it does not guarantee a future
hit. `inferred` borrows another product's documented behavior or interprets a
qualitative range. `heuristic` is a gateway display default with no supporting
numerical evidence. Unsourced heuristics have an empty `sources` array.
`anchorBasis` and `refreshBasis` independently disclose timing assumptions.
Confidence describes the quality of the evidence, not a calibrated probability
of a hit. A documented duration with an assumed anchor is still an estimate.

| Applicable service/model | Display window | Basis |
|---|---|---|
| Known Anthropic explicit caching | 5 minutes, request-start anchor | Documented minimum; promotion can retain longer |
| Modern direct OpenAI API models | 30 minutes | Documented minimum after write/reuse; request-start anchor assumed |
| Codex GPT-5.6+ and GPT-6 Astra/Sol/Luna | 30 minutes | Inferred from OpenAI API documentation; subscription applicability and refresh unverified |
| Earlier OpenAI / Codex models | 5 minutes, typical range 5–10 minutes | Documented API behavior or inferred subscription behavior; account retention settings may differ |
| Supported Groq GPT-OSS models | 2 hours | Documented inactivity period; request-start anchor assumed |
| Known MiniMax/DashScope explicit caching | 5 minutes | Documented duration; request-start anchor assumed |
| OpenRouter Gemini implicit caching | 3 minutes, typical range 3–5 minutes | Documented typical behavior; refresh and request-start timing assumed |
| Direct Gemini implicit caching | 3 minutes, typical range 3–5 minutes | Inferred from OpenRouter's description; applicability unverified |
| DeepSeek direct/API routes and OpenRouter DeepSeek | 1 hour | Inferred from “hours to days”; one hour is not a documented minimum |
| Z.ai, Grok, Kimi, automatic MiniMax/DashScope, Qwen OAuth, Alibaba Coding Plan, Ollama, Ollama Cloud, Kilo, Devin, Mistral, arbitrary compatible services and all other models | 5 minutes | Low-confidence gateway heuristic; numeric lifetime and sometimes caching availability unverified |

Unknown or conflicting routes cannot borrow a verified policy. Their advisory
estimate instead uses the shortest candidate window and the weakest evidence
classification, with low confidence and a note explaining uncertainty. If route
eligibility cannot be resolved, use only the generic heuristic. Source text in a
combined estimate may describe only some requests. No estimate contains account
IDs, custom endpoints, route listings or session state.

## Client display and observations

A Codex-routed `gpt-6-astra` retains its verified policy:

```json
{"mode":"implicit","expiry":"unavailable","source":"gateway-policy"}
```

Its separate `cacheRetention` now supplies `retentionMs: 1800000`,
`basis: "inferred"`, `confidence: "low"`, the OpenAI documentation URL and a note
that API retention is being borrowed for the subscription backend. Display
“Estimated retention: 30 minutes (inferred from OpenAI API; Codex unverified)”.
Do not present that duration as a verified default TTL or exact expiry.
Clients must parse the new field to show it; a client that only reads
`cachePolicy.defaultTtlMs` will still display unknown.

Keep observations in client memory, separate from discovery and persistence.
`SessionCacheEstimate` and `readCacheUsage` in
`packages/core/src/session-cache-estimate.ts` provide a tested client reference.
They have no server-side session store or background activity. Supply opaque
identities for provider, model, session, branch, prefix, tools/system prompt and
route policy. Changing any identity or retention metadata resets the estimate.
Capture a request handle before sending; responses arriving after a reset or an
already observed newer request cannot revive stale state. Do not persist prompt
prefixes or upstream cache keys.

Read the merged final usage object from the existing stream result:

| Wire format | Read evidence | Write evidence |
|---|---|---|
| Anthropic | `cache_read_input_tokens` | `cache_creation_input_tokens` |
| Responses | `input_tokens_details.cached_tokens` | `input_tokens_details.cache_write_tokens` (legacy `cache_creation_input_tokens` fallback) |
| Chat Completions | `prompt_tokens_details.cached_tokens` | `prompt_tokens_details.cache_write_tokens` |
| Native DeepSeek | `prompt_cache_hit_tokens` | Unavailable unless separately supplied |
| Native Gemini | `cachedContentTokenCount` | Unavailable unless separately supplied |

`prompt_tokens_details.cache_write_tokens` is a ClankerMux extension to Chat
Completions, not a standard OpenAI Chat field. On Anthropic-shaped Codex
responses, unknown cache counters are `null`; translated Responses/Chat
counters are omitted when unknown. Neither representation means zero.

A positive cache read proves some prefix was reused on that request. Display
its token count; never claim the whole current context is warm. A positive
write supports `warm_write`. Missing counters mean unknown, not zero. Cache
creation alone cannot prove expiry. Even an explicit zero read followed by a
write for a previously warm, comparable prefix only establishes that the prefix
was unavailable on that request; eviction and account routing remain possible.
The reference tracker never reports `expired`.

A write starts a new advisory window. A hit updates it only when
`refreshOnReuse` is true, retaining the documented/assumed label. No usage,
uncached prompts, prompt submission alone and cache prices do not refresh it.
For a non-refreshing cache, a read alone cannot reveal when its entry was created.
A later explicit zero read clears an old window unless a new write is observed.
A positive hit/write does not promote the static retention estimate's provenance
or establish a measured lifetime.

`estimatedUntil` is the request anchor plus `retentionMs`, in epoch milliseconds.
Show “estimated warm window remaining”, not “context expires in”. At the end of
the window the state becomes `unknown`, never proven expired. Gateway background
refreshes, routing and prefix changes can invalidate the estimate at any point.
Keep Pi's existing conservative ReCAP/autotitle gate unchanged.

## Sources

- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) and [Codex pricing and cache usage](https://developers.openai.com/codex/pricing)
- [Z.ai context caching](https://docs.z.ai/guides/capabilities/cache)
- [MiniMax automatic caching](https://platform.minimax.io/docs/api-reference/text-prompt-caching) and [explicit caching](https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache)
- [xAI cache behavior](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices)
- [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache)
- [Moonshot/Kimi context caching](https://platform.kimi.ai/docs/guide/use-context-caching-feature-of-kimi-api)
- [Groq prompt caching](https://console.groq.com/docs/prompt-caching)
- [Gemini caching](https://ai.google.dev/gemini-api/docs/caching) and [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
- [Alibaba context caching](https://www.alibabacloud.com/help/en/model-studio/context-cache) and [Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan)
- [Qwen Code cache reporting](https://qwenlm.github.io/qwen-code-docs/en/users/features/token-caching/)
- [Ollama model residency](https://docs.ollama.com/faq), [prefix-cache implementation](https://github.com/ollama/ollama/blob/main/mlxrunner/prefix_cache.go), and [Cloud](https://docs.ollama.com/cloud)
- [Kilo documentation](https://kilo.ai/docs) and [Devin API overview](https://docs.devin.ai/api-reference/overview)
- [Mistral chat API](https://docs.mistral.ai/api/endpoint/chat)
