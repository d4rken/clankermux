# systemd deployment units

`clankermux.service` is the base unit; the `.conf` files in
`clankermux.service.d/` are drop-ins that modify it. The base unit and every
drop-in except `runtime-floor.conf`, which is repo-only and not installed, are
byte-for-byte copies of what is installed under `/etc/systemd/system/`, kept in
the repo for review and reproducibility. The paths in them are this host's
(`darken`, `/home/darken/clankermux`, `/home/darken/.bun/bin/bun`), so another
machine needs them edited, not just copied.

The base unit is applied first, then its drop-ins. Drop-ins with different
filenames are applied in lexicographic order of filename regardless of which
directory they reside in (`systemd.unit(5)`); the directory hierarchy only
decides which copy wins between drop-ins that share a filename.
`zz-release.conf` sorts last of every drop-in this unit has, and it does not
only add directives: it resets `ExecStart=` and `ExecStartPre=` to empty and
re-lists the whole chain against the pinned release snapshot. So on a host that
has been promoted at least once, every `ExecStartPre` in effect is one of the
four lines `scripts/promote-release.sh` writes, and the base unit's preflight
line, `00-verify-deps.conf` and `dashboard-build.conf` contribute nothing.

| File | Purpose |
|------|---------|
| `clankermux.service` | The base unit: runs as `darken:darken` from `WorkingDirectory=/home/darken/clankermux`, with `Environment=` lines for `PORT=8080`, `NODE_ENV=production`, `CLANKERMUX_DB_PATH=/home/darken/.config/clankermux/clankermux.db` and a `PATH` that puts `/home/darken/.bun/bin` first; an absolute `ExecStart` bun binary; `Restart=always` with `RestartSec=5`; the `[Unit]` restart rate limit (`StartLimitIntervalSec=120`, `StartLimitBurst=5`); and `[Install] WantedBy=multi-user.target`. On the live host the drop-ins override its restart rate limit, `RestartSec`, memory limits and `PORT`, and after a promotion its `WorkingDirectory`, `ExecStart` and `ExecStartPre` too, so these values only apply on a host with no drop-ins installed. |
| `clankermux.service.d/00-verify-deps.conf` | `ExecStartPre` that runs `scripts/verify-deps.sh`, which refuses to start unless `node_modules` matches the integrity-hashed `bun.lock`. Fail-closed: a mismatch aborts startup. The `00-` ordering and this line only take effect on a host with no release pin; on a promoted host `zz-release.conf` has already reset the chain and runs the snapshot's own `verify-deps.sh`. |
| `clankermux.service.d/dashboard-build.conf` | `ExecStartPre` steps that regenerate the inline DB workers and rebuild the dashboard on every restart via a content-hash guard (`scripts/guarded-build.ts`). Hashes source + output content (not mtime) and skips the build when nothing changed; falls back to a full build on first run, missing/corrupt marker, or stale artifact. The db-workers step is blocking, because the proxy imports those workers at startup. The dashboard step is non-fatal (`-` prefix), so a broken UI bundle no longer blocks startup; that is the 2026-07-29 crashloop the file's comment records. It does not leave the previous dashboard standing either: `packages/dashboard-web/build.ts` deletes `dist` before it compiles, so the dashboard is unavailable until a build succeeds. Both lines are inert on a promoted host: the effective chain, `-` prefix included, is written by `scripts/promote-release.sh`, so changing the fatality means editing that script. |
| `clankermux.service.d/memory-safety.conf` | Raises the memory valve to `MemoryHigh=4G`, `MemoryMax=6G`, `MemorySwapMax=2G`. Added after the 2026-05-26 box-wide swap thrash, when the proxy's anonymous memory grew past a `MemoryHigh` of 2G and the kernel reclaimed by swapping its in-use pages. On this host the same three limits are also written under `/etc/systemd/system.control/` by `systemctl set-property`; those filenames sort before this one, so this file is what a reload applies. Both carry the same values today. |
| `clankermux.service.d/restart-backoff.conf` | Sets `[Unit] StartLimitIntervalSec=0` and `[Service] RestartSec=30`: retry forever, slowly. From the 2026-07-28 disk-full outage, where a crashing proxy tripped the start rate limiter and systemd left the unit dead for ~8.5 minutes after the cause had already cleared. |
| `clankermux.service.d/backend-port.conf` | Moves the app to `127.0.0.1:8090` behind the Caddy front proxy (client-facing traffic stays on `:8080`, now owned by Caddy). Loopback binding also removes the management-API network exposure warning. **Apply only together with `deploy/caddy/`** — without Caddy on `:8080`, clients reach nothing. |
| `clankermux.service.d/stop-timeout.conf` | Raises `TimeoutStopSec` to 330s so the in-app shutdown watchdog (`SHUTDOWN_WATCHDOG_MS` = 300s) can let long agentic streams finish draining — systemd's 90s default would SIGKILL mid-drain. Safe because the Caddy front holds new connections for the whole drain. Keep in sync with the watchdog and Caddy's `lb_try_duration 330s`. |
| `clankermux.service.d/runtime-floor.conf` | Sets `RestartPreventExitStatus=78` so a runtime below the declared Bun floor (`.bun-version`, enforced at boot by `packages/core/src/bun-runtime-floor.ts`) fails once with a readable reason instead of looping. Exit 78 is used by no other path in the app, so ordinary crashes still restart. This drop-in exists only in the repo and is not installed on the live host, so the suppression is not currently in effect: a sub-floor Bun would retry indefinitely at the `RestartSec=30` that `restart-backoff.conf` sets. To apply it: `sudo cp deploy/systemd/clankermux.service.d/runtime-floor.conf /etc/systemd/system/clankermux.service.d/ && sudo systemctl daemon-reload && sudo systemctl restart clankermux.service`. |
| `clankermux.service.d/hardening.conf` | Sandbox hardening (`ProtectSystem=strict`, capability/syscall/namespace restriction, etc.). Tuned for a home-dir source install: `ProtectHome` and `MemoryDenyWriteExecute` are intentionally unset (bun JIT needs W+X; the tree + DB live under `/home`). |

