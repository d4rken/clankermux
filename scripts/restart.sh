#!/bin/sh
# restart.sh — Build DB workers + dashboard while old proxy is still serving,
# then restart.
#
# Why: with the dashboard-build.conf drop-in, ExecStartPre rebuilds the
# dashboard AFTER the old process is killed, so the build (~10-20s) is
# downtime. Building first inverts that — the old proxy keeps serving during
# the build, and the actual restart is just server init (~5s).
#
# build:db-workers MUST run too: it regenerates the gitignored embedded DB
# workers (vacuum / integrity-check / incremental-vacuum) from working-tree
# source. Skipping it leaves a stale embedded integrity worker whose old
# message protocol the scheduler can't classify precisely — the fail-safe
# then reads its operational errors as `corrupt`. The dashboard-build.conf
# drop-in runs this on the systemd path; this script must mirror it for the
# case where that drop-in is disabled (see prerequisite below).
#
# Prerequisite (one-time, sudo): disable the dashboard-build.conf drop-in,
# e.g. by renaming it to .bak, then `systemctl daemon-reload`.

set -e

cd "$(cd "$(dirname "$0")/.." && pwd)"
bun run build:db-workers
bun run build:dashboard
sudo systemctl restart clankermux
echo "Done. Tail logs: journalctl -u clankermux -f"
