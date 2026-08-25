/**
 * The minimum Bun this proxy may run on, and the boot-time check that enforces
 * it.
 *
 * ## Why a floor exists at all
 *
 * `478440d3` (v2026.8.21) made the inline collector the sole usage writer and
 * deleted the extraction `response.clone()`. Disposing that clone segfaults Bun
 * 1.3.14 — oven-sh/bun#32111, "Native segfault in `RequestContext.onAbort` when
 * returning async ReadableStream + client aborts". The same work had already
 * landed once as `ce6537a2` and was reverted 23 minutes later (`5bbc09b3`) for
 * exactly that crash. The fix is oven-sh/bun#32120, merged upstream 2026-06-21.
 *
 * A client aborting a streaming response is ordinary traffic for a proxy, so on
 * an affected runtime this is not a rare edge case: it recurs. And it is a
 * NATIVE crash, not an exception — nothing in this process can catch it, log
 * it, or degrade around it. The process dies, the supervisor restarts it, and
 * the next abort kills it again, with no in-process trace explaining any of it.
 *
 * ## Why the floor is 1.4.0
 *
 * Bun 1.4.0 was released 2026-08-20. GitHub's compare API places #32120's merge
 * commit (`8dd1b617`) as an ancestor of the `bun-v1.4.0` tag with `behind_by:
 * 0`, so the stable release carries the fix. `478440d3`'s message names
 * `1.4.0-canary.1` because at the time of that merge no stable release existed;
 * 1.4.0 superseded that, and the manifest states the stable floor rather than a
 * canary nobody can install by version number.
 *
 * ## Why the check is fail-closed, and what that costs
 *
 * Refusing to boot is not free, and the honest framing is a trade rather than a
 * free win. A segfault under load is traffic-dependent: an affected process may
 * serve for hours between crashes. A version refusal is deterministic and
 * immediate, and under `Restart=always` it will walk the unit into its
 * `StartLimitBurst` in about five attempts while Caddy holds new requests for
 * `lb_try_duration 330s` before returning 502. So this deliberately converts
 * "intermittently crashing, cause invisible" into "stopped, cause stated".
 * That is the right trade for an uncatchable native crash in a request path,
 * but it is a trade.
 *
 * The mitigation for the deterministic part is on the systemd side:
 * `deploy/systemd/clankermux.service.d/runtime-floor.conf` sets
 * `RestartPreventExitStatus=78` so a known-bad runtime fails once, loudly,
 * instead of five times.
 *
 * The comparator must not become the outage it exists to prevent, so refusal
 * requires a positive reading: the version string parses AND its release triple
 * is strictly below the floor. Every other outcome — unreadable version,
 * unparseable string, unparseable floor, any prerelease tag — boots with a
 * warning. Being unable to verify the runtime is not evidence against it.
 *
 * What `below-floor` asserts is exactly "this version is below the supported
 * floor", not "this binary contains #32111". A backported or vendor-patched
 * 1.3.x could carry the fix and would still be refused. That is deliberate: we
 * support what we test, and the version string is the only evidence available.
 *
 * ## What "ok" does and does not mean
 *
 * It means "this version string is a release at or above the floor". It does
 * NOT mean the binary is a stable build: the binary this repo is deployed on
 * reports `Bun.version === "1.4.0"` while `bun --revision` prints
 * `1.4.0-canary.1+8326d1bd3`. Bun does not expose the canary suffix through
 * `Bun.version` or `process.versions.bun`, so a canary of the floor version is
 * indistinguishable from the release through the API this check can read. That
 * is why `Bun.revision` rides along in the `unverified` warning and in
 * `/api/system/info`: it is the only field that separates two builds claiming
 * the same version, and an `ok` verdict on its own will not tell you which one
 * you are running.
 */

/**
 * Minimum Bun release this proxy supports. Kept in step with `engines.bun`,
 * `.bun-version`, the root `devDependencies.bun` pin and the README by the
 * consistency tests in `bun-runtime-floor.test.ts` — change it here and those
 * tests name every other place that has to move.
 */
export const MIN_BUN_VERSION = "1.4.0";

/**
 * Exit status used when the runtime is below the floor. 78 is `EX_CONFIG` from
 * `sysexits.h`: "configuration error", i.e. something a restart cannot fix.
 * Distinct from the generic 1 so systemd can suppress restarts for this case
 * alone (`RestartPreventExitStatus=78`).
 */
