import { beforeEach, describe, expect, it } from "bun:test";
import {
	CLAUDE_STAINLESS_HEADERS,
	type ClaudeModelPermissionsAuth,
	claudeBankedResetHeaders,
	claudeCliUserAgent,
	claudeCodeExchangeHeaders,
	claudeCodeUserAgent,
	claudeCreateApiKeyHeaders,
	claudeKeepaliveHeaders,
	claudeModelCatalogueHeaders,
	claudeModelPermissionsHeaders,
	claudeProfileReadHeaders,
	claudeTokenRefreshHeaders,
	claudeUsageReadHeaders,
	compareClaudeCliVersions,
	lastSeenClaudeStainlessHeaders,
	newerClaudeCliVersion,
	newestClaudeCliVersion,
	resetClaudeCliStainlessHeadersForTests,
	trackClaudeCliStainlessHeaders,
} from "./claude-client-identity";
import { CLAUDE_CLI_VERSION, trackClientVersion } from "./version";

describe("compareClaudeCliVersions", () => {
	it("compares each segment numerically", () => {
		expect(compareClaudeCliVersions("2.1.63", "2.1.280")).toBe(-1);
		expect(compareClaudeCliVersions("2.1.280", "2.1.63")).toBe(1);
		expect(compareClaudeCliVersions("2.10.0", "2.9.99")).toBe(1);
		expect(compareClaudeCliVersions("10.0.0", "9.99.99")).toBe(1);
		expect(compareClaudeCliVersions("2.1.280", "2.1.280")).toBe(0);
		expect(compareClaudeCliVersions("01.2.3", "1.2.3")).toBe(0);
	});

	it("ranks a prerelease below its release and above the previous one", () => {
		expect(compareClaudeCliVersions("2.1.280-beta", "2.1.280")).toBe(-1);
		expect(compareClaudeCliVersions("2.1.280", "2.1.280-beta")).toBe(1);
		expect(compareClaudeCliVersions("2.1.281-beta", "2.1.280")).toBe(1);
	});

	it("orders prerelease identifiers by semver precedence", () => {
		expect(compareClaudeCliVersions("2.1.0-beta.2", "2.1.0-beta.10")).toBe(-1);
		expect(compareClaudeCliVersions("2.1.0-alpha", "2.1.0-beta")).toBe(-1);
		expect(compareClaudeCliVersions("2.1.0-1", "2.1.0-alpha")).toBe(-1);
		expect(compareClaudeCliVersions("2.1.0-beta", "2.1.0-beta.1")).toBe(-1);
	});

	it("ignores build metadata", () => {
		expect(compareClaudeCliVersions("2.1.280+b1", "2.1.280")).toBe(0);
		expect(compareClaudeCliVersions("2.1.280+b1", "2.1.280+b2")).toBe(0);
	});

	it("agrees with Bun.semver.order", () => {
		const versions = [
			"2.1.63",
			"2.1.280",
			"2.1.280-beta",
			"2.1.280-beta.2",
			"2.1.280-beta.10",
			"2.1.280-1",
			"2.1.280+b1",
			"2.10.0",
			"10.0.0",
		];
		for (const a of versions)
			for (const b of versions)
				expect([a, b, compareClaudeCliVersions(a, b)]).toEqual([
					a,
					b,
					Bun.semver.order(a, b),
				]);
	});

	it("throws on a string that is not a version", () => {
		expect(() => compareClaudeCliVersions("garbage", "2.1.280")).toThrow(
			"Invalid Claude CLI version: garbage",
		);
		expect(() => compareClaudeCliVersions("2.1.280", "2.1")).toThrow(
			"Invalid Claude CLI version: 2.1",
		);
	});
});

