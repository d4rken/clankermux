#!/bin/bash
# promote-release.sh — Point the running service at a reviewed commit.
#
# Production does NOT run from the development checkout. The
# zz-release.conf systemd drop-in pins WorkingDirectory to a release
# snapshot under .cache/releases/<sha>, so an unfinished working tree can
# never reach production through a crash restart or a reboot. Nothing
# promotes itself: a merge into main changes what WILL ship the next time
# this script runs, and nothing about what is running now.
#
# What this does, in order:
#   1. resolves the target commit (default: refs/heads/main)
#   2. creates .cache/releases/<sha> as a detached worktree if it is missing,
#      and refuses to reuse an existing one that has drifted from the commit
#   3. installs dependencies and runs the GUARDED builds there, while the old
#      release keeps serving — guarded so the markers exist and the
#      ExecStartPre steps are a hash check rather than a second build inside
#      the restart window
#   4. rewrites the drop-in, daemon-reloads, restarts
#   5. verifies the unit actually restarted into the new snapshot, logged the
#      version its own package.json declares, and then stayed up and serving
#      for a settle window rather than merely reaching readiness once
#
# Rollback is the same command with the previous snapshot's sha. This script
# prints it before switching and records it in .cache/releases/PREVIOUS, so a
# failed promotion followed by a re-run does not lose it. Old snapshots are
# never deleted here; prune them by hand with
# `git worktree remove .cache/releases/<sha>` once you no longer want them as
# rollback targets. They are cheaper to keep than `du` on one of them
# suggests: bun hardlinks node_modules from its global cache, so snapshots
# share most of their content and removing one frees far less than its
# apparent size.
#
# Usage: scripts/promote-release.sh [<commit-ish>]

set -euo pipefail

UNIT=clankermux
DROPIN=/etc/systemd/system/${UNIT}.service.d/zz-release.conf
BUN=/home/darken/.bun/bin/bun
SETTLE_SECONDS=20
BANNER_TIMEOUT=60

die() {
	echo "promote-release: $*" >&2
	exit 1
}

show() { systemctl show "$UNIT" -p "$1" --value 2>/dev/null || true; }

# The snapshot is created with `git worktree add`, which must run in the main
# checkout — the one whose .git is a directory. A release snapshot and a
# .claude worktree both have a .git FILE, so this also refuses to promote from
# inside one of them.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -d "$ROOT/.git" ] || die "$ROOT is not the main checkout (.git is not a directory)"

TARGET=${1:-refs/heads/main}
SHA=$(git -C "$ROOT" rev-parse --verify "${TARGET}^{commit}" 2>/dev/null) ||
	die "cannot resolve $TARGET to a commit"
RELEASE="$ROOT/.cache/releases/$SHA"
RELEASES_DIR="$ROOT/.cache/releases"

