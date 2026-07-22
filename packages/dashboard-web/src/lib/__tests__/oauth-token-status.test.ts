import { describe, expect, it } from "bun:test";
import {
	fetchAccountTokenStatus,
	resolveTokenChip,
	resolveTokenStatusDisplay,
	type TokenStatus,
	tokenStatusTooltip,
} from "../oauth-token-status";

describe("resolveTokenStatusDisplay", () => {
	it("never spins on a terminal error — renders a static unavailable icon (regression guard)", () => {
		const display = resolveTokenStatusDisplay("error");
		expect(display.spin).toBe(false);
		expect(display.icon).toBe("unavailable");
		expect(display.tone).toBe("muted");
	});

	it("loading is the only spinning state", () => {
		const display = resolveTokenStatusDisplay("loading");
		expect(display.spin).toBe(true);
		expect(display.icon).toBe("loading");
	});

	it("maps healthy to a green check, no spin", () => {
		expect(resolveTokenStatusDisplay("healthy")).toEqual({
			icon: "healthy",
			spin: false,
			tone: "green",
		});
	});

	it("maps warning to a yellow triangle, no spin", () => {
		expect(resolveTokenStatusDisplay("warning")).toEqual({
			icon: "warning",
			spin: false,
			tone: "yellow",
		});
	});

	it("maps critical to a red icon, no spin", () => {
		expect(resolveTokenStatusDisplay("critical")).toEqual({
			icon: "critical",
			spin: false,
			tone: "red",
		});
	});

	it("maps expired to a red icon, no spin", () => {
		expect(resolveTokenStatusDisplay("expired")).toEqual({
			icon: "critical",
			spin: false,
			tone: "red",
		});
	});

	it("treats an unexpected/unknown status as unavailable, no spin", () => {
		const display = resolveTokenStatusDisplay(
			"totally-unknown" as unknown as TokenStatus,
		);
		expect(display.spin).toBe(false);
		expect(display.icon).toBe("unavailable");
		expect(display.tone).toBe("muted");
	});
});

describe("tokenStatusTooltip", () => {
	it("says the status is unavailable and retrying for error (not 'checking')", () => {
		const tip = tokenStatusTooltip("error", "acct-1", "boom");
		expect(tip.toLowerCase()).toContain("unavailable");
		expect(tip.toLowerCase()).toContain("retrying");
		expect(tip.toLowerCase()).not.toContain("checking");
	});

	it("says unavailable/retrying for an unknown status too", () => {
		const tip = tokenStatusTooltip(
			"weird" as unknown as TokenStatus,
			"acct-1",
			"",
		);
		expect(tip.toLowerCase()).toContain("unavailable");
		expect(tip.toLowerCase()).toContain("retrying");
	});

	it("keeps healthy wording", () => {
		expect(tokenStatusTooltip("healthy", "acct-1", "")).toContain(
			"OAuth token available",
		);
	});

	it("includes the account name for expired", () => {
		const tip = tokenStatusTooltip("expired", "my-account", "expired 2d ago");
		expect(tip).toContain("expired");
		expect(tip).toContain("my-account");
	});
});

describe("fetchAccountTokenStatus", () => {
	const okAccount = (status: TokenStatus, message: string) => ({
		success: true,
		data: { status, message },
	});

	it("(a) returns the primary result and does not call global on success", async () => {
		let globalCalled = false;
		const result = await fetchAccountTokenStatus({
			accountName: "acct-1",
			getAccountHealth: async () => okAccount("healthy", "all good"),
			getGlobalHealth: async () => {
				globalCalled = true;
				return { success: true, data: { accounts: [] } };
			},
		});
		expect(result).toEqual({ status: "healthy", message: "all good" });
		expect(globalCalled).toBe(false);
	});

	it("(b) falls back to global when primary throws and the account is found", async () => {
		const result = await fetchAccountTokenStatus({
			accountName: "acct-1",
			getAccountHealth: async () => {
				throw new Error("primary down");
			},
			getGlobalHealth: async () => ({
				success: true,
				data: {
					accounts: [
						{ accountName: "other", status: "healthy", message: "n/a" },
						{ accountName: "acct-1", status: "warning", message: "soon" },
					],
				},
			}),
		});
		expect(result).toEqual({ status: "warning", message: "soon" });
	});

	it("(c) returns null when primary throws and global throws", async () => {
		const result = await fetchAccountTokenStatus({
			accountName: "acct-1",
			getAccountHealth: async () => {
				throw new Error("primary down");
			},
			getGlobalHealth: async () => {
				throw new Error("global down");
			},
		});
		expect(result).toBeNull();
	});

	it("(d) returns null when primary throws and global succeeds but lacks the account", async () => {
		const result = await fetchAccountTokenStatus({
			accountName: "acct-1",
			getAccountHealth: async () => {
				throw new Error("primary down");
			},
			getGlobalHealth: async () => ({
				success: true,
				data: {
					accounts: [
						{ accountName: "other", status: "healthy", message: "n/a" },
					],
				},
			}),
		});
		expect(result).toBeNull();
	});

	it("(e) falls through to global when primary returns success:false", async () => {
		let globalCalled = false;
		const result = await fetchAccountTokenStatus({
			accountName: "acct-1",
			getAccountHealth: async () => ({ success: false, data: undefined }),
			getGlobalHealth: async () => {
				globalCalled = true;
				return {
					success: true,
					data: {
						accounts: [
							{ accountName: "acct-1", status: "critical", message: "bad" },
						],
					},
				};
			},
		});
		expect(globalCalled).toBe(true);
		expect(result).toEqual({ status: "critical", message: "bad" });
	});
});

describe("resolveTokenChip", () => {
	it.each<TokenStatus>([
		"healthy",
		"loading",
		"error",
		"no-refresh-token",
	])("returns null (no chip) for %s", (status) => {
		expect(resolveTokenChip(status)).toBeNull();
	});

	it("returns an amber warning chip for warning", () => {
		const chip = resolveTokenChip("warning");
		expect(chip).not.toBeNull();
		expect(chip?.label).toBe("Token expiring");
		expect(chip?.icon).toBe("warning");
		expect(chip?.className).toContain("amber");
	});

	it("returns a red critical chip for critical", () => {
		const chip = resolveTokenChip("critical");
		expect(chip).not.toBeNull();
		expect(chip?.label).toBe("Token expired");
		expect(chip?.icon).toBe("critical");
		expect(chip?.className).toContain("red");
	});

	it("returns a red critical chip for expired", () => {
		const chip = resolveTokenChip("expired");
		expect(chip).not.toBeNull();
		expect(chip?.label).toBe("Token expired");
		expect(chip?.icon).toBe("critical");
		expect(chip?.className).toContain("red");
	});
});
