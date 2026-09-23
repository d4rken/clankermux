#!/usr/bin/env bun
/** `bun run auth:password`; the command lives in packages/http-api/src/cli/auth-password.ts. */

import { runAuthPasswordCli } from "@clankermux/http-api";

if (import.meta.main) {
	process.exit(
		await runAuthPasswordCli(process.argv.slice(2), "bun run auth:password"),
	);
}
