# systemd deployment units

Version-controlled copies of the systemd drop-ins that harden the live
`clankermux.service` deployment. The authoritative copies live in
`/etc/systemd/system/clankermux.service.d/`; these are kept in the repo for
review and reproducibility.

| File | Purpose |
|------|---------|
| `clankermux.service.d/00-verify-deps.conf` | `ExecStartPre` that runs `scripts/verify-deps.sh` — refuses to start unless `node_modules` matches the integrity-hashed `bun.lock`. Named `00-` so it runs before the dashboard build. |
| `clankermux.service.d/dashboard-build.conf` | `ExecStartPre` steps that regenerate the inline DB workers and rebuild the dashboard on every restart via a content-hash guard (`scripts/guarded-build.ts`). Hashes source + output content (not mtime) and skips the build when nothing changed; falls back to a full build on first run, missing/corrupt marker, or stale artifact. Fail-closed: a failed build writes no marker and blocks startup. |
| `clankermux.service.d/backend-port.conf` | Moves the app to `127.0.0.1:8090` behind the Caddy front proxy (client-facing traffic stays on `:8080`, now owned by Caddy). Loopback binding also removes the management-API network exposure warning. **Apply only together with `deploy/caddy/`** — without Caddy on `:8080`, clients reach nothing. |
| `clankermux.service.d/hardening.conf` | Sandbox hardening (`ProtectSystem=strict`, capability/syscall/namespace restriction, etc.). Tuned for a home-dir source install: `ProtectHome` and `MemoryDenyWriteExecute` are intentionally unset (bun JIT needs W+X; the tree + DB live under `/home`). |

## Applying

```bash
sudo cp deploy/systemd/clankermux.service.d/*.conf /etc/systemd/system/clankermux.service.d/
sudo systemctl daemon-reload
sudo systemctl restart clankermux.service
systemctl is-active clankermux.service
systemd-analyze security clankermux.service   # review exposure level
```

To bypass the dependency gate during an incident, comment out the
`ExecStartPre` line in `00-verify-deps.conf` and `daemon-reload`.