describe("version selection", () => {
	it("newerClaudeCliVersion keeps the first argument on a tie", () => {
		expect(newerClaudeCliVersion("2.1.63", "2.1.280")).toBe("2.1.280");
		expect(newerClaudeCliVersion("2.1.280+a", "2.1.280+b")).toBe("2.1.280+a");
	});

	it("newestClaudeCliVersion names the pinned version over an older client", () => {
		expect(newestClaudeCliVersion("2.1.63", "2.1.280")).toBe("2.1.280");
	});

	it("newestClaudeCliVersion names a newer client over the pinned version", () => {
		expect(newestClaudeCliVersion("2.1.999", "2.1.280")).toBe("2.1.999");
	});
});

describe("user agents", () => {
	it("builds both forms", () => {
		expect(claudeCodeUserAgent("2.1.280")).toBe("claude-code/2.1.280");
		expect(claudeCliUserAgent("2.1.280")).toBe(
			"claude-cli/2.1.280 (external, cli)",
		);
	});
});

describe("endpoint profiles", () => {
	it("usage read names the newer of last seen and pinned", () => {
		expect(claudeUsageReadHeaders("tok", "9.0.0")).toEqual({
			Authorization: "Bearer tok",
			"anthropic-beta": "oauth-2025-04-20",
			"Content-Type": "application/json",
			"User-Agent": "claude-cli/9.0.0 (external, cli)",
			Accept: "application/json, text/plain, */*",
			"Accept-Encoding": "gzip, compress, deflate, br",
		});
		expect(claudeUsageReadHeaders("tok", "2.1.63")["User-Agent"]).toBe(
			`claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
		);
	});

	it("banked reset sends the usage read's headers", () => {
		for (const lastSeen of ["2.1.63", "9.0.0"])
			expect(claudeBankedResetHeaders("tok", lastSeen)).toEqual(
				claudeUsageReadHeaders("tok", lastSeen),
			);
	});

	it("profile read", () => {
		expect(claudeProfileReadHeaders("tok")).toEqual({
			Authorization: "Bearer tok",
			"Content-Type": "application/json",
			"Cache-Control": "no-cache",
			"User-Agent": "axios/1.15.2",
			Accept: "application/json, text/plain, */*",
			"Accept-Encoding": "gzip, compress, deflate, br",
		});
	});

	it("keepalive names the last client seen, even an older one", () => {
		expect(claudeKeepaliveHeaders("2.1.63", CLAUDE_STAINLESS_HEADERS)).toEqual({
			accept: "application/json",
			"anthropic-beta":
				"interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219,advisor-tool-2026-03-01,oauth-2025-04-20",
			"anthropic-dangerous-direct-browser-access": "true",
			"anthropic-version": "2023-06-01",
			connection: "keep-alive",
			"content-type": "application/json",
			"user-agent": "claude-cli/2.1.63 (external, cli)",
			"x-app": "cli",
			"x-stainless-arch": "x64",
			"x-stainless-lang": "js",
			"x-stainless-os": "Linux",
			"x-stainless-package-version": "0.112.1",
			"x-stainless-retry-count": "0",
			"x-stainless-runtime": "node",
			"x-stainless-runtime-version": "v26.3.0",
			"x-stainless-timeout": "600",
		});
	});

	describe("keepalive Stainless block", () => {
		beforeEach(() => resetClaudeCliStainlessHeadersForTests());

		const cli = (
			extra: Record<string, string>,
			ua = "claude-cli/2.1.281 (external, cli)",
		) =>
			new Headers({
				"user-agent": ua,
				"x-stainless-arch": "arm64",
				"x-stainless-lang": "js",
				"x-stainless-os": "MacOS",
				"x-stainless-package-version": "0.113.0",
				"x-stainless-retry-count": "2",
				"x-stainless-runtime": "node",
				"x-stainless-runtime-version": "v26.4.0",
				"x-stainless-timeout": "300",
				...extra,
			});

		it("mirrors the runtime of the last interactive client, not its per-request fields", () => {
			trackClaudeCliStainlessHeaders(cli({}));
			expect(lastSeenClaudeStainlessHeaders()).toEqual({
				"x-stainless-arch": "arm64",
				"x-stainless-lang": "js",
				"x-stainless-os": "MacOS",
				"x-stainless-package-version": "0.113.0",
				"x-stainless-retry-count": "0",
				"x-stainless-runtime": "node",
				"x-stainless-runtime-version": "v26.4.0",
				"x-stainless-timeout": "600",
			});
			expect(claudeKeepaliveHeaders("2.1.281")["x-stainless-os"]).toBe("MacOS");
		});

		it("names the interactive client's version, not a later Agent SDK request's", () => {
			trackClaudeCliStainlessHeaders(cli({}));
			trackClientVersion(
				"claude-cli/2.1.299 (external, sdk-ts, agent-sdk/0.3.299)",
			);
			expect(claudeKeepaliveHeaders()["user-agent"]).toBe(
				"claude-cli/2.1.281 (external, cli)",
			);
		});

		it("ignores Agent SDK clients, incomplete blocks and malformed values", () => {
			trackClaudeCliStainlessHeaders(cli({}));
			const before = lastSeenClaudeStainlessHeaders();
			trackClaudeCliStainlessHeaders(
				cli(
					{ "x-stainless-os": "Linux" },
					"claude-cli/2.1.281 (external, sdk-ts, agent-sdk/0.3.281)",
				),
			);
			const missing = cli({});
			missing.delete("x-stainless-runtime-version");
			trackClaudeCliStainlessHeaders(missing);
			trackClaudeCliStainlessHeaders(cli({ "x-stainless-os": "Linux; x" }));
			expect(lastSeenClaudeStainlessHeaders()).toBe(before);
		});
	});

	it("model catalogue", () => {
		expect(claudeModelCatalogueHeaders("tok")).toEqual({
			authorization: "Bearer tok",
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "oauth-2025-04-20",
		});
	});

	it("model permissions, OAuth", () => {
		expect(claudeModelPermissionsHeaders({ bearer: "tok" })).toEqual({
			"anthropic-version": "2023-06-01",
			authorization: "Bearer tok",
			"anthropic-beta": "oauth-2025-04-20",
		});
	});

	it("model permissions, API key", () => {
		expect(claudeModelPermissionsHeaders({ apiKey: "key" })).toEqual({
			"anthropic-version": "2023-06-01",
			"x-api-key": "key",
		});
	});

	it("model permissions take one credential, never both", () => {
		// @ts-expect-error bearer and apiKey are exclusive
		const both: ClaudeModelPermissionsAuth = { bearer: "tok", apiKey: "key" };
		expect(both).toBeDefined();
	});

	it("token refresh and code exchange", () => {
		const axios = {
			"Content-Type": "application/json",
			"User-Agent": "axios/1.15.2",
			Accept: "application/json, text/plain, */*",
			"Accept-Encoding": "gzip, compress, deflate, br",
		};
		expect(claudeTokenRefreshHeaders()).toEqual(axios);
		expect(claudeCodeExchangeHeaders()).toEqual(axios);
	});

	it("create API key names the newer of last seen and pinned", () => {
		trackClientVersion("claude-cli/2.1.63 (external, cli)");
		expect(claudeCreateApiKeyHeaders("tok")).toEqual({
			Authorization: "Bearer tok",
			"User-Agent": `claude-code/${CLAUDE_CLI_VERSION}`,
			Accept: "application/json, text/plain, */*",
			"Accept-Encoding": "gzip, compress, deflate, br",
		});
		trackClientVersion("claude-cli/2.1.999 (external, cli)");
		expect(claudeCreateApiKeyHeaders("tok")["User-Agent"]).toBe(
			"claude-code/2.1.999",
		);
	});

	it("returns a fresh object on every call", () => {
		const first = claudeKeepaliveHeaders("2.1.63");
		first["x-app"] = "changed";
		expect(claudeKeepaliveHeaders("2.1.63")["x-app"]).toBe("cli");
	});
});
