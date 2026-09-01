#!/usr/bin/env bash
#
# Captures the README dashboard screenshots from a real, isolated ClankerMux.
#
# The instance this boots is the actual server and the actual dashboard bundle,
# pointed at a synthetic database (scripts/readme-media/seed-mock-db.ts) and a
# stub provider API (scripts/readme-media/stub-upstream.ts). It runs inside a
# user + mount + network namespace, so:
#
#   - it has no route off loopback and cannot reach any real provider, which the
#     repo forbids for automated traffic;
#   - a bind-mounted /etc/hosts points the provider hostnames at the stub, so the
#     usage pollers get answers and the dashboard renders live readings rather
#     than its "showing last known data" fallback;
#   - the user's own config dir and database are never opened (XDG_CONFIG_HOME
#     and CLANKERMUX_DB_PATH both point into the scratch dir).
#
# Everything lives in a temp dir that is removed on exit. Requires the dashboard
# bundle to be built already (bun run build:dashboard).
#
# Usage: scripts/capture-readme-screenshots.sh [output-dir]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$REPO_ROOT/docs/media}"
BUN="${BUN:-/home/darken/.bun/bin/bun}"
PORT=8081

# Hosts the proxy reaches for: provider usage endpoints, plus GitHub for the
# sidebar's update check. Everything else has nowhere to go.
STUB_HOSTS=(api.anthropic.com chatgpt.com api.openai.com auth.openai.com openrouter.ai api.github.com)

# Answering the update check with our own HEAD makes the sidebar read "up to
# date" instead of "could not reach GitHub".
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

# Matches CAPTURE_PASSWORD in seed-mock-db.ts. Guards a throwaway database.
CAPTURE_PASSWORD="readme-capture-only"

WORK_DIR="$(mktemp -d -t clankermux-readme-XXXXXX)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

echo "==> scratch dir: $WORK_DIR"
mkdir -p "$WORK_DIR/config/clankermux" "$WORK_DIR/logs" "$OUT_DIR"

# Redirect every path the app resolves from the environment, BEFORE the seeder
# runs — it imports @clankermux/database, and the logger singleton opens its
# file at module load, outside the namespace. Left alone it would default to
# /tmp/clankermux-logs/app.log, which is the LIVE instance's log: a capture run
# would append to it and, past 10 MiB, rotate it. CONFIG_PATH is set explicitly
# because an inherited CLANKERMUX_CONFIG_PATH takes precedence over the
# XDG_CONFIG_HOME redirect, which would otherwise be silently bypassed. The
# legacy prefixes rank below CLANKERMUX_ in readEnv and so cannot win, but they
# are cleared anyway so a stray one cannot surprise a future reader.
export CLANKERMUX_LOG_DIR="$WORK_DIR/logs"
# Must sit under $XDG_CONFIG_HOME/clankermux/: the config loader runs the path
# through the security path-validator, which allows only the app's own directory
# inside the XDG root.
export CLANKERMUX_CONFIG_PATH="$WORK_DIR/config/clankermux/clankermux.json"
export CLANKERMUX_DB_PATH="$WORK_DIR/mock.db"
export XDG_CONFIG_HOME="$WORK_DIR/config"
unset BETTER_CCFLARE_LOG_DIR BETTER_CCFLARE_CONFIG_PATH BETTER_CCFLARE_DB_PATH
unset ccflare_LOG_DIR ccflare_CONFIG_PATH ccflare_DB_PATH

# --- TLS: a throwaway CA and one leaf covering every stubbed host -------------
# A CA rather than a bare self-signed leaf, because NODE_EXTRA_CA_CERTS is a
# trust anchor list: a leaf placed there is not universally honoured, a CA is.
echo "==> generating throwaway CA and leaf certificate"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
	-keyout "$WORK_DIR/ca.key" -out "$WORK_DIR/ca.pem" \
	-subj "/CN=ClankerMux README capture CA" >/dev/null 2>&1

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
echo "==> seeding mock database"
"$BUN" "$REPO_ROOT/scripts/readme-media/seed-mock-db.ts" --db "$WORK_DIR/mock.db"

# --- everything below runs with no route off loopback ------------------------
export REPO_ROOT OUT_DIR BUN PORT WORK_DIR HEAD_SHA CAPTURE_PASSWORD

# The namespaced half runs from a FILE, not from a quoted `bash -c` string.
# A single-quoted inline script ends at the first apostrophe, so one ordinary
# English contraction in a comment silently drops the rest of the block back
# into the outer shell — where the server is not listening and the failure
# reads as a connection refusal. Writing it out removes the whole class.
cat >"$WORK_DIR/inner.sh" <<'INNER'
ip link set lo up
mount --bind "$WORK_DIR/hosts" /etc/hosts

# The path redirects are already exported outside the namespace, so the
# seeding step got them too; only the CA is namespace-specific.
export NODE_EXTRA_CA_CERTS="$WORK_DIR/ca.pem"

# Chromium builds its throwaway profile with mkdtemp under TMPDIR. Pointing
# that inside WORK_DIR means the trap below reclaims it even when the capture
# is killed before it can clean up after itself.
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

# Wait for the usage pollers to reach the stub and warm the cache, so the
# account cards render live readings. This is asserted rather than assumed:
# with a dead stub the dashboard silently falls back to the seeded snapshots
# and renders "Live usage unavailable — showing last known data" on every
# account, which is a plausible-looking screenshot of the wrong thing.
echo "==> waiting for the usage pollers to reach the stub"
for _ in $(seq 1 40); do
	if grep -q "served /api/oauth/usage" "$WORK_DIR/stub.log" 2>/dev/null &&
		grep -q "served /backend-api/wham/usage" "$WORK_DIR/stub.log" 2>/dev/null; then
		break
	fi
	sleep 1
done
if ! grep -q "served /api/oauth/usage" "$WORK_DIR/stub.log" 2>/dev/null; then
	echo "the Anthropic usage poll never reached the stub; stub log:" >&2
	tail -40 "$WORK_DIR/stub.log" >&2
	exit 1
fi
if ! grep -q "served /backend-api/wham/usage" "$WORK_DIR/stub.log" 2>/dev/null; then
	echo "the Codex usage poll never reached the stub; stub log:" >&2
	tail -40 "$WORK_DIR/stub.log" >&2
	exit 1
fi
if grep -q "unhandled" "$WORK_DIR/stub.log"; then
	echo "the stub was asked for a path it does not serve:" >&2
	grep "unhandled" "$WORK_DIR/stub.log" >&2
	exit 1
fi
# The polls have landed; let the dashboard's own refresh pick them up.
sleep 5

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
	echo "the server exited before the capture; last 40 lines:" >&2
	tail -40 "$WORK_DIR/server.log" >&2
	exit 1
fi
if ! curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
	echo "the server stopped answering before the capture; last 40 lines:" >&2
	tail -40 "$WORK_DIR/server.log" >&2
	exit 1
fi

echo "==> capturing"
if ! "$BUN" "$REPO_ROOT/scripts/readme-media/capture.ts" \
	--base-url "http://127.0.0.1:$PORT" --out-dir "$OUT_DIR" \
	--password "$CAPTURE_PASSWORD"; then
	# The capture only ever sees "the page would not load". Whatever the server
	# said on its way down is in its own log, and the namespace takes both with
	# it on exit.
	echo "capture failed; last 40 lines of the server log:" >&2
	tail -40 "$WORK_DIR/server.log" >&2
	exit 1
fi
INNER

unshare --user --map-root-user --mount --net -- bash -euo pipefail "$WORK_DIR/inner.sh"

echo "==> done; wrote to $OUT_DIR"
