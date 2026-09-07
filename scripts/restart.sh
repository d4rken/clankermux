#!/bin/sh
# restart.sh — Restart the service on the release it is ALREADY pinned to,
# pre-building so the restart is server init rather than a build.
#
# This does not deploy anything. The zz-release.conf drop-in pins
# WorkingDirectory to a release snapshot under .cache/releases/<sha>, and this
# script builds in whatever snapshot is pinned right now — never in the
# development checkout, whose contents the service does not run. To ship a new
# commit, use scripts/promote-release.sh.
#
# Why pre-build: with the dashboard-build.conf drop-in, ExecStartPre rebuilds
# the dashboard AFTER the old process is killed, so the build (~10-20s) is
# downtime. Building first inverts that — the old proxy keeps serving during
# the build, and the actual restart is just server init (~5s).
#
# build:db-workers MUST run too: it regenerates the gitignored embedded DB
# workers listed in packages/database/scripts/workers-manifest.ts from
# working-tree source. Skipping it leaves a stale embedded integrity worker whose old
# message protocol the scheduler can't classify precisely — the fail-safe
# then reads its operational errors as `corrupt`. The dashboard-build.conf
# drop-in runs this on the systemd path; this script must mirror it for the
# case where that drop-in is disabled (see prerequisite below).
#
# Prerequisite (one-time, sudo): disable the dashboard-build.conf drop-in,
# e.g. by renaming it to .bak, then `systemctl daemon-reload`.

set -e

# Build where the unit actually runs. An unset WorkingDirectory fails safely,
# but a present one pointing at the development checkout does not: that is what
# the base unit says when the release drop-in is missing, and building and
# restarting it is exactly what this script must never do. So require a release
# snapshot by path.
# Resolve the MAIN checkout, not this copy of the script: run from a worktree,
# `dirname $0`/.. would name that worktree's own .cache/releases and reject the
# real production path. The common git dir is shared by every worktree.
RELEASES=$(dirname "$(git -C "$(dirname "$0")/.." rev-parse --path-format=absolute --git-common-dir)")/.cache/releases
TARGET=$(systemctl show clankermux -p WorkingDirectory --value)
case "$TARGET" in
"$RELEASES"/?*) ;;
*)
	echo "restart.sh: the unit's WorkingDirectory is '${TARGET:-<unset>}', not a" >&2
	echo "release snapshot under $RELEASES. The zz-release.conf drop-in is" >&2
	echo "missing or broken — fix it with scripts/promote-release.sh." >&2
	exit 1
	;;
esac
if [ ! -d "$TARGET" ]; then
	echo "restart.sh: pinned release $TARGET does not exist" >&2
	exit 1
fi

echo "Restarting on $TARGET"
cd "$TARGET"
# The GUARDED commands, which are what ExecStartPre runs. Unguarded builds
# leave no content-hash marker, so ExecStartPre would rebuild from scratch
# inside the restart window and undo the point of pre-building.
bun run build:db-workers:guarded
bun run build:dashboard:guarded
sudo systemctl restart clankermux
echo "Done. Tail logs: journalctl -u clankermux -f"
