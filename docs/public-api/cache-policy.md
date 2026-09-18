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
that cannot support an expiry estimate. Missing fields remain unknown.
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
| OpenAI | `https://api.openai.com` or `/v1`; Codex adapter with exact `/v1/responses` | GPT-5.6/Sol/Terra/Luna and GPT-6 Astra: automatic, 30-minute minimum, refreshed on reuse. Earlier supported GPT/o-series: automatic with typical retention, no numeric default. No documented request-start/end anchor, so no countdown. |
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

## Client display and observations

A Codex-routed `gpt-6-astra` now reports:

```json
{"mode":"implicit","expiry":"unavailable","source":"gateway-policy"}
```

Display "Automatic caching; expiration unavailable". Keep session observations
separate, in memory. A cache read proves that some prefix was reused on that
request, not that all current context is warm. Cache creation alone does not
prove expiry. First writes, changed prefixes, account changes and eviction can
all produce new writes.

Only calculate an estimate when the policy's expiry, effective TTL, semantics,
anchor and comparable prefix observations support it. A minimum TTL is a lower
bound on retention, not an exact eviction date. Gateway TTL promotion and
background refreshes are not reported by discovery. An unavailable expiry must
never become a countdown merely because a TTL number is present.

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
