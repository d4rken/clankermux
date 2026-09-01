/**
 * Stands in for the provider APIs while the README screenshots are captured.
 *
 * The capture instance runs inside a network namespace with no route off
 * loopback, and a bind-mounted `/etc/hosts` maps the provider hostnames to
 * 127.0.0.1 — so this process is the only thing the proxy's usage pollers can
 * reach. That matters twice over: the repo forbids automated requests to
 * api.anthropic.com outright, and the alternative (letting every poll fail)
 * makes the dashboard render its "live usage unavailable, showing last known
 * data" state, which is not what the README should advertise.
 *
 * Serves TLS on :443 with a certificate whose SANs cover every stubbed host;
 * the proxy trusts it via NODE_EXTRA_CA_CERTS.
 *
 * Usage:
 *   bun scripts/readme-media/stub-upstream.ts --cert <pem> --key <pem> [--port 443]
 */

import { MOCK_ACCOUNTS, type MockAccount } from "./mock-data";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface Args {
	certPath: string;
	keyPath: string;
	port: number;
	headSha: string;
}

function parseArgs(argv: string[]): Args {
	let certPath = "";
	let keyPath = "";
	let port = 443;
	let headSha = "";
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--cert") certPath = argv[++i] ?? "";
		else if (arg === "--key") keyPath = argv[++i] ?? "";
		else if (arg === "--port") port = Number(argv[++i]);
		else if (arg === "--head-sha") headSha = argv[++i] ?? "";
	}
	if (!certPath || !keyPath) throw new Error("--cert and --key are required");
	if (!Number.isFinite(port)) throw new Error("--port must be a number");
	return { certPath, keyPath, port, headSha };
}

/** Bearer tokens are seeded as `mock-access-<account id>`; map back. */
function accountForRequest(req: Request): MockAccount | null {
	const auth = req.headers.get("authorization") ?? "";
	const token = auth.replace(/^Bearer\s+/i, "").trim();
	const id = token.replace(/^mock-access-/, "");
	return MOCK_ACCOUNTS.find((a) => a.id === id) ?? null;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Anthropic's OAuth usage payload. Emits BOTH the flat windows and the generic
 * `limits[]` array, which is what the live API does today — the normalizer
 * prefers the flat pair and reads `limits[]` for the per-family weekly windows
 * that have no flat equivalent.
 */
function anthropicUsage(account: MockAccount, now: number): Response {
	const fiveHourPct = (account.fiveHourPct ?? 0) * 100;
	const sevenDayPct = (account.sevenDayPct ?? 0) * 100;
	// Keep these two instants in step with seed-mock-db.ts, so the live reading
	// and the historical series behind the chart tell the same story.
	const fiveHourReset = new Date(
		now + (1 - (account.fiveHourPct ?? 0)) * 5 * HOUR_MS,
	).toISOString();
	const weeklyReset = new Date(now + 3 * DAY_MS + 7 * HOUR_MS).toISOString();

	const scoped =
		account.id === "acct-aurora"
			? [
					{ family: "Claude Opus 5", id: "claude-opus-5", pct: sevenDayPct * 1.12 },
					{ family: "Claude Sonnet 5", id: "claude-sonnet-5", pct: sevenDayPct * 0.58 },
				]
			: [
					{ family: "Claude Sonnet 5", id: "claude-sonnet-5", pct: sevenDayPct * 0.81 },
					{ family: "Claude Fable 5", id: "claude-fable-5", pct: sevenDayPct * 0.36 },
				];

	return json({
		five_hour: { utilization: fiveHourPct, resets_at: fiveHourReset },
		seven_day: { utilization: sevenDayPct, resets_at: weeklyReset },
		limits: [
			{
				kind: "session",
				group: "default",
				percent: fiveHourPct,
				resets_at: fiveHourReset,
				scope: null,
				is_active: true,
			},
			{
				kind: "weekly_all",
				group: "default",
				percent: sevenDayPct,
				resets_at: weeklyReset,
				scope: null,
				is_active: true,
			},
			...scoped.map((entry) => ({
				kind: "weekly_scoped",
				group: "default",
				percent: Math.min(99, Number(entry.pct.toFixed(2))),
				resets_at: weeklyReset,
				scope: { model: { id: entry.id, display_name: entry.family } },
				is_active: true,
			})),
		],
	});
}

/** `chatgpt.com/backend-api/wham/usage`, the free Codex rate-limit read. */
function codexUsage(account: MockAccount, now: number): Response {
	const fivePct = (account.fiveHourPct ?? 0) * 100;
	const weekPct = (account.sevenDayPct ?? 0) * 100;
	return json({
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: {
				used_percent: fivePct,
				limit_window_seconds: 5 * 60 * 60,
				reset_after_seconds: Math.round((1 - (account.fiveHourPct ?? 0)) * 5 * 3600),
			},
			secondary_window: {
				used_percent: weekPct,
				limit_window_seconds: 7 * 24 * 60 * 60,
				reset_after_seconds: Math.round((now + 3 * DAY_MS + 7 * HOUR_MS - now) / 1000),
			},
		},
		plan_type: account.planTier,
		credits: { has_credits: false, balance: 0, unlimited: false },
	});
}

