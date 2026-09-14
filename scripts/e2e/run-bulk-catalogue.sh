#!/usr/bin/env bash
#
# Runs the bulk catalogue editor end to end against a real, isolated ClankerMux.
#
# The instance this boots is the actual server and the actual dashboard bundle,
# pointed at a synthetic database (scripts/e2e/seed-bulk-db.ts) and a stub
# provider API (scripts/readme-media/stub-upstream.ts). It runs inside a user +
# mount + network namespace, so:
#
#   - it has no route off loopback and cannot reach any real provider, which the
#     repo forbids for automated traffic;
#   - a bind-mounted /etc/hosts points the provider hostnames at the stub, so
#     the background pollers get answers instead of hanging on DNS;
#   - the user's own config dir and database are never opened (XDG_CONFIG_HOME
#     and CLANKERMUX_DB_PATH both point into the scratch dir).
#
# Everything lives in a temp dir that is removed on exit. Requires the dashboard
# bundle to be built already (bun run build:dashboard).
#
# Usage: scripts/e2e/run-bulk-catalogue.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUN="${BUN:-/home/darken/.bun/bin/bun}"
# Not 8081: the README capture uses that, and the two are run back to back.
PORT=8082

STUB_HOSTS=(api.anthropic.com chatgpt.com api.openai.com auth.openai.com openrouter.ai api.github.com)

HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

# Matches E2E_PASSWORD in seed-bulk-db.ts. Guards a throwaway database.
E2E_PASSWORD="bulk-catalogue-e2e"

WORK_DIR="$(mktemp -d -t clankermux-e2e-XXXXXX)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

echo "==> scratch dir: $WORK_DIR"
mkdir -p "$WORK_DIR/config/clankermux" "$WORK_DIR/logs"

# Redirect every path the app resolves from the environment, BEFORE the seeder
# runs — it imports @clankermux/database, and the logger singleton opens its
# file at module load. Left alone it would default to /tmp/clankermux-logs/app.log,
# which is the LIVE instance's log: this run would append to it and, past
# 10 MiB, rotate it. CONFIG_PATH is set explicitly because an inherited
# CLANKERMUX_CONFIG_PATH takes precedence over the XDG_CONFIG_HOME redirect.
export CLANKERMUX_LOG_DIR="$WORK_DIR/logs"
export CLANKERMUX_CONFIG_PATH="$WORK_DIR/config/clankermux/clankermux.json"
export CLANKERMUX_DB_PATH="$WORK_DIR/e2e.db"
export XDG_CONFIG_HOME="$WORK_DIR/config"

# --- TLS: a throwaway CA and one leaf covering every stubbed host -------------
echo "==> generating throwaway CA and leaf certificate"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
	-keyout "$WORK_DIR/ca.key" -out "$WORK_DIR/ca.pem" \
	-subj "/CN=ClankerMux e2e CA" >/dev/null 2>&1

SAN_LINE="subjectAltName=$(printf 'DNS:%s,' "${STUB_HOSTS[@]}" | sed 's/,$//')"
openssl req -newkey rsa:2048 -nodes \
	-keyout "$WORK_DIR/leaf.key" -out "$WORK_DIR/leaf.csr" \
	-subj "/CN=api.anthropic.com" >/dev/null 2>&1
openssl x509 -req -in "$WORK_DIR/leaf.csr" -days 2 \
	-CA "$WORK_DIR/ca.pem" -CAkey "$WORK_DIR/ca.key" -CAcreateserial \
	-out "$WORK_DIR/leaf.pem" \
	-extfile <(printf '%s\n' "$SAN_LINE") >/dev/null 2>&1

# --- hosts file the namespace will see ---------------------------------------
{
	echo "127.0.0.1 localhost"
	for host in "${STUB_HOSTS[@]}"; do
		echo "127.0.0.1 $host"
	done
} >"$WORK_DIR/hosts"

# --- synthetic database ------------------------------------------------------
echo "==> seeding database"
"$BUN" "$REPO_ROOT/scripts/e2e/seed-bulk-db.ts" --db "$WORK_DIR/e2e.db"

# --- everything below runs with no route off loopback ------------------------
export REPO_ROOT BUN PORT WORK_DIR HEAD_SHA E2E_PASSWORD

# The namespaced half runs from a FILE, not from a quoted `bash -c` string. A
# single-quoted inline script ends at the first apostrophe, so one ordinary
# English contraction in a comment silently drops the rest of the block back
# into the outer shell — where the server is not listening and the failure reads
# as a connection refusal.
cat >"$WORK_DIR/inner.sh" <<'INNER'
ip link set lo up
mount --bind "$WORK_DIR/hosts" /etc/hosts

export NODE_EXTRA_CA_CERTS="$WORK_DIR/ca.pem"

# Chromium builds its throwaway profile with mkdtemp under TMPDIR. Pointing that
# inside WORK_DIR means the trap below reclaims it even when the run is killed
# before it can clean up after itself.
mkdir -p "$WORK_DIR/tmp"
export TMPDIR="$WORK_DIR/tmp"

echo "==> starting stub upstream"
"$BUN" "$REPO_ROOT/scripts/readme-media/stub-upstream.ts" \
	--cert "$WORK_DIR/leaf.pem" --key "$WORK_DIR/leaf.key" \
	--head-sha "$HEAD_SHA" \
	>"$WORK_DIR/stub.log" 2>&1 &
STUB_PID=$!

echo "==> starting clankermux on :$PORT"
( cd "$REPO_ROOT" && "$BUN" run apps/server/src/server.ts --port "$PORT" ) \
	>"$WORK_DIR/server.log" 2>&1 &
SERVER_PID=$!

shutdown() {
	kill "$SERVER_PID" "$STUB_PID" 2>/dev/null || true
	wait "$SERVER_PID" "$STUB_PID" 2>/dev/null || true
}
trap shutdown EXIT

echo "==> waiting for the dashboard to answer"
for _ in $(seq 1 60); do
	if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
		break
	fi
	sleep 1
done
if ! curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
	echo "server did not come up; last 40 lines:" >&2
	tail -40 "$WORK_DIR/server.log" >&2
	exit 1
fi

echo "==> driving the bulk catalogue editor"
if ! "$BUN" "$REPO_ROOT/scripts/e2e/bulk-catalogue.ts" \
	--base-url "http://127.0.0.1:$PORT" \
	--db "$WORK_DIR/e2e.db" \
	--password "$E2E_PASSWORD"; then
	# The driver only ever sees "the page would not do what I asked". Whatever
	# the server said is in its own log, and the namespace takes both with it.
	echo "the run failed; last 40 lines of the server log:" >&2
	tail -40 "$WORK_DIR/server.log" >&2
	exit 1
fi
INNER

unshare --user --map-root-user --mount --net -- bash -euo pipefail "$WORK_DIR/inner.sh"

echo "==> done"
