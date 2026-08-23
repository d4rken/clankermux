<!--
  The mark is two files rather than one with a media query: an SVG behind an
  <img> renders in the browser's secure static mode and GitHub proxies README
  images through a sanitiser, so the theme has to be chosen outside the file.
  <picture> is the mechanism GitHub documents for that. Both files, and every
  screenshot below, come from `bun run build:readme-media`.
-->
# ClankerMux <picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/logo-dark.svg"><img src="docs/media/logo-light.svg" alt="" height="30" align="center" /></picture>

[![CI](https://github.com/d4rken/clankermux/actions/workflows/ci.yml/badge.svg)](https://github.com/d4rken/clankermux/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A51.4.0-000000?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A multiplexing load-balancer proxy for Claude Code (and Codex/OpenAI). It fans your
requests across multiple backend accounts through one local endpoint, so you stop
hitting per-account rate limits. Point your coding client at it, add your accounts
in the dashboard, and it routes and falls back across them.

## An opinionated fork

ClankerMux began as a fork of [tombii/better-ccflare](https://github.com/tombii/better-ccflare)
(itself a fork of [snipeship/ccflare](https://github.com/snipeship/ccflare)).
After 30+ upstream PRs I decided to have my own bespoke solution.
Fast iteration and tailored to my use-case, mostly Anthropic and OpenAI accounts.
It's since diverged substantially and is developed independently, but stays
MIT-licensed and keeps the original authors' copyright intact.

Features:

* Multiplexes one endpoint across multiple Anthropic, Codex/OpenAI, and OpenAI-compatible accounts.
* Capacity-aware account selection (FEFO) — maximizes total token availability across the pool.
* Sticky session routing for high prompt-cache hit rates; survives priority edits and failover.
* Transparent 429 recovery — burst retries and failover ride out rate-limit storms
  without losing the prompt cache; single-flight probes keep parallel clients from
  stampeding an account as its cooldown expires.
* Family-scoped 529 circuit breakers — isolate the overloaded model family, admit
  one recovery probe, and briefly hold concurrent requests for transparent recovery
  before falling back to another model or provider.
* Manual control: priorities, pause/resume, force-account mode, pin an API key to an account.
* Native Responses-API passthrough for Codex CLI.
* Codex usage-reset credits — see balances and expiry, apply a reset manually, or opt
  in to automatic application before expiry or when the weekly limit is reached,
  with an audit history.
* Proxy API keys separate from dashboard access.
* Web dashboard: accounts, request history, rate-limit graphs with burn-rate
  forecasts, active-session and per-account client metrics, per-model-family weekly
  limits, analytics, spend tracking, logs.
* Optional [Caddy front proxy](deploy/caddy/README.md) holds new connections across
  app restarts while in-flight agent streams drain.
* Small dependency tree; memory-leak and stability hardening for long-running deployments.

## Screenshots

<table>
<tr>
<td width="25%"><a href="docs/media/overview-light.svg"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/overview-dark.svg"><img src="docs/media/overview-light.svg" width="100%" alt="Overview: a health strip reading All Systems Operational, tiles for 24-hour requests, success rate, tokens and plan value, and a per-account throughput chart." /></picture></a></td>
<td width="25%"><a href="docs/media/accounts-light.svg"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/accounts-dark.svg"><img src="docs/media/accounts-light.svg" width="100%" alt="Accounts: three account cards, each with its provider, status chips, request counts and a row of quota windows showing 5-hour, weekly and per-family utilization." /></picture></a></td>
<td width="25%"><a href="docs/media/usage-light.svg"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/usage-dark.svg"><img src="docs/media/usage-light.svg" width="100%" alt="Usage: a sawtooth chart of per-account utilization against the limit line, with dashed burn-rate projections, above headline figures for plan value, cost and value ratio." /></picture></a></td>
<td width="25%"><a href="docs/media/requests-light.svg"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/requests-dark.svg"><img src="docs/media/requests-light.svg" width="100%" alt="Request history: five request rows, each showing time, status, the account it was routed through, latency, and chips for the calling agent, project, model, token counts, throughput and cost." /></picture></a></td>
</tr>
</table>

## Related projects

* [Clankermux Usage for Cinnamon](https://github.com/d4rken/clankermux-mint-applet) — Linux Mint/Cinnamon panel applet for monitoring pooled quota usage and exhaustion forecasts.

## Build from source

Requires [Bun](https://bun.sh) 1.4.0 or newer. On older runtimes a client
aborting a streaming response segfaults the process
([oven-sh/bun#32111](https://github.com/oven-sh/bun/issues/32111)), which is
routine traffic for a proxy, so ClankerMux refuses to start on them. The exact
version CI builds and tests against is pinned in `.bun-version`.

```bash
git clone https://github.com/d4rken/clankermux
cd clankermux
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
