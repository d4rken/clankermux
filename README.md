# ClankerMux <img src="packages/dashboard-web/src/logo.png" alt="ClankerMux logo" height="32" />

[![CI](https://github.com/d4rken/clankermux/actions/workflows/ci.yml/badge.svg)](https://github.com/d4rken/clankermux/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A51.2.8-000000?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A multiplexing load-balancer proxy for Claude Code (and Codex/OpenAI). It fans your
requests across multiple backend accounts through one local endpoint, so you stop
hitting per-account rate limits. Point your coding client at it, add your accounts
in the dashboard, and it routes and falls back across them.

## An opinionated fork

ClankerMux began as a fork of [tombii/better-ccflare](https://github.com/tombii/better-ccflare)
(itself a fork of [snipeship/ccflare](https://github.com/snipeship/ccflare)).
After 30+ upstream PRs I just decided to just have my own bespoke solution.
Fast iteration and tailored to my use-case, mostly Anthropic and OpenAI accounts.

Features:

* Multiplexes one endpoint across multiple Anthropic, Codex/OpenAI, and OpenAI-compatible accounts.
* Capacity-aware account selection (FEFO) — maximizes total token availability across the pool.
* Sticky session routing for high prompt-cache hit rates; survives priority edits and failover.
* Transparent burst-429 retry — rides out rate-limit storms without losing the prompt cache.
* Overload (529) detection, cooldowns, and cross-provider fallback.
* Manual control: priorities, pause/resume, force-account mode, pin an API key to an account.
* Native Responses-API passthrough for Codex CLI.
* Proxy API keys separate from dashboard access.
* Web dashboard: accounts, request history, rate-limit graphs with burn-rate forecasts, analytics, spend tracking, logs.
* Small dependency tree; memory-leak and stability hardening for long-running deployments.

## Related projects

* [Clankermux Usage for Cinnamon](https://github.com/d4rken/clankermux-mint-applet) — Linux Mint/Cinnamon panel applet for monitoring pooled quota usage and exhaustion forecasts.

## Build from source

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/d4rken/better-ccflare
cd better-ccflare
bun install
bun run build       # builds the dashboard (required before first run)
bun start           # serves the proxy + dashboard on http://localhost:8080
```

Add your provider accounts in the dashboard, then point your coding client at the proxy.

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
export ANTHROPIC_AUTH_TOKEN=dummy-key     # or a key generated in the dashboard
claude
```

> Don't set `ANTHROPIC_AUTH_TOKEN` alongside an active Claude CLI OAuth login — Claude
> CLI warns about conflicting auth. Legacy `BETTER_CCFLARE_*` env vars and the
> `x-better-ccflare-account-id` header are still accepted.

## Use it with Codex

Add a ClankerMux model provider to `~/.codex/config.toml`:

```toml
model_provider = "clankermux"

[model_providers.clankermux]
name = "ClankerMux"
base_url = "http://localhost:8080/v1"
wire_api = "responses"
env_key = "CLANKERMUX_API_KEY"
```

Then set the proxy key and launch Codex:

```bash
export CLANKERMUX_API_KEY=dummy-key     # or a key generated in the dashboard
codex
```

`dummy-key` is sufficient when ClankerMux runs open. Codex reads the variable named
by `env_key` and sends it as a bearer token, so the secret stays out of `config.toml`.

## License

MIT — see [LICENSE](LICENSE).
