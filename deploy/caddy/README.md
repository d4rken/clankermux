# Caddy front proxy — zero-downtime app restarts

Version-controlled copy of the Caddy config for the live deployment. The
authoritative copy lives at `/etc/caddy/Caddyfile`.

## Why

Before this, every `systemctl restart clankermux` had a client-visible outage:
during the drain window the app refused new connections, and clients on `:8080`
saw `ECONNREFUSED` until the new process was listening.

Now Caddy owns client-facing `:8080` and **never restarts**; the app listens on
`127.0.0.1:8090` (via the `backend-port.conf` systemd drop-in). During an app
restart:

- established SSE streams keep flowing through Caddy to the draining process
  (the in-app shutdown watchdog gives them up to 85s to finish);
- NEW connections are held by Caddy (`lb_try_duration 100s`), which re-dials
  the backend every 250ms until the new process is up.

Zero refused connections, and there is only ever one app process at a time —
no `reusePort` / blue-green machinery needed.

## Applying (manual, sudo)

> ⚠️ **Install Caddy from the official Caddy apt repository** (per
> <https://caddyserver.com/docs/install#debian-ubuntu-raspbian>), not from the
> distro's own repo. The Debian-repo build (observed with a v2.11.4 package)
> rejects `stream_close_delay` as an unrecognized subdirective; the upstream
> package accepts the full config. Validate before touching anything:
> `caddy validate --config deploy/caddy/Caddyfile --adapter caddyfile`.

```bash
# after adding the official Caddy apt repo per the link above:
sudo apt install caddy
sudo cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo cp deploy/systemd/clankermux.service.d/backend-port.conf /etc/systemd/system/clankermux.service.d/
sudo systemctl daemon-reload
```

Then, **in this order** (do it during a quiet moment — this is the last
unguarded restart):

```bash
sudo systemctl restart clankermux          # app moves to 127.0.0.1:8090 (brief outage, as usual)
sudo systemctl reload-or-restart caddy     # Caddy takes over :8080
```

## Verification

```bash
curl -s http://localhost:8080/health       # through Caddy -> app
ss -tlnp | grep -E '8080|8090'             # :8080 owned by caddy, 127.0.0.1:8090 by bun
```

## Rollback

```bash
sudo rm /etc/systemd/system/clankermux.service.d/backend-port.conf
sudo systemctl daemon-reload
sudo systemctl restart clankermux          # app back on :8080
sudo systemctl disable --now caddy
```

## Caveats

- **Never touch the caddy unit casually.** `systemctl reload caddy` is a
  graceful config reload — `stream_close_delay 35m` keeps in-flight streams
  alive across it. But restarting the caddy **process**
  (`systemctl restart caddy`) severs every connection, including active
  streams. Hold unattended-upgrades for the `caddy` package, or restart it only
  when the proxy is idle.
- `lb_try_duration 100s` means a genuinely hard-down app (crash loop, failed
  build) looks like a ~100s client hang followed by a 502, instead of an
  immediate failure.
- Port `8081` stays reserved for manual test instances (`bun start --serve
  --port 8081`), unchanged.
- Do not add active health checks to the Caddyfile — a health-checked-down
  backend would 502 new requests instead of holding them (the dial-retry loop
  is what provides the restart hold).
