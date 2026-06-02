# ClankerMux <img src="packages/dashboard-web/src/logo.png" alt="ClankerMux logo" height="32" />

[![CI](https://github.com/d4rken/clankermux/actions/workflows/ci.yml/badge.svg)](https://github.com/d4rken/clankermux/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A51.2.8-000000?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A multiplexing load-balancer proxy for Claude Code (and Codex/OpenAI). It fans your
requests across multiple backend accounts through one local endpoint, so you stop
hitting per-account rate limits. Point Claude Code at it with `ANTHROPIC_BASE_URL`,
add your accounts in the dashboard, and it routes and falls back across them.

## An opinionated fork

ClankerMux began as a fork of [tombii/better-ccflare](https://github.com/tombii/better-ccflare)
(itself a fork of [snipeship/ccflare](https://github.com/snipeship/ccflare)).
After 30+ upstream PRs I just decided to just have my own bespoke solution.
Fast iteration and tailored to my use-case, mostly Anthropic and OpenAI accounts.

Changes:

* API key system is sepperate from dashboard access.
* Smaller dependency trees to reduce supply-chain attack surface.
* Memory leak fixes, stability improvements, performance improvements.
* Improved account selection algorithm, maximized token availability.
* Improved session routing, increased cache hit rate.
* Improved fallover mechanims, reduced token churn.
* Additional analytics: Usage windows, cache hit rate, model performance and system status

Feel free to use this fork, but it's not build for others to use, it is just what I use, made public.
Bug reports are welcome, feature requests are not... 🤷‍♂️

## Build from source

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/d4rken/better-ccflare
cd better-ccflare
bun install
bun run build       # builds the dashboard + CLI (required before first run)
bun start           # serves the proxy + dashboard on http://localhost:8080
```

Add your provider accounts in the dashboard (or via the `clankermux` CLI), then point
Claude Code at the proxy.

## Use it with Claude Code

Set `ANTHROPIC_BASE_URL` to the ClankerMux endpoint. With a logged-in Claude Pro/Team
CLI you don't need a token:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
claude
```

If ClankerMux has API keys configured (or you aren't using Claude CLI's OAuth login),
also set a token — `dummy-key` when ClankerMux runs open, or a generated key when it's
protected:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_AUTH_TOKEN=dummy-key     # or: clankermux --generate-api-key "my machine"
claude
```

> Don't set `ANTHROPIC_AUTH_TOKEN` alongside an active Claude CLI OAuth login — Claude
> CLI warns about conflicting auth. Legacy `BETTER_CCFLARE_*` env vars and the
> `x-better-ccflare-account-id` header are still accepted.

## License

MIT — see [LICENSE](LICENSE).