export const UNSUPPORTED_RUNTIME_EXIT_CODE = 78;

export type BunRuntimeVerdict =
	/** Version string is a release at or above the floor. */
	| "ok"
	/** Could not be proven below the floor. Boots, warns. */
	| "unverified"
	/** Parsed, and strictly below the floor. The only refusal. */
	| "below-floor";

export interface BunRuntimeCheck {
	verdict: BunRuntimeVerdict;
	/** The raw string that was evaluated, trimmed; null when there was none. */
	version: string | null;
	/** The floor it was evaluated against. */
	floor: string;
	/** Operator-facing explanation. Null only when the verdict is `ok`. */
	message: string | null;
}

/** A canonical `MAJOR.MINOR.PATCH` with SemVer's optional tails. */
interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	/** The `-…` tail, or null for a release. Build metadata is not a tail. */
	prerelease: string | null;
}

/**
 * Anchored on purpose. A relaxed pattern would happily find `1.3.14` inside
 * `bun 1.3.14 (0d9b296af)` — or inside an error message — and refuse to boot on
 * a string that was never a version.
 *
 * The tails use SemVer's real identifier grammar rather than a loose character
 * class. A loose one accepts empty identifiers and leading-zero numerics
 * (`1.3.14-.`, `1.3.14-foo..bar`, `1.3.14-01`), and because the triple in front
 * of them still parses, malformed input like that would come out as
 * `below-floor` — a refusal on a string this module cannot actually read, which
 * is precisely the failure mode the policy above forbids. Prerelease
 * identifiers are alphanumeric or leading-zero-free numerics (SemVer §9); build
 * identifiers are alphanumeric with no such restriction (§10).
 *
 * Triple components are capped at nine digits so the numeric comparison below
 * stays inside `Number.MAX_SAFE_INTEGER`, and their leading zeros are rejected
 * as SemVer §2 requires.
 */
const PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const BUILD_IDENTIFIER = "[0-9A-Za-z-]+";
const TRIPLE_COMPONENT = "(0|[1-9]\\d{0,8})";
const VERSION_PATTERN = new RegExp(
	`^${TRIPLE_COMPONENT}\\.${TRIPLE_COMPONENT}\\.${TRIPLE_COMPONENT}` +
		`(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?` +
		`(?:\\+${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*)?$`,
);

function parseVersion(raw: string): ParsedVersion | null {
	const match = VERSION_PATTERN.exec(raw);
	if (!match) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] ?? null,
	};
}

