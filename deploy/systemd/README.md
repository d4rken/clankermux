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
| `clankermux.service.d/stop-timeout.conf` | Raises `TimeoutStopSec` to 330s so the in-app shutdown watchdog (`SHUTDOWN_WATCHDOG_MS` = 300s) can let long agentic streams finish draining — systemd's 90s default would SIGKILL mid-drain. Safe because the Caddy front holds new connections for the whole drain. Keep in sync with the watchdog and Caddy's `lb_try_duration 330s`. |
| `clankermux.service.d/runtime-floor.conf` | Sets `RestartPreventExitStatus=78` so a runtime below the declared Bun floor (`.bun-version`, enforced at boot by `packages/core/src/bun-runtime-floor.ts`) fails once with a readable reason instead of crash-looping through `StartLimitBurst`. Exit 78 is used by no other path in the app, so ordinary crashes still restart. |
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

## Bun runtime

`ExecStart=` names an absolute binary, so neither `.bun-version` nor anything
on `PATH` decides what the service runs. After a `bun upgrade`, confirm with
`bun --revision` against that exact path before restarting. The proxy exits 78
on a runtime below the floor, and the journal entry names the version it saw,
the version it needs and `oven-sh/bun#32111`.

`scripts/verify-deps.sh` and `scripts/restart.sh` resolve `bun` from `PATH`.
Under this unit that is the same binary, because `Environment=PATH=` puts
`/home/darken/.bun/bin` first. Run by hand from a shell with a different
`bun` earlier on `PATH` and they will not be.