/**
 * The update check asks GitHub for the tip of the repo's main branch and
 * compares it to the running checkout's HEAD. Answering with the checkout's own
 * sha makes the sidebar read "up to date"; with no answer at all it reads
 * "Status Unknown — could not reach GitHub", which is a fact about the capture
 * rig having no network, not about the product.
 */
function githubCommit(headSha: string, now: number): Response {
	return json({
		sha: headSha,
		html_url: `https://github.com/d4rken/clankermux/commit/${headSha}`,
		commit: { committer: { date: new Date(now - 2 * HOUR_MS).toISOString() } },
	});
}

function main(): void {
	const { certPath, keyPath, port, headSha } = parseArgs(process.argv.slice(2));

	const server = Bun.serve({
		port,
		hostname: "127.0.0.1",
		tls: {
			cert: Bun.file(certPath),
			key: Bun.file(keyPath),
		},
		fetch(req) {
			const url = new URL(req.url);
			const account = accountForRequest(req);
			const now = Date.now();

			// One line per served request. The orchestrator greps this to prove the
			// pollers actually reached the stub: a dead stub is otherwise invisible,
			// because the dashboard falls back to the seeded snapshots and captures
			// a "showing last known data" state that still looks plausible.
			console.log(`served ${url.pathname} ${account?.id ?? "anon"}`);

			if (url.pathname === "/api/oauth/usage") {
				if (!account) return json({ error: { type: "authentication_error" } }, 401);
				return anthropicUsage(account, now);
			}
			if (url.pathname === "/api/oauth/profile") {
				if (!account) return json({ error: { type: "authentication_error" } }, 401);
				return json({
					account: { email_address: account.email, uuid: account.id },
					organization: { name: account.organization, uuid: `org-${account.id}` },
				});
			}
			if (url.pathname === "/backend-api/wham/usage") {
				if (!account) return json({ error: { type: "authentication_error" } }, 401);
				return codexUsage(account, now);
			}
			if (url.pathname === "/backend-api/codex/rate-limit-reset-credits") {
				// Earned reset credits are a separate read the accounts endpoint
				// kicks off for every Codex account. Two banked credits rather than
				// zero: the chip renders either way, and "0 usage resets" is a chip
				// that costs a line and says nothing.
				if (!account) return json({ error: { type: "authentication_error" } }, 401);
				const granted = Math.floor((now - 2 * DAY_MS) / 1000);
				const expires = Math.floor((now + 11 * DAY_MS) / 1000);
				return json({
					rateLimitResetCredits: {
						availableCount: 2,
						credits: [
							{
								id: "credit-1",
								resetType: "primary",
								status: "available",
								grantedAt: granted,
								expiresAt: expires,
								title: "Usage reset",
								description: null,
							},
							{
								id: "credit-2",
								resetType: "primary",
								status: "available",
								grantedAt: granted,
								expiresAt: expires,
								title: "Usage reset",
								description: null,
							},
						],
					},
				});
			}

			if (url.pathname.startsWith("/repos/") && headSha) {
				if (url.pathname.includes("/commits/")) {
					return githubCommit(headSha, now);
				}
				// A compare against our own sha is zero commits behind.
				if (url.pathname.includes("/compare/")) {
					return json({ status: "identical", ahead_by: 0, behind_by: 0 });
				}
			}

			// Anything else is a path the capture does not exercise. Answer 404
			// rather than hanging, so an unexpected call fails fast and visibly.
			console.error(`stub-upstream: unhandled ${req.method} ${url.host}${url.pathname}`);
			return json({ error: { type: "not_found", path: url.pathname } }, 404);
		},
	});

	console.log(`stub-upstream listening on https://127.0.0.1:${server.port}`);
}

main();
