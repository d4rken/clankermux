/**
 * The one-time setup code that lets whoever can read the server's output claim
 * a password-less deployment.
 *
 * Two properties carry the weight: the service never keeps the code as
 * plaintext (only a KDF verifier), and a code stops matching the moment it is
 * consumed or revoked — including for a check that was already in flight.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { logBus } from "@clankermux/logger";
import type { LogEvent } from "@clankermux/types";
import type { PasswordHasher } from "../session-auth-service";
import {
	issueSetupCodeAtStartup,
	printSetupCodeAnnouncement,
	SETUP_CODE_ALPHABET,
	SetupCodeService,
} from "../setup-code";

function digest(value: string): string {
	return createHash("sha256").update(`x:${value}`).digest("hex");
}

/**
 * Cheap stand-in for scrypt. Keeps counters only — recording its inputs would
 * put the plaintext in reach of the scan below and prove nothing.
 */
class FakeHasher implements PasswordHasher {
	hashCalls = 0;
	verifyCalls = 0;
	async hash(password: string) {
		this.hashCalls++;
		return { verifier: digest(password), params: "{}" };
	}
	async verify(password: string, verifier: string, _params: string) {
		this.verifyCalls++;
		return digest(password) === verifier;
	}
}

/** Bytes 0..11: every value is below 32, so the code is "0123456789AB". */
const sequentialRandom = (bytes: Uint8Array) => {
	for (let i = 0; i < bytes.length; i++) bytes[i] = i;
	return bytes;
};

function makeService(
	options: {
		random?: (bytes: Uint8Array) => Uint8Array;
		hasher?: PasswordHasher;
	} = {},
) {
	const announced: string[] = [];
	const hasher = options.hasher ?? new FakeHasher();
	const service = new SetupCodeService({
		announce: (code) => announced.push(code),
		random: options.random,
		hasher,
	});
	return { service, announced, hasher };
}

/** Let fire-and-forget chains settle. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Every string reachable from `root` through own properties, awaiting any
 * promise on the way. Functions are skipped: a closure's captured variables are
 * not reachable from JavaScript at all.
 */
async function reachableStrings(
	root: unknown,
	seen = new Set<unknown>(),
): Promise<string[]> {
	if (typeof root === "string") return [root];
	if (root === null || typeof root !== "object") return [];
	if (seen.has(root)) return [];
	seen.add(root);
	if (root instanceof Promise) {
		return reachableStrings(await root.catch(() => undefined), seen);
	}
	const out: string[] = [];
	for (const value of Object.values(root)) {
		out.push(...(await reachableStrings(value, seen)));
	}
	return out;
}

