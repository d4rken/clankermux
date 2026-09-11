import { describe, expect, it, spyOn } from "bun:test";
import {
	DevinClient,
	DevinSessionAuthenticationError,
	devinSessionExpiresAt,
	extractDevinIdentity,
	normalizeDevinUsage,
} from "../client";
import {
	BillingStrategy,
	ClientModelConfigSchema,
	DevinPlanInfoSchema,
	GetCliModelConfigsResponseSchema,
	GetUserJwtRequestSchema,
	GetUserJwtResponseSchema,
	GetUserStatusResponseSchema,
	PlanInfoSchema,
	PlanStatusSchema,
	TeamsTier,
	UserStatusSchema,
} from "../vendor/devin-proto";
import { create, fromBinary, toBinary } from "../vendor/protobuf";

describe("Devin account client", () => {
	it("keeps unknown plans absent and formats known tier fallbacks", () => {
		const response = create(GetUserStatusResponseSchema);
		expect(normalizeDevinUsage(response).planName).toBeNull();
		response.userStatus = create(UserStatusSchema, {
			teamsTier: TeamsTier.PRO,
		});
		expect(normalizeDevinUsage(response).planName).toBe("Pro");
		response.planInfo = create(PlanInfoSchema, { planName: "  Custom Plan  " });
		expect(normalizeDevinUsage(response).planName).toBe("Custom Plan");
	});
	it("keeps credential-scoped auth/model state separate and never sends client auth headers", async () => {
		const tokens: string[] = [];
		const client = new DevinClient(async (input, init) => {
			const path = new URL(String(input)).pathname;
			if (path.endsWith("GetUserJwt")) {
				const body = fromBinary(
					GetUserJwtRequestSchema,
					new Uint8Array(init?.body as ArrayBuffer),
				);
				tokens.push(body.metadata?.apiKey ?? "");
				expect(new Headers(init?.headers).has("authorization")).toBe(false);
				return new Response(
					toBinary(
						GetUserJwtResponseSchema,
						create(GetUserJwtResponseSchema, {
							userJwt: `jwt-${tokens.length}`,
						}),
					),
				);
			}
			if (path.endsWith("GetCliModelConfigs"))
				return new Response(
					toBinary(
						GetCliModelConfigsResponseSchema,
						create(GetCliModelConfigsResponseSchema, {
							clientModelConfigs: [
								create(ClientModelConfigSchema, {
									modelUid: "swe-2-high",
									label: "SWE-2 High",
									isDefaultModelInFamily: true,
								}),
								create(ClientModelConfigSchema, {
									modelUid: "swe-2-max",
									label: "SWE-2 Max",
									disabled: true,
								}),
							],
						}),
					),
				);
			return new Response(
				toBinary(
					GetUserStatusResponseSchema,
					create(GetUserStatusResponseSchema, {
						userStatus: create(UserStatusSchema, { email: "test@example.com" }),
					}),
				),
			);
		});
		const [a, b] = await Promise.all([
			client.getAccount("alpha"),
			client.getAccount("beta"),
		]);
		expect(a.userJwt).not.toBe(b.userJwt);
		expect(tokens.sort()).toEqual([
			"devin-session-token$alpha",
			"devin-session-token$beta",
		]);
		// Manual refresh must invalidate only the requested credential/endpoint.
		client.invalidateAccount("alpha");
		const refreshed = await client.getAccount("alpha");
		expect(refreshed.userJwt).not.toBe(a.userJwt);
		expect((await client.getAccount("beta")).userJwt).toBe(b.userJwt);
		expect(tokens).toHaveLength(3);
		expect(client.resolveModel(a.models, "swe-2").id).toBe("swe-2-high");
		expect(() => client.resolveModel(a.models, "swe-2-max")).toThrow(
			"unavailable",
		);
	});
	it("treats undated proto-default quota values as absent and honors hidden daily windows", () => {
		const response = create(GetUserStatusResponseSchema, {
			userStatus: create(UserStatusSchema, {
				planStatus: create(PlanStatusSchema),
			}),
		});
		expect(normalizeDevinUsage(response).daily).toBeNull();
		response.planInfo = create(PlanInfoSchema, {
			billingStrategy: BillingStrategy.QUOTA,
			hideDailyQuota: true,
			planName: "Max",
		});
		const planStatus = response.userStatus?.planStatus;
		if (!planStatus) throw new Error("Missing fixture plan");
		planStatus.weeklyQuotaRemainingPercent = 25;
		planStatus.weeklyQuotaResetAtUnix = 2_000_000_000n;
		const usage = normalizeDevinUsage(response);
		expect(usage.daily).toBeNull();
		expect(usage.weekly).toEqual({
			utilization: 75,
			resetAt: 2_000_000_000_000,
		});
		expect(usage.planName).toBe("Max");
	});
});

