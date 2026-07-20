#!/usr/bin/env bash
# Generate empty placeholders for the 3 gitignored auto-generated inline DB
# worker files.
#
# These files are normally produced by `bun run build:db-workers`, but they are
# gitignored and therefore absent on a fresh checkout (CI) or worktree. The real
# build embeds base64-encoded worker bundles; typecheck and `bun test` only need
# the exported symbols to resolve, so an empty string placeholder is sufficient
# and keeps CI fast (no full build). (Committed .d.ts stubs already satisfy
# typecheck on a clean checkout; these .ts placeholders additionally satisfy
# `bun test`, which executes the real modules at runtime.)
#
# The retired proxy worker (inline-worker.ts) and tiktoken WASM blob
# (embedded-tiktoken-wasm.ts) are no longer generated or imported, so they are
# intentionally absent from this list — see the "File Exclusions" section of
# .claude/CLAUDE.md, which this list is kept in sync with.
# Each entry is "<path>|<exported const name>".
set -euo pipefail

cd "$(dirname "$0")/../.."

files=(
	"packages/database/src/inline-vacuum-worker.ts|EMBEDDED_VACUUM_WORKER_CODE"
	"packages/database/src/inline-integrity-check-worker.ts|EMBEDDED_INTEGRITY_CHECK_WORKER_CODE"
	"packages/database/src/inline-incremental-vacuum-worker.ts|EMBEDDED_INCREMENTAL_VACUUM_WORKER_CODE"
)

for entry in "${files[@]}"; do
	path="${entry%%|*}"
	name="${entry##*|}"
	if [ -f "$path" ]; then
		echo "skip (exists): $path"
	else
		printf 'export const %s = "";\n' "$name" >"$path"
		echo "wrote placeholder: $path"
	fi
done