CURRENT=$(show WorkingDirectory)
CURRENT_SHA=""
case "$CURRENT" in
"$RELEASES_DIR"/*) CURRENT_SHA=$(basename "$CURRENT") ;;
esac
# A previous failed run may have left the pin pointing at the release being
# promoted, which would make CURRENT a useless rollback target. The recorded
# value from before that run is the one to trust.
if [ -z "$CURRENT_SHA" ] || [ "$CURRENT_SHA" = "$SHA" ]; then
	if [ -r "$RELEASES_DIR/PREVIOUS" ]; then
		CURRENT_SHA=$(cat "$RELEASES_DIR/PREVIOUS")
	fi
fi

echo "Promoting $SHA"
echo "  currently pinned: ${CURRENT:-<none — running the base unit>}"
if [ -n "$CURRENT_SHA" ] && [ "$CURRENT_SHA" != "$SHA" ]; then
	echo "  rollback:         scripts/promote-release.sh $CURRENT_SHA"
else
	echo "  rollback:         no distinct previous release recorded"
fi
echo

if [ -e "$RELEASE" ]; then
	# rev-parse alone would happily answer from a parent repository, so confirm
	# this directory is itself the worktree root before trusting its HEAD.
	TOP=$(git -C "$RELEASE" rev-parse --show-toplevel 2>/dev/null) ||
		die "$RELEASE exists but is not a git worktree"
	[ "$TOP" = "$RELEASE" ] || die "$RELEASE is inside the worktree $TOP, not its root"
	HAVE=$(git -C "$RELEASE" rev-parse HEAD)
	[ "$HAVE" = "$SHA" ] || die "$RELEASE is at $HAVE, not $SHA"
	# Built artifacts and node_modules are gitignored, so anything reported here
	# is tracked source that differs from the reviewed commit.
	DIRT=$(git -C "$RELEASE" status --porcelain=v1) ||
		die "cannot read the status of $RELEASE"
	[ -z "$DIRT" ] || die "$RELEASE has uncommitted changes; it is not $SHA:
$DIRT"
	echo "Reusing existing snapshot $RELEASE"
else
	echo "Creating snapshot $RELEASE"
	git -C "$ROOT" worktree add --detach "$RELEASE" "$SHA"
fi

# Build in the snapshot while the old release is still serving. These are the
# same guarded commands systemd runs, so they leave the content-hash markers
# behind and ExecStartPre finds nothing to do.
echo
echo "Building in the snapshot"
(cd "$RELEASE" && "$BUN" install --frozen-lockfile)
(cd "$RELEASE" && "$BUN" run build:db-workers:guarded)
(cd "$RELEASE" && "$BUN" run build:dashboard:guarded)

VERSION=$(cd "$RELEASE" && "$BUN" --print 'require("./package.json").version') ||
	die "cannot read the snapshot's package.json version"

echo
echo "Installing the drop-in for $SHA (version $VERSION)"
CONF=$(mktemp)
trap 'rm -f "$CONF"' EXIT
cat >"$CONF" <<EOF
# Pin production to reviewed commit $SHA.
# The development checkout may contain unfinished work; do not run from it.
# Written by scripts/promote-release.sh — edit by re-running it, not by hand.
[Service]
WorkingDirectory=$RELEASE
ExecStart=
ExecStart=$BUN run apps/server/src/server.ts
ExecStartPre=
ExecStartPre=$RELEASE/scripts/preflight-env.sh
ExecStartPre=$RELEASE/scripts/verify-deps.sh
ExecStartPre=$BUN run build:db-workers:guarded
ExecStartPre=-$BUN run build:dashboard:guarded
EOF
if [ -n "$CURRENT_SHA" ] && [ "$CURRENT_SHA" != "$SHA" ]; then
	printf '%s\n' "$CURRENT_SHA" >"$RELEASES_DIR/PREVIOUS"
fi
sudo install -m 0644 -o root -g root "$CONF" "$DROPIN"
sudo systemctl daemon-reload

INVOCATION_BEFORE=$(show InvocationID)
echo "Restarting $UNIT"
# Deliberately not fatal: a failed restart is exactly when the verification
# below and its rollback instructions are worth printing.
RESTART_RC=0
sudo systemctl restart "$UNIT" || RESTART_RC=$?

FAIL=0
note_fail() {
	echo "FAIL: $*" >&2
	FAIL=1
}

[ "$RESTART_RC" -eq 0 ] || note_fail "systemctl restart exited $RESTART_RC"

# WorkingDirectory reflects the reloaded CONFIGURATION even when the old
# process is still running, so it cannot show that anything restarted. The
# invocation id can: systemd mints a new one per start.
INVOCATION_AFTER=$(show InvocationID)
if [ -z "$INVOCATION_AFTER" ] || [ "$INVOCATION_AFTER" = "$INVOCATION_BEFORE" ]; then
	note_fail "the unit did not start a new invocation — the old process is still serving"
fi

echo
echo "Verifying"
STARTED=$(show ExecMainStartTimestamp)
BANNER_WANTED="ClankerMux Server v$VERSION"
BANNER=""
DEADLINE=$((SECONDS + BANNER_TIMEOUT))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
	BANNER=$(journalctl -u "$UNIT" --since "$STARTED" --no-pager 2>/dev/null |
		grep -oE 'ClankerMux Server v[^ ]+' | tail -1 || true)
	[ "$BANNER" = "$BANNER_WANTED" ] && break
	sleep 2
done
[ "$BANNER" = "$BANNER_WANTED" ] ||
	note_fail "banner is '${BANNER:-<none logged>}', expected '$BANNER_WANTED'"

# Derive the health URL from the unit's own environment rather than assuming a
# port, so a moved backend port cannot make this check pass against nothing.
ENVIRONMENT=$(show Environment | tr ' ' '\n')
PORT=$(printf '%s\n' "$ENVIRONMENT" | sed -n 's/^PORT=//p' | tail -1)
HOST=$(printf '%s\n' "$ENVIRONMENT" | sed -n 's/^CLANKERMUX_HOST=//p' | tail -1)
URL="http://${HOST:-127.0.0.1}:${PORT:-8080}/"

# Readiness is not health: a process can answer once and die. Poll across a
# settle window and require every probe to succeed.
RESTARTS_AT_START=$(show NRestarts)
echo "  settling for ${SETTLE_SECONDS}s against $URL"
CODE=000
SETTLE_END=$((SECONDS + SETTLE_SECONDS))
while [ "$SECONDS" -lt "$SETTLE_END" ]; do
	CODE=$(curl -s --connect-timeout 5 --max-time 10 -o /dev/null \
		-w '%{http_code}' "$URL" || echo "000")
	[ "$CODE" = "200" ] || { note_fail "health check returned $CODE during settle"; break; }
	sleep 3
done

STATE=$(show ActiveState)
SUB=$(show SubState)
WD=$(show WorkingDirectory)
INVOCATION_END=$(show InvocationID)
# NRestarts counts AUTOMATIC restarts and is reset by an explicit restart, so
# comparing across the restart is meaningless. Comparing across the settle
# window is not: a climb there is a crashloop.
RESTARTS_END=$(show NRestarts)

echo "  state:        $STATE ($SUB)"
echo "  workdir:      $WD"
echo "  banner:       ${BANNER:-<none logged>}"
echo "  NRestarts:    $RESTARTS_AT_START -> $RESTARTS_END (during settle)"
echo "  http:         $CODE"

[ "$STATE" = "active" ] || note_fail "unit is $STATE"
[ "$SUB" = "running" ] || note_fail "unit sub-state is $SUB"
[ "$WD" = "$RELEASE" ] || note_fail "workdir is not the new snapshot"
[ "$INVOCATION_END" = "$INVOCATION_AFTER" ] ||
	note_fail "the unit restarted again during the settle window — it is crashlooping"
[ "$RESTARTS_END" = "$RESTARTS_AT_START" ] ||
	note_fail "restart counter climbed during the settle window"

if [ "$FAIL" -ne 0 ]; then
	echo >&2
	echo "Promotion of $SHA did NOT verify. The pin is ALREADY switched to it," >&2
	echo "so the next restart for any reason will use it. Roll back with:" >&2
	if [ -n "$CURRENT_SHA" ] && [ "$CURRENT_SHA" != "$SHA" ]; then
		echo "  scripts/promote-release.sh $CURRENT_SHA" >&2
	else
		echo "  scripts/promote-release.sh <a known-good sha>" >&2
	fi
	exit 1
fi

echo
echo "Promoted $SHA (v$VERSION)."
