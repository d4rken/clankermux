/**
 * Which management paths the session gate covers.
 *
 * The two classes that are easy to get wrong are both asserted by name rather
 * than by pattern: the auth endpoints (gating them would make logging in
 * require already being logged in) and the two Claude Code telemetry paths that
 * reach the ROOT of the port (gating them on a dashboard cookie breaks agent
 * clients, which is the failure this classification exists to avoid).
 */
import { describe, expect, it } from "bun:test";
import {
	isManagementPath,
	managementAuthRequirement,
} from "../management-auth-policy";

describe("public by classification", () => {
	for (const path of [
		"/api/auth/login",
		"/api/auth/logout",
		"/api/auth/status",
	]) {
		it(`leaves ${path} ungated`, () => {
			expect(managementAuthRequirement(path)).toBe("public");
		});
	}

	for (const path of [
		"/api/event_logging/batch",
		"/api/system/package-manager",
	]) {
		it(`leaves the Claude Code telemetry path ${path} ungated`, () => {
			expect(managementAuthRequirement(path)).toBe("public");
		});
	}

	it("gates neighbours of the telemetry paths — the list is exact-match", () => {
		expect(managementAuthRequirement("/api/event_logging/v2/batch")).toBe(
			"session",
		);
		expect(managementAuthRequirement("/api/event_logging")).toBe("session");
		expect(managementAuthRequirement("/api/system/package-manager/x")).toBe(
			"session",
		);
	});

	it("gates neighbours of the auth paths", () => {
		expect(managementAuthRequirement("/api/auth")).toBe("session");
		expect(managementAuthRequirement("/api/auth/login/extra")).toBe("session");
		expect(managementAuthRequirement("/api/authx")).toBe("session");
	});
});

describe("session by classification", () => {
	for (const path of [
		"/api",
		"/api/accounts",
		"/api/accounts/abc-123/pause",
		"/api/config",
		"/api/logs/stream",
		"/api/requests/stream",
		"/api/not-a-real-route",
	]) {
		it(`gates ${path}`, () => {
			expect(managementAuthRequirement(path)).toBe("session");
		});
	}
});

describe("outside the management namespace", () => {
	for (const path of [
		"/",
		"/health",
		"/public/v1/status",
		"/client/v1/retention",
		"/v1/messages",
		"/wire/anthropic/v1/messages",
		"/assets/app.js",
		"/apiary",
	]) {
		it(`leaves ${path} to its own policy`, () => {
			expect(managementAuthRequirement(path)).toBe("public");
			expect(isManagementPath(path)).toBe(false);
		});
	}

	it("recognizes the management namespace exactly", () => {
		expect(isManagementPath("/api")).toBe(true);
		expect(isManagementPath("/api/")).toBe(true);
		expect(isManagementPath("/api/accounts")).toBe(true);
		expect(isManagementPath("/apiary")).toBe(false);
	});

	// The credential-scoped client API is a SIBLING mount, not a carve-out. It
	// is reachable with a client key, and that key must never be a step towards
	// the management surface — which is guaranteed by this classification never
	// growing an entry for it, rather than by an exemption that could.
	it("holds no exemption for the client API", () => {
		for (const path of [
			"/client",
			"/client/",
			"/client/v1/retention",
			"/api/client",
			"/api/client/v1/retention",
		]) {
			expect(managementAuthRequirement(path)).toBe(
				path.startsWith("/api/") ? "session" : "public",
			);
		}
	});
});
