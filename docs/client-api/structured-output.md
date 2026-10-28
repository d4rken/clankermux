# Structured output on Chat Completions

`/wire/openai/v1/chat/completions` accepts `response_format` with type
`json_schema`. The answer is the JSON text in `message.content`, with
`finish_reason` `stop`, or `length` when the backend hit its token limit. What
the schema guarantees depends on where the request lands:

| Route | What the schema does |
| --- | --- |
| Codex | Constrains the answer when `strict` is `true`; guides it when `strict` is `false` or absent. |
| OpenRouter | Passed to the upstream provider. The request is routed only to providers that support it (`require_parameters`). |
| Claude accounts through the SDK bridge | Claude Code validates the answer against the schema and retries on a mismatch. Nothing streams before the answer, which arrives whole at the end. When the last model call stopped at the token limit, the answer is 200 with `finish_reason` `length` and empty content. Any other failure to produce a matching answer (retries exhausted, a refusal, no answer at all) is an error with code `structured_output_failed`, never a 200: a 502 before the response started, an error chunk after it. Upstream errors such as rate limits keep their own status. |

On Codex and OpenRouter, a refusal answers `finish_reason` `content_filter`
with empty content. When streaming, JSON already sent before a late refusal
stays sent.
`json_schema` together with tools is refused with a 400, and `json_object` is
not supported. Through the SDK bridge, a schema is also refused with a 400 on
tool results that continue a turn, and on a side request. A schema over 64 KiB
as JSON is not sent through the SDK bridge: the request goes to another target
of its route, or gets a 400 when the bridge is the only one.

A native Messages client on `/wire/anthropic` that sends
`output_config.format` (`{"type": "json_schema", "schema": {...}}`) to a Claude
account is served the same way through the SDK bridge; its answer is one text
block holding the JSON.