## Applying

### Fresh host

Prerequisites, all as the service user:

* bun installed at `/home/darken/.bun/bin/bun`, the absolute path `ExecStart=`
  names.
* The checkout at `/home/darken/clankermux`.
* `mkdir -p ~/.config/clankermux ~/.cache`

Those directories are not optional. `hardening.conf` lists them in
`ReadWritePaths=` with no `-` prefix, and `man systemd.exec` is explicit that an
unprefixed path which does not exist is an error, so the unit fails during
mount-namespace setup, before any `ExecStartPre` or a single line of application
code runs.

```bash
sudo install -m 0644 -o root -g root deploy/systemd/clankermux.service /etc/systemd/system/
sudo mkdir -p /etc/systemd/system/clankermux.service.d
sudo cp deploy/systemd/clankermux.service.d/*.conf /etc/systemd/system/clankermux.service.d/
sudo systemctl daemon-reload
sudo systemctl enable --now clankermux.service
systemctl is-active clankermux.service
systemd-analyze security clankermux.service   # review exposure level
```

This runs the service directly from the development checkout, which is not how
production runs here. `scripts/promote-release.sh <commit>` builds a release
snapshot under `.cache/releases/` and installs the `zz-release.conf` pin that
points the unit at it; `scripts/restart.sh` refuses to act until such a pin
exists, because it requires the unit's `WorkingDirectory` to be under
`.cache/releases/` (`restart.sh:37-47`).

### Existing install, updating the drop-ins

```bash
sudo cp deploy/systemd/clankermux.service.d/*.conf /etc/systemd/system/clankermux.service.d/
sudo systemctl daemon-reload
sudo systemctl restart clankermux.service     # or scripts/restart.sh on a pinned host
systemctl is-active clankermux.service
```

The glob also installs `runtime-floor.conf` if it is not already there, which is
the same action the `runtime-floor.conf` row above describes; naming the files
instead of globbing updates the others without applying it.

The explicit restart is the step that applies the new configuration.
`enable --now` is not a substitute for it: it starts an inactive unit and does
nothing to an active one, so `is-active` would report success while the old
process keeps serving with the old configuration.

To bypass the dependency gate during an incident on a promoted host, comment out
the `verify-deps.sh` line in
`/etc/systemd/system/clankermux.service.d/zz-release.conf` and `daemon-reload`.
That is the copy that runs; editing `00-verify-deps.conf` achieves nothing
there. The next promotion rewrites `zz-release.conf`, so the bypass clears
itself. On a host with no release pin, comment out the `ExecStartPre` line in
`00-verify-deps.conf` instead.

## Live drop-ins not mirrored here

* `zz-release.conf` in `/etc/systemd/system/clankermux.service.d/`, written per
  promotion by `scripts/promote-release.sh`. It pins `WorkingDirectory` to the
  snapshot under `.cache/releases/<sha>` and resets and re-lists
  `ExecStart`/`ExecStartPre` to point into it. Generated per commit, never
  copied from the repo; change it by re-running the script.
* `debug.conf` in the same directory, a one-line `Environment=LOG_LEVEL=DEBUG`
  toggle kept on the host during stability work. Deliberately temporary, so it
  is not mirrored.
* `50-MemoryHigh.conf`, `50-MemoryMax.conf` and `50-MemorySwapMax.conf` in
  `/etc/systemd/system.control/clankermux.service.d/`, written by
  `systemctl set-property`. That command also applied the change to the running
  unit immediately, which is why it took effect at the time. On a configuration
  reload `memory-safety.conf` sorts after them and supplies the values. They
  currently carry the same 4G/6G/2G that `memory-safety.conf` sets, so nothing
  conflicts today. A persistent change to the limits is an edit to
  `memory-safety.conf` followed by `daemon-reload`; the stale `50-*` files can
  be removed.

## Drift check

```bash
diff -r deploy/systemd/clankermux.service.d /etc/systemd/system/clankermux.service.d
diff deploy/systemd/clankermux.service /etc/systemd/system/clankermux.service
```

The first should report only `zz-release.conf`, `debug.conf`,
`runtime-floor.conf` and any `.bak-*` files; the second should print nothing.
Neither reaches `/etc/systemd/system.control/`, so a limit changed with
`systemctl set-property` is invisible to this check.

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