describe("Devin client cache and endpoint safety", () => {
	it("honors cancellation even on a shared cache hit", async () => {
		let finish!: (r: Response) => void;
		const client = new DevinClient(
			async () =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		);
		const first = client.getAccount("token");
		const controller = new AbortController();
		const second = client.getAccount("token", undefined, controller.signal);
		controller.abort(new Error("disconnected"));
		await expect(second).rejects.toThrow("disconnected");
		finish(new Response(null, { status: 403 }));
		await expect(first).rejects.toThrow("403");
	});
	it("rejects auth redirects to unrelated hosts before sending credentials", async () => {
		let calls = 0;
		const client = new DevinClient(async () => {
			calls++;
			return new Response(
				toBinary(
					GetUserJwtResponseSchema,
					create(GetUserJwtResponseSchema, {
						userJwt: "jwt",
						customApiServerUrl: "https://attacker.example",
					}),
				),
			);
		});
		await expect(client.getAccount("token")).rejects.toThrow("untrusted");
		expect(calls).toBe(1);
	});
});

describe("Devin organization identity evidence", () => {
	it("uses authoritative plan organization metadata and keeps user and organization IDs distinct", () => {
		const response = create(GetUserStatusResponseSchema, {
			userStatus: create(UserStatusSchema, {
				email: " member@example.test ",
				userId: " user-1 ",
				teamId: " team-fallback ",
				planStatus: create(PlanStatusSchema, {
					planInfo: create(PlanInfoSchema, {
						devinInfo: create(DevinPlanInfoSchema, {
							orgId: "nested-org",
							accountDisplayName: "Nested Organization",
						}),
					}),
				}),
			}),
			planInfo: create(PlanInfoSchema, {
				planName: "Pro",
				devinInfo: create(DevinPlanInfoSchema, {
					orgId: " org-authoritative ",
					accountDisplayName: " Acme Team ",
				}),
			}),
		});
		const usage = normalizeDevinUsage(response);
		expect(usage).toMatchObject({
			organizationId: "org-authoritative",
			organizationName: "Acme Team",
			email: "member@example.test",
			accountId: "user-1",
		});
		expect(extractDevinIdentity(usage)).toEqual({
			email: "member@example.test",
			externalAccountId: "user-1",
			organizationName: "Acme Team",
			planTier: "Pro",
			rateLimitTier: null,
		});
	});
	it("uses legacy plan metadata and team ID only as organization fallbacks", () => {
		const response = create(GetUserStatusResponseSchema, {
			userStatus: create(UserStatusSchema, {
				teamId: " team-legacy ",
				planStatus: create(PlanStatusSchema, {
					planInfo: create(PlanInfoSchema, {
						devinInfo: create(DevinPlanInfoSchema, {
							orgId: " ",
							accountDisplayName: " Legacy Team ",
						}),
					}),
				}),
			}),
		});
		expect(normalizeDevinUsage(response)).toMatchObject({
			organizationId: "team-legacy",
			organizationName: "Legacy Team",
			accountId: null,
		});
		response.planInfo = create(PlanInfoSchema);
		expect(normalizeDevinUsage(response)).toMatchObject({
			organizationId: "team-legacy",
			organizationName: null,
		});
		expect(
			normalizeDevinUsage(create(GetUserStatusResponseSchema)),
		).toMatchObject({ organizationId: null, organizationName: null });
	});
	it("accepts old metadata snapshots and captures an organization-only identity without inventing rate tier", () => {
		expect(
			extractDevinIdentity({ email: null, accountId: null, planName: "Pro" }),
		).toMatchObject({ organizationName: null, rateLimitTier: null });
		expect(
			extractDevinIdentity({
				email: null,
				accountId: null,
				planName: null,
				organizationName: " Only Organization ",
			}),
		).toEqual({
			email: null,
			externalAccountId: null,
			planTier: null,
			organizationName: "Only Organization",
			rateLimitTier: null,
		});
	});
});

