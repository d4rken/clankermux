import { describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import type { Config } from "@clankermux/config";
import type {
	AuthSessionRecord,
	BunSqlAdapter,
	DatabaseOperations,
	PasswordBinding,
	StoredPasswordVerifier,
} from "@clankermux/database";
import { APIRouter } from "../router";
import {
	type PasswordHasher,
	SessionAuthService,
	type SessionAuthStore,
} from "../services/session-auth-service";
import { SetupCodeService } from "../services/setup-code";
import type { APIContext } from "../types";

/**
 * The setup and snapshot routes reached through the real router. The handler
 * map is keyed by `"METHOD:/path"` strings, so a typo in a registration is a
 * 404 no handler-level test would notice.
 */

class FakeStore implements SessionAuthStore {
	password: StoredPasswordVerifier | null = null;
	sessions = new Map<string, AuthSessionRecord>();

	async getManagementPassword() {
		return this.password;
	}
	async setManagementPasswordIfAbsent(
		verifier: string,
		params: string,
		updatedAt: number,
	) {
		if (this.password) return false;
		this.password = { verifier, params, updatedAt };
		this.sessions.clear();
		return true;
	}
	async createManagementSession(
		record: AuthSessionRecord,
		boundTo: PasswordBinding,
	) {
		if (
			this.password?.verifier !== boundTo.verifier ||
			this.password?.params !== boundTo.params
		) {
			return 0;
		}
		this.sessions.set(record.tokenHash, { ...record });
		return 1;
	}
	async getManagementSession(tokenHash: string) {
		return this.sessions.get(tokenHash) ?? null;
	}
	async touchManagementSession() {
		return 0;
	}
	async deleteManagementSession(tokenHash: string) {
		return this.sessions.delete(tokenHash) ? 1 : 0;
	}
	async cleanupExpiredManagementSessions() {
		return 0;
	}
}

const cheapHasher: PasswordHasher = {
	async hash(password) {
		return {
			verifier: createHash("sha256").update(`x:${password}`).digest("hex"),
			params: "{}",
		};
	},
	async verify(password, verifier) {
		return (
			createHash("sha256").update(`x:${password}`).digest("hex") === verifier
		);
	},
};

function makeRouter(setupCode?: SetupCodeService) {
	const adapter = {
		query: async () => [],
		get: async () => null,
		run: async () => undefined,
	} as unknown as BunSqlAdapter;
	const dbOps = {
		getAdapter: () => adapter,
	} as unknown as DatabaseOperations;
	const store = new FakeStore();
	const sessionAuth = new SessionAuthService(store, cheapHasher);
	const context: APIContext = {
		db: adapter,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config,
		dbOps,
		sessionAuth,
		...(setupCode ? { setupCode } : {}),
	};
	return { router: new APIRouter(context), store };
}

async function dispatch(
	router: APIRouter,
	method: string,
	path: string,
	body?: unknown,
): Promise<Response> {
	const url = new URL(`http://localhost${path}`);
	const res = await router.handleRequest(
		url,
		new Request(url, {
			method,
			...(body === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					}),
		}),
	);
	if (!res) throw new Error(`${method} ${path} is not registered`);
	return res;
}

describe("router: POST /api/auth/setup", () => {
	it("claims the first password with the injected setup code", async () => {
		const announced: string[] = [];
		const setupCode = new SetupCodeService({
			announce: (code) => announced.push(code),
			hasher: cheapHasher,
		});
		const { router, store } = makeRouter(setupCode);

		// The status check is what issues the code when startup did not.
		const status = await dispatch(router, "GET", "/api/auth/status");
		expect(await status.json()).toEqual({
			configured: false,
			authenticated: false,
		});
		expect(announced).toHaveLength(1);

		const res = await dispatch(router, "POST", "/api/auth/setup", {
			code: announced[0],
			password: "correct horse battery",
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie")).toContain("cmx_session=");
		expect(store.password).not.toBeNull();
	});

	it("builds its own setup code, printed to stdout, when none is injected", async () => {
		const out = spyOn(console, "log").mockImplementation(() => {});
		try {
			const { router, store } = makeRouter();
			await dispatch(router, "GET", "/api/auth/status");
			const blocks = out.mock.calls
				.map((call) => String(call[0]))
				.filter((line) => line.includes("setup code"));
			expect(blocks).toHaveLength(1);
			const code = blocks[0]?.match(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/)?.[0];
			expect(code).toBeDefined();

			const res = await dispatch(router, "POST", "/api/auth/setup", {
				code,
				password: "correct horse battery",
			});
			expect(res.status).toBe(200);
			expect(store.password).not.toBeNull();
		} finally {
			out.mockRestore();
		}
	});
});

describe("router: GET /api/debug/snapshot", () => {
	it("answers 403 while no management password is set", async () => {
		const { router } = makeRouter();
		const res = await dispatch(router, "GET", "/api/debug/snapshot");
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "Heap snapshots are disabled until a management password is set",
		});
	});
});
