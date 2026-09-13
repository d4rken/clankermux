<!--
  The banner and the screenshots are two files each rather than one with a media
  query: an SVG behind an <img> renders in the browser's secure static mode and
  GitHub proxies README images through a sanitiser, so the theme has to be
  chosen outside the file. <picture> is the mechanism GitHub documents for that.
  The screenshot links can only name one file, so they point at the dark variant
  deliberately.

  The banner comes from `bun run build:readme-media`. The screenshots come from
  `bun run build:readme-screenshots`, which boots a real ClankerMux against a
  synthetic database in a network namespace and photographs it, see
  scripts/readme-media/.
-->
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/banner-dark.svg"><img src="docs/media/banner-light.svg" width="400" alt="ClankerMux: a self-hosted gateway for coding agents" /></picture>

[![CI](https://github.com/d4rken/clankermux/actions/workflows/ci.yml/badge.svg)](https://github.com/d4rken/clankermux/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A51.4.0-000000?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Point your coding clients at one endpoint. ClankerMux spreads requests across
the model accounts you already pay for, decides per client what they can reach,
and shows you how much quota is left. It does not run agents, and it cannot
invent capacity: when every eligible account is exhausted, requests stop.

## What it does

* **Clients**: Claude Code, Codex, OpenCode, Pi Agent, Oh My Pi, and anything
  OpenAI- or Anthropic-compatible. The dashboard writes each one its own key and
  hands you the config to paste.
* **Providers**: Anthropic and Codex OAuth logins, Claude and OpenAI API keys,
  OpenRouter, Devin, and a long tail of compatible endpoints down to a local
  Ollama. Five are validated against live accounts; the dashboard flags the rest
  as experimental when you add them.
* Capacity-aware account selection, draining whichever weekly window resets
  soonest so unused budget is not lost.
* Sticky session routing for prompt-cache hit rates, surviving priority edits
  and failover.
* Cross-account failover on any provider, plus transparent 429 burst retries and
  family-scoped 529 circuit breakers on Anthropic.
* Routing rules deciding which accounts serve which models, per client.
* Pooled 5-hour and 7-day quota with burn-rate forecasts and a runway estimate,
  per-model-family weekly limits, request history, spend tracking.
* Manual control: priorities, pause and resume, forcing a single account.

## Screenshots

<table>
<tr>
<td width="25%"><a href="docs/media/overview-dark.png"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/overview-dark.png"><img src="docs/media/overview-light.png" width="100%" alt="Overview: a Live Activity strip plotting the last five minutes of requests by project, coloured by model, above tiles for 5-hour and 7-day pool capacity and quota runway, then request-volume, model, API-key and project usage charts." /></picture></a></td>
<td width="25%"><a href="docs/media/clients-dark.png"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/clients-dark.png"><img src="docs/media/clients-light.png" width="100%" alt="Clients: a row per client installation, each naming the application it is configured for and the last eight characters of its key, the upstream accounts or providers it may reach, how many models its Anthropic, OpenAI and Codex catalogues advertise, how long ago it last sent a request, and buttons to reconfigure it or copy its setup instructions." /></picture></a></td>
<td width="25%"><a href="docs/media/limits-dark.png"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/limits-dark.png"><img src="docs/media/limits-light.png" width="100%" alt="Usage: pooled 5-hour and 7-day quota with next checkpoints and exhaustion warnings, a quota runway estimate, and per-account utilization bars carrying burn-rate projections against each window's reset, and the month's ledger spend with its amortized run rate above the payments history." /></picture></a></td>
<td width="25%"><a href="docs/media/routing-dark.png"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/routing-dark.png"><img src="docs/media/routing-light.png" width="100%" alt="Routing: a numbered list of rules evaluated in order, the first enabled rule matching the API key and the requested model winning. It holds one client's alias rewriting a model id onto a named account, model-family rules restricting Opus and Sonnet to particular accounts, a rule pinning one model to a provider, and a disabled rule." /></picture></a></td>
</tr>
</table>

## Install and run

```bash
git clone https://github.com/d4rken/clankermux
cd clankermux
bun install
bun run build       # builds the dashboard (required before first run)
bun start           # serves the proxy + dashboard on http://localhost:8080
```

Requires [Bun](https://bun.sh) 1.4.0 or newer, and refuses to start on anything
older. (On older runtimes a client aborting a streaming response segfaults the
process, [oven-sh/bun#32111](https://github.com/oven-sh/bun/issues/32111), which
is routine traffic for a proxy.)

Two things to settle before you leave it running. It binds `0.0.0.0` by default,
so set `CLANKERMUX_HOST=127.0.0.1` if you want it on loopback only. And the
management API is fail-open until a dashboard password exists, so set one with
`bun run auth:password --set`.

Then add an account, open **Clients**, and add a client. The dashboard generates
the configuration for whichever application you picked, and the rest of the
setup is explained where you do it. Clients speak either wire format:
`/wire/anthropic` for the Anthropic Messages API, `/wire/openai` for the OpenAI
Responses and Chat Completions APIs. Legacy `BETTER_CCFLARE_*` env vars and the
`x-better-ccflare-account-id` header are still accepted.

## Integrations

* [Public widget API](docs/public-api/README.md) for external displays and
  applets, with JSON Schemas and example payloads.
* [Clankermux Usage for Cinnamon](https://github.com/d4rken/clankermux-mint-applet),
  a Linux Mint panel applet for pooled quota and exhaustion forecasts.
* [Clankermux Usage for macOS](https://github.com/d4rken/clankermux-macos-applet),
  the same for the macOS menu bar.

## Running it persistently

* [systemd unit](deploy/systemd/README.md) for running it as a service.
* [Caddy front proxy](deploy/caddy/README.md), which holds new connections across
  app restarts while in-flight agent streams drain.

## Project notes

ClankerMux began as a fork of [tombii/better-ccflare](https://github.com/tombii/better-ccflare)
(itself a fork of [snipeship/ccflare](https://github.com/snipeship/ccflare)). After 30+
upstream PRs I wanted something bespoke: fast iteration, tailored to my use case of
mostly Anthropic and OpenAI accounts. It has since diverged substantially and is
developed independently, but stays MIT-licensed and keeps the original authors'
copyright intact.

## License

MIT. See [LICENSE](LICENSE).