/** Negative, zero or positive as `a` orders before, with, or after `b`. */
function compareTriples(a: ParsedVersion, b: ParsedVersion): number {
	return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Classify a Bun version string against the floor. Pure: no globals, no I/O, no
 * process effects — the whole point is that it can be exhaustively tested.
 */
export function evaluateBunRuntime(
	version: string | null | undefined,
	floor: string = MIN_BUN_VERSION,
): BunRuntimeCheck {
	const raw = version?.trim() ?? "";
	const parsedFloor = parseVersion(floor.trim());

	// A caller who passes a broken floor must not be able to turn this into a
	// boot failure. Report the defect, boot anyway. A floor carrying a
	// prerelease tag counts as broken: comparison here is on release triples
	// only, so `>=1.4.0-canary` would silently behave as `>=1.4.0` and mean
	// something the caller did not write.
	if (!parsedFloor || parsedFloor.prerelease !== null) {
		return {
			verdict: "unverified",
			version: raw === "" ? null : raw,
			floor,
			message:
				`Cannot check the Bun runtime floor: the configured floor "${floor}" is not a ` +
				`stable MAJOR.MINOR.PATCH version. Starting without a runtime check.`,
		};
	}

	if (raw === "") {
		return {
			verdict: "unverified",
			version: null,
			floor,
			message:
				`Cannot determine the Bun version this process is running on. ` +
				`ClankerMux requires Bun ${floor} or newer (oven-sh/bun#32111: on older ` +
				`runtimes a client aborting a streaming response segfaults the process). ` +
				`Starting anyway — verify the runtime with \`bun --revision\`.`,
		};
	}

	const parsed = parseVersion(raw);
	if (!parsed) {
		return {
			verdict: "unverified",
			version: raw,
			floor,
			message:
				`Unrecognised Bun version string "${raw}" — cannot compare it against the ` +
				`required floor of ${floor} (oven-sh/bun#32111). Starting anyway; verify ` +
				`the runtime with \`bun --revision\`.`,
		};
	}

	if (compareTriples(parsed, parsedFloor) < 0) {
		return {
			verdict: "below-floor",
			version: raw,
			floor,
			message:
				`Refusing to start on Bun ${raw}: ClankerMux requires Bun ${floor} or newer.\n` +
				`  Reason: since v2026.8.21 the proxy disposes a cloned response body while ` +
				`extracting usage. On Bun below ${floor} that path hits oven-sh/bun#32111 — a ` +
				`NATIVE segfault whenever a client aborts a streaming response, which is ` +
				`routine traffic for a proxy. It cannot be caught or logged; the process ` +
				`simply dies. Fixed upstream by oven-sh/bun#32120, shipped in Bun 1.4.0.\n` +
				`  Fix: upgrade the runtime (\`bun upgrade\`, or reinstall from https://bun.sh) ` +
				`and check with \`bun --revision\` that the binary systemd actually launches ` +
				`is the upgraded one.`,
		};
	}

	// At or above the floor by release number. A prerelease tag on top of that
	// is not proof: 1.4.0's canaries span 2026-05 to 2026-08, and #32120 only
	// merged 2026-06-21, so an early 1.4.0-canary predates the fix. SemVer
	// ranges exclude prereleases for the same reason. Boot, but say so.
	if (parsed.prerelease !== null) {
		return {
			verdict: "unverified",
			version: raw,
			floor,
			message:
				`Bun ${raw} is a prerelease build. Its version number is at or above the ` +
				`required floor of ${floor}, but a prerelease is not proof that it contains ` +
				`the oven-sh/bun#32120 fix for the streaming-abort segfault (#32111) — ` +
				`1.4.0 canaries were cut both before and after that fix landed on ` +
				`2026-06-21. Starting anyway; prefer a stable release of ${floor} or newer.`,
		};
	}

	return { verdict: "ok", version: raw, floor, message: null };
}

/** Thrown when the runtime is positively identified as below the floor. */
export class BunRuntimeFloorError extends Error {
	/** What the process should exit with. See {@link UNSUPPORTED_RUNTIME_EXIT_CODE}. */
	readonly exitCode = UNSUPPORTED_RUNTIME_EXIT_CODE;
	readonly check: BunRuntimeCheck;

	constructor(check: BunRuntimeCheck) {
		super(check.message ?? "Unsupported Bun runtime");
		this.name = "BunRuntimeFloorError";
		this.check = check;
	}
}

/** Best-effort read of the build sha; absent outside Bun. */
function readRevision(): string | null {
	const bun = (globalThis as { Bun?: { revision?: string } }).Bun;
	return bun?.revision ?? null;
}

/**
 * Check the runtime this process is on and act on the verdict.
 *
 * Throws {@link BunRuntimeFloorError} when the runtime is below the floor —
 * deliberately a throw rather than a `process.exit`, because `startServer` is
 * an exported programmatic entrypoint and a library has no business killing an
 * embedder's process. Only the `import.meta.main` boundary in
 * `apps/server/src/server.ts` decides to terminate, and it uses
 * `error.exitCode` when it does.
 *
 * Warns and returns for every other non-`ok` verdict. All external reads
 * (`process.versions.bun`, `Bun.revision`, the warning sink) are injectable so
 * the branches can be tested without a matching runtime.
 */
export function assertBunRuntimeFloor(options?: {
	version?: string | null;
	revision?: string | null;
	floor?: string;
	warn?: (message: string) => void;
}): BunRuntimeCheck {
	const version =
		options?.version !== undefined
			? options.version
			: (process.versions.bun ?? null);
	const check = evaluateBunRuntime(version, options?.floor ?? MIN_BUN_VERSION);

	if (check.verdict === "below-floor") {
		throw new BunRuntimeFloorError(check);
	}

	if (check.verdict === "unverified" && check.message) {
		const revision =
			options?.revision !== undefined ? options.revision : readRevision();
		const warn = options?.warn ?? console.warn;
		warn(
			revision
				? `${check.message} (build revision: ${revision})`
				: check.message,
		);
	}

	return check;
}