describe("the code itself", () => {
	it("uses the Crockford alphabet, which has no I, L, O or U", () => {
		expect(SETUP_CODE_ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
	});

	it("announces twelve characters grouped as XXXX-XXXX-XXXX", () => {
		const { service, announced } = makeService({ random: sequentialRandom });
		service.ensureIssued(service.generation);
		expect(announced).toEqual(["0123-4567-89AB"]);
	});

	it("maps every byte into the alphabet without a skew toward low values", () => {
		// 256 is a multiple of 32, so the low five bits are uniform. 32, 63 and
		// 255 land on 0, Z and Z: the high bits are dropped, never rejected.
		const bytesUsed = [32, 63, 255, 31, 64, 95, 0, 1, 2, 3, 4, 5];
		const { service, announced } = makeService({
			random: (bytes) => {
				bytes.set(bytesUsed.slice(0, bytes.length));
				return bytes;
			},
		});
		service.ensureIssued(service.generation);
		expect(announced).toEqual(["0ZZZ-0Z01-2345"]);
	});

	it("announces a code drawn from the real random source when none is injected", () => {
		const announced: string[] = [];
		const service = new SetupCodeService({
			announce: (code) => announced.push(code),
			hasher: new FakeHasher(),
		});
		service.ensureIssued(service.generation);
		expect(announced).toHaveLength(1);
		expect(announced[0]).toMatch(
			/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
		);
	});
});

describe("matching a candidate", () => {
	it("accepts the code as announced", async () => {
		const { service, announced } = makeService({ random: sequentialRandom });
		service.ensureIssued(service.generation);
		expect(await service.matches(announced[0] as string)).toBe(true);
	});

	it("accepts lowercase, spaces and missing or extra hyphens", async () => {
		const { service } = makeService({ random: sequentialRandom });
		service.ensureIssued(service.generation);
		for (const candidate of [
			"0123456789ab",
			"0123 4567 89ab",
			" 0123-4567-89AB ",
			"01-23-45-67-89-AB",
		]) {
			expect(await service.matches(candidate)).toBe(true);
		}
	});

	it("refuses a wrong code of the right shape", async () => {
		const { service } = makeService({ random: sequentialRandom });
		service.ensureIssued(service.generation);
		expect(await service.matches("0123-4567-89AC")).toBe(false);
	});

	it("refuses a malformed candidate WITHOUT running the KDF", async () => {
		const hasher = new FakeHasher();
		const { service } = makeService({ random: sequentialRandom, hasher });
		service.ensureIssued(service.generation);
		for (const candidate of [
			"",
			"0123-4567-89A",
			"0123-4567-89ABC",
			// I, L, O and U are not in the alphabet.
			"0123-4567-89AI",
			"0123-4567-89AO",
			"0123-4567-89A!",
		]) {
			expect(await service.matches(candidate)).toBe(false);
		}
		expect(hasher.verifyCalls).toBe(0);
	});

	it("refuses everything when no code has been issued", async () => {
		const hasher = new FakeHasher();
		const { service } = makeService({ hasher });
		expect(await service.matches("0123-4567-89AB")).toBe(false);
		expect(hasher.verifyCalls).toBe(0);
	});

	it("waits for a verifier that is still being derived", async () => {
		let finishHash = () => {};
		const hashHeld = new Promise<void>((resolve) => {
			finishHash = resolve;
		});
		const fake = new FakeHasher();
		const slowHasher: PasswordHasher = {
			hash: async (password) => {
				await hashHeld;
				return fake.hash(password);
			},
			verify: (password, verifier, params) =>
				fake.verify(password, verifier, params),
		};
		const { service, announced } = makeService({
			random: sequentialRandom,
			hasher: slowHasher,
		});
		service.ensureIssued(service.generation);
		const pending = service.matches(announced[0] as string);
		finishHash();
		expect(await pending).toBe(true);
	});

	it("answers false for a check that was in flight when the code was revoked", async () => {
		let verifyStarted = () => {};
		const started = new Promise<void>((resolve) => {
			verifyStarted = resolve;
		});
		let releaseVerify = () => {};
		const held = new Promise<void>((resolve) => {
			releaseVerify = resolve;
		});
		const fake = new FakeHasher();
		const barrierHasher: PasswordHasher = {
			hash: (password) => fake.hash(password),
			verify: async (password, verifier, params) => {
				verifyStarted();
				await held;
				return fake.verify(password, verifier, params);
			},
		};
		const { service, announced } = makeService({
			random: sequentialRandom,
			hasher: barrierHasher,
		});
		service.ensureIssued(service.generation);

		const pending = service.matches(announced[0] as string);
		await started;
		service.revoke();
		releaseVerify();

		expect(await pending).toBe(false);
	});
});

describe("the plaintext is never retained", () => {
	it("keeps only a verifier once the code is issued", async () => {
		const { service, announced } = makeService({ random: sequentialRandom });
		service.ensureIssued(service.generation);
		const formatted = announced[0] as string;
		const normalized = formatted.replaceAll("-", "");

		const strings = await reachableStrings(service);

		// The scan does reach the service's internals: the verifier is there.
		expect(strings).toContain(digest(normalized));
		for (const value of strings) {
			expect(value).not.toContain(normalized);
			expect(value).not.toContain(formatted);
		}
	});
});

describe("issuing, consuming and revoking", () => {
	it("announces once while a code is active", () => {
		const { service, announced } = makeService();
		service.ensureIssued(service.generation);
		service.ensureIssued(service.generation);
		service.ensureIssued(service.generation);
		expect(announced).toHaveLength(1);
	});

	it("issues nothing for a stale generation", () => {
		const { service, announced } = makeService();
		const observed = service.generation;
		// A password was set (and the code revoked) after the caller read the
		// generation but before its "no password" answer came back.
		service.revoke();
		service.ensureIssued(observed);
		expect(announced).toHaveLength(0);
	});

	it("bumps the generation even when no code was active", () => {
		const { service } = makeService();
		const before = service.generation;
		service.revoke();
		service.consume();
		expect(service.generation).toBe(before + 2);
	});

	for (const drop of ["consume", "revoke"] as const) {
		it(`stops matching after ${drop}() and announces a NEW code next time`, async () => {
			let calls = 0;
			const { service, announced } = makeService({
				random: (bytes) => {
					// A different code on every draw.
					bytes.fill(calls++);
					return bytes;
				},
			});
			service.ensureIssued(service.generation);
			const first = announced[0] as string;

			service[drop]();
			expect(await service.matches(first)).toBe(false);

			service.ensureIssued(service.generation);
			expect(announced).toHaveLength(2);
			expect(announced[1]).not.toBe(first);
			expect(await service.matches(first)).toBe(false);
			expect(await service.matches(announced[1] as string)).toBe(true);
		});
	}

	it("drops the code when announcing it throws, so the next caller can issue one", () => {
		let fail = true;
		const announced: string[] = [];
		const service = new SetupCodeService({
			announce: (code) => {
				if (fail) throw new Error("stdout closed");
				announced.push(code);
			},
			hasher: new FakeHasher(),
		});
		expect(() => service.ensureIssued(service.generation)).toThrow(
			"stdout closed",
		);
		fail = false;
		service.ensureIssued(service.generation);
		expect(announced).toHaveLength(1);
	});
});

describe("issueSetupCodeAtStartup", () => {
	it("issues a code when no password is configured", async () => {
		const { service, announced } = makeService();
		issueSetupCodeAtStartup({
			isConfigured: async () => false,
			setupCode: service,
			reportError: () => {},
		});
		await flush();
		expect(announced).toHaveLength(1);
	});

	it("issues nothing when a password is configured", async () => {
		const { service, announced } = makeService();
		issueSetupCodeAtStartup({
			isConfigured: async () => true,
			setupCode: service,
			reportError: () => {},
		});
		await flush();
		expect(announced).toHaveLength(0);
	});

	it("reports an unreadable password state without issuing a code", async () => {
		const { service, announced } = makeService();
		const reported: string[] = [];
		issueSetupCodeAtStartup({
			isConfigured: async () => {
				throw new Error("database is locked");
			},
			setupCode: service,
			reportError: (message) => reported.push(message),
		});
		await flush();
		expect(announced).toHaveLength(0);
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain("setup code");
		expect(reported[0]).toMatch(/dashboard/i);
	});

	it("swallows a reportError that throws", async () => {
		const { service } = makeService();
		issueSetupCodeAtStartup({
			isConfigured: async () => {
				throw new Error("database is locked");
			},
			setupCode: service,
			reportError: () => {
				throw new Error("stderr closed");
			},
		});
		// An unhandled rejection here would fail the run.
		await flush();
	});

	it("issues nothing when a password was set while the lookup was pending", async () => {
		const { service, announced } = makeService();
		let answer: (configured: boolean) => void = () => {};
		issueSetupCodeAtStartup({
			isConfigured: () =>
				new Promise<boolean>((resolve) => {
					answer = resolve;
				}),
			setupCode: service,
			reportError: () => {},
		});
		// A status read saw the new password and revoked.
		service.revoke();
		answer(false);
		await flush();
		expect(announced).toHaveLength(0);
	});

	it("returns without waiting for the lookup", () => {
		const { service, announced } = makeService();
		const result = issueSetupCodeAtStartup({
			isConfigured: () => new Promise<boolean>(() => {}),
			setupCode: service,
			reportError: () => {},
		});
		expect(result).toBeUndefined();
		expect(announced).toHaveLength(0);
	});
});

describe("printSetupCodeAnnouncement", () => {
	it("writes ONE block to stdout and nothing to the log bus", () => {
		const events: LogEvent[] = [];
		const onLog = (event: LogEvent) => events.push(event);
		logBus.on("log", onLog);
		const out = spyOn(console, "log").mockImplementation(() => {});
		try {
			printSetupCodeAnnouncement("ABCD-EFGH-JKMN", "http://localhost:8080");
			expect(out).toHaveBeenCalledTimes(1);
			const block = String(out.mock.calls[0]?.[0]);
			expect(block).toContain("ABCD-EFGH-JKMN");
			expect(block).toContain("http://localhost:8080");
			expect(block).toContain("clankermux-server auth password --set");
			expect(block).toContain("bun run auth:password --set");
			expect(block).toMatch(/restart/i);
			// The log bus feeds /api/logs/*, which are open while no password is
			// set. The code must never reach it.
			expect(events).toHaveLength(0);
		} finally {
			out.mockRestore();
			logBus.off("log", onLog);
		}
	});

	it("still names the dashboard when its URL is unknown", () => {
		const out = spyOn(console, "log").mockImplementation(() => {});
		try {
			printSetupCodeAnnouncement("ABCD-EFGH-JKMN");
			const block = String(out.mock.calls[0]?.[0]);
			expect(block).toContain("ABCD-EFGH-JKMN");
			expect(block).toMatch(/dashboard/i);
			expect(block).not.toContain("undefined");
		} finally {
			out.mockRestore();
		}
	});
});
