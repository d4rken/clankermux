#!/usr/bin/env bun
/** Local-only login helper. Writes credentials with mode 0600; never prints tokens. */
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	createDevinLogin,
	type DevinLogin,
	exchangeDevinLogin,
} from "../packages/providers/src/providers/devin/auth";

const directory = resolve(import.meta.dir, "../.cache/devin-login");
const statePath = `${directory}/pending.json`;
const tokenPath = `${directory}/credentials.json`;
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);

if (process.argv[2] === "--complete") {
	const callbackPath = process.argv[3];
	if (!callbackPath)
		throw new Error(
			"Usage: bun scripts/devin-login.ts --complete /path/to/callback-url.txt",
		);
	const login: DevinLogin = JSON.parse(await readFile(statePath, "utf8"));
	const token = await exchangeDevinLogin(
		login,
		(await readFile(callbackPath, "utf8")).trim(),
	);
	await writeFile(tokenPath, JSON.stringify({ token }), { mode: 0o600 });
	await chmod(tokenPath, 0o600);
	await unlink(statePath).catch(() => {});
	console.log(`Signed in. Credentials saved to ${tokenPath}`);
} else {
	const login = createDevinLogin();
	await writeFile(statePath, JSON.stringify(login), { mode: 0o600 });
	await chmod(statePath, 0o600);
	console.log(`Open this URL in your browser:\n${login.url}\n`);
	console.log(
		`After login, if localhost does not open, save the full callback URL to a private file and run:\nbun scripts/devin-login.ts --complete /path/to/callback-url.txt\n`,
	);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 59653,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname !== "/callback")
				return new Response("Not found", { status: 404 });
			try {
				const token = await exchangeDevinLogin(login, req.url);
				await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
				await writeFile(tokenPath, JSON.stringify({ token }), { mode: 0o600 });
				await chmod(tokenPath, 0o600);
				await unlink(statePath).catch(() => {});
				console.log(`Signed in. Credentials saved to ${tokenPath}`);
				setTimeout(() => server.stop(), 100);
				return new Response("Signed in to Devin. You can close this window.", {
					headers: { "content-type": "text/plain" },
				});
			} catch {
				return new Response(
					"Login failed or expired. Restart the login helper.",
					{ status: 400 },
				);
			}
		},
	});
	setTimeout(() => server.stop(), 10 * 60_000).unref();
}
