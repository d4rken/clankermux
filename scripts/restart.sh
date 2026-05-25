#!/bin/sh
# restart.sh — Build dashboard while old proxy is still serving, then restart.
#
# Why: with the dashboard-build.conf drop-in, ExecStartPre rebuilds the
# dashboard AFTER the old process is killed, so the build (~10-20s) is
# downtime. Building first inverts that — the old proxy keeps serving during
# the build, and the actual restart is just server init (~5s).
#
# Prerequisite (one-time, sudo): disable the dashboard-build.conf drop-in,
# e.g. by renaming it to .bak, then `systemctl daemon-reload`.

set -e

cd "$(cd "$(dirname "$0")/.." && pwd)"
bun run build:dashboard
sudo systemctl restart clankermux
echo "Done. Tail logs: journalctl -u clankermux -f"
