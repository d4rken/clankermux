---
name: running-clankermux
description: Building, starting and exercising ClankerMux locally — server commands, ports, the production Caddy topology, account management via the HTTP API, maintenance endpoints, and how to send a safe test request through the proxy.
---

# Running and testing ClankerMux

## Server

- First run: `bun run build` (builds dashboard + DB workers)
- Start: `bun start` (port 8080), or `bun start --serve --port 8081` for testing
- Startup takes ~15 seconds — wait before sending requests

**Production topology:** the app listens on `127.0.0.1:8090` (systemd
`backend-port.conf` drop-in) behind a Caddy front proxy on `:8080`, so the
client-facing port is still 8080 (`deploy/caddy/README.md`). Test local changes
on **8081** so you don't collide with the live service.

## Sending a test request

Never send an automated request to a real Anthropic account — see the testing
restriction in `CLAUDE.md`. Use a non-Anthropic account and force-route to it
with `x-clankermux-account-id` (the legacy `x-better-ccflare-account-id` header
is also accepted).

For OpenRouter, always use model `z-ai/glm-4.5-air:free`:

```bash
curl -X POST http://localhost:8081/wire/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model":"z-ai/glm-4.5-air:free","messages":[{"role":"user","content":"test"}],"max_tokens":10}'
```

## Account management

Managed via the web dashboard (Accounts tab) or the HTTP API — there is no CLI.

| Action | Endpoint |
|---|---|
| List / add / remove | `GET /api/accounts`, `POST /api/accounts`, `DELETE /api/accounts/:id` |
| Pause / resume / priority | `POST /api/accounts/:id/pause\|resume\|priority` (priority: lower = higher, 0 = first) |
| OAuth add / reauth | `/api/oauth/*` (e.g. `/api/oauth/init`, `/api/oauth/reauth/anthropic`) |

Provider behavior: OAuth accounts have 5h session windows; API-key accounts are
pay-as-you-go with no sessions.

## Maintenance

| Action | Endpoint |
|---|---|
| Stats | `GET /api/stats` |
| Reset stats | `POST /api/stats/reset` |
| History / data cleanup | `POST /api/maintenance/cleanup` |
| Integrity check | `POST /api/storage/integrity/check` |

## Environment

OS timezone is UTC+2. Timestamps in logs and `/tmp` files are UTC — add 2 hours
for local time.
