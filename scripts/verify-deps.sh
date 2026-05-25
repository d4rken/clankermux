#!/usr/bin/env bash
# verify-deps.sh — deploy-time supply-chain gate.
#
# The systemd service runs ClankerMux straight from this working tree with no
# install step, so whatever is in node_modules at start time is what gets
# deployed. This script verifies that the installed dependency tree exactly
# matches the committed, integrity-hashed bun.lock before the proxy starts.
#
# `bun install --frozen-lockfile`:
#   - refuses to modify bun.lock (errors if package.json and lockfile disagree),
#   - installs/relinks node_modules to match the lockfile's pinned versions and
#     sha512 integrity hashes, rejecting tampered or drifted artifacts.
#
# Wired as ExecStartPre= so it is FAIL-CLOSED: if verification fails the proxy
# does not start. That is deliberate — deploying an unverified dependency tree
# is worse than a short outage. To start anyway during an incident, comment out
# the ExecStartPre line in the systemd drop-in and `systemctl daemon-reload`.
#
# Exits 0 on success, non-zero on any mismatch.
set -euo pipefail

cd "$(dirname "$0")/.."

BUN="${BUN_BIN:-bun}"
command -v "$BUN" >/dev/null 2>&1 || BUN="/home/darken/.bun/bin/bun"

echo "verify-deps: checking node_modules against bun.lock (--frozen-lockfile)…" >&2
if "$BUN" install --frozen-lockfile; then
	echo "verify-deps: OK — installed dependencies match the locked, integrity-hashed tree." >&2
	exit 0
fi

echo "verify-deps: FAILED — node_modules does not match bun.lock." >&2
echo "verify-deps: refusing to start with an unverified dependency tree." >&2
exit 1
