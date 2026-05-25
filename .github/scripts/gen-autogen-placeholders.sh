#!/usr/bin/env bash
# Generate empty placeholders for the 5 gitignored auto-generated inline files.
#
# These files are normally produced by `bun run build:cli`, but they are
# gitignored and therefore absent on a fresh checkout (CI) or worktree. The
# real build embeds base64-encoded worker bundles + the tiktoken WASM blob;
# typecheck and `bun test` only need the exported symbols to resolve, so an
# empty string placeholder is sufficient and keeps CI fast (no full build).
#
# Keep this list in sync with the "File Exclusions" section of .claude/CLAUDE.md.
# Each entry is "<path>|<exported const name>".
set -euo pipefail

cd "$(dirname "$0")/../.."

files=(
	"packages/proxy/src/inline-worker.ts|EMBEDDED_WORKER_CODE"
	"packages/proxy/src/embedded-tiktoken-wasm.ts|EMBEDDED_TIKTOKEN_WASM"
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
