---
name: qwen-provider
description: Working on the Qwen/DashScope provider or its streaming transform. Read this before changing tool-call handling, streaming chunk assembly, or anything under the Qwen provider — its wire format differs from standard OpenAI in a way that breaks naive implementations.
---

# Qwen provider

## Mirror the qwen-code implementation

Always mirror the reference implementation at `/home/tom/git_repos/qwen-code/`.
Check how qwen-code handles the same scenario before implementing.

## Incremental tool-call arguments

Qwen/DashScope sends **incremental** tool call argument chunks — not cumulative
like standard OpenAI. The streaming transform buffers all chunks and emits
complete JSON at stream end, matching `StreamingToolCallParser` in qwen-code.

Treating the chunks as cumulative produces truncated or duplicated argument JSON.