function testJwt(exp: unknown): string {
	return `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
}
function accountReply(path: string, jwt = "jwt"): Response {
	if (path.endsWith("GetUserJwt"))
		return new Response(
			new Uint8Array(
				toBinary(
					GetUserJwtResponseSchema,
					create(GetUserJwtResponseSchema, { userJwt: jwt }),
				),
			),
		);
	if (path.endsWith("GetCliModelConfigs"))
		return new Response(
			new Uint8Array(
				toBinary(
					GetCliModelConfigsResponseSchema,
					create(GetCliModelConfigsResponseSchema),
				),
			),
		);
	return new Response(
		new Uint8Array(
			toBinary(
				GetUserStatusResponseSchema,
				create(GetUserStatusResponseSchema),
			),
		),
	);
}
describe("Devin credential lifetime and metadata renewal", () => {
	it("reads only finite positive JWT expiry and leaves opaque session expiry unknown", () => {
		expect(devinSessionExpiresAt(testJwt(2_000_000_000))).toBe(
			2_000_000_000_000,
		);
		expect(
			devinSessionExpiresAt(`devin-session-token$${testJwt(2_000_000_000)}`),
		).toBe(2_000_000_000_000);
		for (const value of [
			"opaque-token",
			"broken.jwt",
			testJwt(0),
			testJwt(-1),
			testJwt("2000000000"),
			testJwt(null),
			testJwt(1e308),
			testJwt(8.64e12 + 1),
		])
			expect(devinSessionExpiresAt(value)).toBeNull();
	});
	it("shares one bounded metadata401 retry across concurrent callers", async () => {
		let authCalls = 0;
		const client = new DevinClient(async (input) => {
			const path = String(input);
			if (path.endsWith("GetUserJwt") && ++authCalls === 1)
				return new Response(null, { status: 401 });
			return accountReply(path);
		});
		const [a, b] = await Promise.all([
			client.getAccount("session"),
			client.getAccount("session"),
		]);
		expect(a).toBe(b);
		expect(authCalls).toBe(2);
	});
	it("confirms session rejection only after two metadata401s and evicts the failure", async () => {
		let calls = 0;
		const client = new DevinClient(async () => {
			calls++;
			return new Response(null, { status: 401 });
		});
		await expect(client.getAccount("session")).rejects.toBeInstanceOf(
			DevinSessionAuthenticationError,
		);
		expect(calls).toBe(2);
		await expect(client.getAccount("session")).rejects.toBeInstanceOf(
			DevinSessionAuthenticationError,
		);
		expect(calls).toBe(4);
	});
	it("does not retry or classify permission, server, network, or malformed metadata as session rejection", async () => {
		for (const status of [403, 503, 0, 200]) {
			let calls = 0;
			const client = new DevinClient(async () => {
				calls++;
				if (status === 0) throw new Error("network down");
				return status === 200
					? accountReply("GetUserJwt", "")
					: new Response(null, { status });
			});
			let caught: unknown;
			try {
				await client.getAccount("session");
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(Error);
			expect(caught).not.toBeInstanceOf(DevinSessionAuthenticationError);
			expect(calls).toBe(1);
		}
	});
	it("does not confirm a session when a transient401 is followed by503", async () => {
		let calls = 0;
		const client = new DevinClient(
			async () => new Response(null, { status: ++calls === 1 ? 401 : 503 }),
		);
		let caught: unknown;
		try {
			await client.getAccount("session");
		} catch (error) {
			caught = error;
		}
		expect(caught).not.toBeInstanceOf(DevinSessionAuthenticationError);
		expect(calls).toBe(2);
	});
	it("renews cached metadata before its user JWT expires without affecting other credentials", async () => {
		let now = 2_000_000_000_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const authCalls: Record<string, number> = {};
		const client = new DevinClient(async (input, init) => {
			const path = String(input);
			if (path.endsWith("GetUserJwt")) {
				const request = fromBinary(
					GetUserJwtRequestSchema,
					new Uint8Array(init?.body as ArrayBuffer),
				);
				const token = request.metadata?.apiKey ?? "";
				authCalls[token] = (authCalls[token] ?? 0) + 1;
				return accountReply(
					path,
					testJwt((now + (token.endsWith("short") ? 6_000 : 60_000)) / 1000),
				);
			}
			return accountReply(path);
		});
		try {
			await client.getAccount("short");
			await client.getAccount("long");
			now += 1_001;
			await client.getAccount("short");
			await client.getAccount("long");
			expect(authCalls).toEqual({
				"devin-session-token$short": 2,
				"devin-session-token$long": 1,
			});
		} finally {
			clock.mockRestore();
		}
	});
	it("shares explicit metadata refresh while it is in flight", async () => {
		let calls = 0;
		const client = new DevinClient(async (input) => {
			if (String(input).endsWith("GetUserJwt")) calls++;
			return accountReply(String(input));
		});
		await client.getAccount("session");
		const [a, b] = await Promise.all([
			client.refreshAccount("session"),
			client.refreshAccount("session"),
		]);
		expect(a).toBe(b);
		expect(calls).toBe(2);
	});
});

describe("Devin metadata cache deadline bounds", () => {
	it("reuses freshly fetched exhausted quota for one second when its reset is already past", async () => {
		let now = 2_000_000_000_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		let calls = 0;
		const client = new DevinClient(async (input) => {
			const path = String(input);
			if (!path.endsWith("GetUserStatus")) {
				if (path.endsWith("GetUserJwt")) calls++;
				return accountReply(path);
			}
			return new Response(
				new Uint8Array(
					toBinary(
						GetUserStatusResponseSchema,
						create(GetUserStatusResponseSchema, {
							planInfo: create(PlanInfoSchema, {
								billingStrategy: BillingStrategy.QUOTA,
								hideWeeklyQuota: true,
							}),
							userStatus: create(UserStatusSchema, {
								planStatus: create(PlanStatusSchema, {
									dailyQuotaRemainingPercent: 0,
									dailyQuotaResetAtUnix: 1_999_999_999n,
								}),
							}),
						}),
					),
				),
			);
		});
		try {
			const first = await client.getAccount("session");
			now += 999;
			expect(await client.getAccount("session")).toBe(first);
			expect(first.usage.daily?.utilization).toBe(100);
			expect(first.usage.daily?.resetAt).toBe(1_999_999_999_000);
			expect(first.usage.weekly).toBeNull();
			expect(calls).toBe(1);
			now++;
			expect(await client.getAccount("session")).not.toBe(first);
			expect(calls).toBe(2);
		} finally {
			clock.mockRestore();
		}
	});
	it("preserves a future quota reset less than one second away even beside a past reset", async () => {
		let now = 2_000_000_000_500;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		let calls = 0;
		const client = new DevinClient(async (input) => {
			const path = String(input);
			if (!path.endsWith("GetUserStatus")) {
				if (path.endsWith("GetUserJwt")) calls++;
				return accountReply(path);
			}
			return new Response(
				new Uint8Array(
					toBinary(
						GetUserStatusResponseSchema,
						create(GetUserStatusResponseSchema, {
							planInfo: create(PlanInfoSchema, {
								billingStrategy: BillingStrategy.QUOTA,
							}),
							userStatus: create(UserStatusSchema, {
								planStatus: create(PlanStatusSchema, {
									dailyQuotaRemainingPercent: 0,
									dailyQuotaResetAtUnix: 1_999_999_999n,
									weeklyQuotaRemainingPercent: 40,
									weeklyQuotaResetAtUnix: 2_000_000_001n,
								}),
							}),
						}),
					),
				),
			);
		});
		try {
			const first = await client.getAccount("session");
			now += 499;
			expect(await client.getAccount("session")).toBe(first);
			now++;
			expect(await client.getAccount("session")).not.toBe(first);
			expect(calls).toBe(2);
		} finally {
			clock.mockRestore();
		}
	});
	it.each([
		500, 4_000,
	])("bounds near-expiry JWT reuse by both one second and actual expiry (%sms)", async (remaining) => {
		let now = 2_000_000_000_000;
		const exp = now + remaining;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		let calls = 0;
		const client = new DevinClient(async (input) => {
			if (String(input).endsWith("GetUserJwt")) calls++;
			return accountReply(String(input), testJwt(exp / 1000));
		});
		try {
			const first = await client.getAccount("session");
			now += Math.min(1_000, remaining) - 1;
			expect(await client.getAccount("session")).toBe(first);
			now++;
			expect(await client.getAccount("session")).not.toBe(first);
			expect(calls).toBe(2);
		} finally {
			clock.mockRestore();
		}
	});
	it("never reuses an already-expired JWT", async () => {
		const now = 2_000_000_000_000;
		const clock = spyOn(Date, "now").mockReturnValue(now);
		let calls = 0;
		const client = new DevinClient(async (input) => {
			if (String(input).endsWith("GetUserJwt")) calls++;
			return accountReply(String(input), testJwt(now / 1000));
		});
		try {
			const first = await client.getAccount("session");
			expect(await client.getAccount("session")).not.toBe(first);
			expect(calls).toBe(2);
		} finally {
			clock.mockRestore();
		}
	});
});
