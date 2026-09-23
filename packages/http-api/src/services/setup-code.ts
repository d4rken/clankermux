import { Logger } from "@clankermux/logger";
import {
	type PasswordHasher,
	scryptPasswordHasher,
} from "./session-auth-service";

const log = new Logger("SetupCode");

/**
 * Crockford base32: digits and uppercase letters without I, L, O and U, so a
 * code read off a terminal cannot be mistyped as a lookalike.
 */
export const SETUP_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Characters in a code, excluding the display hyphens (60 bits). */
export const SETUP_CODE_LENGTH = 12;

const SETUP_CODE_GROUP = 4;

/** `0123456789AB` becomes `0123-4567-89AB`. */
function formatSetupCode(normalized: string): string {
	const groups: string[] = [];
	for (let i = 0; i < normalized.length; i += SETUP_CODE_GROUP) {
		groups.push(normalized.slice(i, i + SETUP_CODE_GROUP));
	}
	return groups.join("-");
}

/**
 * The canonical form of a candidate, or null when it cannot be a code at all.
 * `" 0123-4567-89ab "` becomes `0123456789AB`; `0123-4567-89AI` is null.
 */
function normalizeSetupCode(candidate: string): string | null {
	const normalized = candidate.toUpperCase().replace(/[\s-]/g, "");
	if (normalized.length !== SETUP_CODE_LENGTH) return null;
	for (const char of normalized) {
		if (!SETUP_CODE_ALPHABET.includes(char)) return null;
	}
	return normalized;
}

/** Fills `bytes` with random values and returns them. */
type RandomSource = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array;

const defaultRandom: RandomSource = (bytes) => crypto.getRandomValues(bytes);

interface ActiveSetupCode {
	verifier: Promise<{ verifier: string; params: string }>;
}

/**
 * The one-time code that authorizes setting the FIRST management password over
 * HTTP. It is printed to the server's stdout, so claiming a password-less
 * deployment requires reading that output.
 *
 * Per process and memory only: a restart forgets it, and the next caller that
 * finds no password prints a new one. Only a KDF verifier is kept — the
 * plaintext exists in `ensureIssued`'s locals and in what was printed.
 *
 * `generation` changes on every consume or revoke. A caller that reads it,
 * then learns asynchronously that no password is set, passes the reading to
 * `ensureIssued`; a password set in between has bumped it, and nothing is
 * issued for a deployment that is already configured.
 */
export class SetupCodeService {
	private active: ActiveSetupCode | null = null;
	private currentGeneration = 0;
	private readonly announce: (code: string) => void;
	private readonly random: RandomSource;
	private readonly hasher: PasswordHasher;

	constructor(options: {
		announce: (code: string) => void;
		random?: RandomSource;
		hasher?: PasswordHasher;
	}) {
		this.announce = options.announce;
		this.random = options.random ?? defaultRandom;
		this.hasher = options.hasher ?? scryptPasswordHasher;
	}

	get generation(): number {
		return this.currentGeneration;
	}

	/**
	 * Issue and announce a code unless one is active or `observedGeneration` is
	 * stale. Synchronous from the check to the assignment, so two concurrent
	 * callers cannot both issue.
	 */
	ensureIssued(observedGeneration: number): void {
		if (this.active || observedGeneration !== this.currentGeneration) return;

		// 256 is a multiple of 32, so the low five bits of a uniform byte are
		// uniform over the alphabet.
		const bytes = this.random(new Uint8Array(SETUP_CODE_LENGTH));
		let normalized = "";
		for (const byte of bytes) {
			normalized += SETUP_CODE_ALPHABET[byte & 31];
		}

		const verifier = this.hasher.hash(normalized);
		verifier.catch((error) => {
			log.error(
				`Could not derive the setup code verifier; no setup code will match until the next one is issued: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		});
		const active: ActiveSetupCode = { verifier };
		this.active = active;
		try {
			this.announce(formatSetupCode(normalized));
		} catch (error) {
			// Nobody saw it, so it must not block the next caller from issuing one.
			if (this.active === active) this.active = null;
			throw error;
		}
	}

	/**
	 * Does `candidate` match the active code? A malformed candidate is refused
	 * without running the KDF. A consume or revoke that lands while the check is
	 * running makes the answer false.
	 */
	async matches(candidate: string): Promise<boolean> {
		const active = this.active;
		if (!active) return false;
		const normalized = normalizeSetupCode(candidate);
		if (!normalized) return false;
		const generation = this.currentGeneration;
		let ok: boolean;
		try {
			const stored = await active.verifier;
			ok = await this.hasher.verify(normalized, stored.verifier, stored.params);
		} catch {
			return false;
		}
		return (
			ok && generation === this.currentGeneration && this.active === active
		);
	}

	/** The code was used to set the password. */
	consume(): void {
		this.drop();
	}

	/** A password exists by some other route; the code must stop working. */
	revoke(): void {
		this.drop();
	}

	private drop(): void {
		this.active = null;
		this.currentGeneration++;
	}
}

/**
 * Issue a code at startup if no password is set. Returns immediately: the
 * lookup is a DB read that can queue behind write contention for minutes, and
 * startup must not wait for it. When the lookup fails, nothing is issued and
 * the next dashboard status check issues the code instead.
 */
export function issueSetupCodeAtStartup(deps: {
	isConfigured: () => Promise<boolean>;
	setupCode: SetupCodeService;
	reportError: (message: string) => void;
}): void {
	const generation = deps.setupCode.generation;
	void Promise.resolve()
		.then(() => deps.isConfigured())
		.then(
			(configured) => {
				if (!configured) deps.setupCode.ensureIssued(generation);
			},
			(error) => {
				deps.reportError(
					`Could not determine whether a management password is set (${
						error instanceof Error ? error.message : String(error)
					}). If none is, the setup code will be printed when the dashboard is opened.`,
				);
			},
		)
		.catch(() => {});
}

/**
 * Print a setup code for the operator.
 *
 * `console.log` only, never `Logger`: Logger output feeds the log bus and the
 * log file, which `/api/logs/*` serve — and those routes are open while no
 * password is set, so anyone who can reach the port could read the code.
 */
export function printSetupCodeAnnouncement(
	code: string,
	dashboardUrl?: string,
): void {
	const rule = "-".repeat(64);
	const dashboard = dashboardUrl
		? `Open the dashboard at ${dashboardUrl} and enter this code`
		: "Open the dashboard and enter this code";
	console.log(
		[
			"",
			rule,
			"No management password is set. One-time setup code:",
			"",
			`    ${code}`,
			"",
			`${dashboard} to choose a password.`,
			"Each restart prints a new code.",
			"",
			"Or set the password from a shell on this machine:",
			"    clankermux-server auth password --set",
			"    (from a source checkout: bun run auth:password --set)",
			rule,
			"",
		].join("\n"),
	);
}
