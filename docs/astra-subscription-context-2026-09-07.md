# Astra subscription context verification — 2026-09-07

ClankerMux rejected Astra requests estimated above 272,000 tokens before
forwarding them. The old routing table treated the subscription catalog's
`context_window` default as a hard maximum and justified it using raw API
pricing. Subscription capability must be established separately.

## Live subscription evidence

Read `GET https://chatgpt.com/backend-api/codex/models?client_version=0.153.1`
using each pool account's existing subscription credentials. Both returned:

```json
{"slug":"gpt-6-astra","context_window":272000,"max_context_window":872000}
```

Sent synthetic prompts to the subscription `/backend-api/codex/responses`
endpoint with the proxy's pinned client identity, `store: false`, streaming,
and low reasoning effort. Each prompt contained repeated ` apple` padding,
a distinct marker at each end, and instructions to return both markers.
No tools or user conversation data were included.

| Account | Upstream input tokens | Output tokens | Result |
| --- | ---: | ---: | --- |
| Codex-2 | 300,070 | 11 | HTTP 200, `response.completed`, both markers correct |
| Codex-1 | 850,070 | 11 | HTTP 200, `response.completed`, both markers correct |

The upstream usage fields establish the token counts; local character
estimates are not tokenizer measurements. These probes establish acceptance
above 272K and near the advertised maximum, not the exact failure boundary
or subscription quota multipliers.

## Routing change

`resolveModelContextWindow` continues to return the 272K client default.
`resolveModelMaxContextWindow` returns 872K for Astra and its dated variants,
falling back to existing limits for other models. Admission, exclusion logs,
and terminal errors use the maximum resolver. Client gauges and compaction
metadata continue to use the default resolver.

The existing 97% normal-admission margin remains: 845,840 estimated tokens
for Astra, with the existing last-resort path admitting up to 872,000.
The estimator and other models' routing limits are unchanged.

Before deployment, a typed Codex message containing the 300K-word probe sent
through `/wire/openai/v1/responses` reproduced the original error: estimated
604,084 tokens, both Astra accounts reported as capped at 272,000. This is
the request used for the deployment smoke check.
