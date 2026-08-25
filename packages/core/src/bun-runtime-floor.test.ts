import { describe, expect, test } from "bun:test";
import {
	assertBunRuntimeFloor,
	BunRuntimeFloorError,
	evaluateBunRuntime,
	MIN_BUN_VERSION,
	UNSUPPORTED_RUNTIME_EXIT_CODE,
} from "./bun-runtime-floor";

const REPO_ROOT = new URL("../../../", import.meta.url);

describe("evaluateBunRuntime — versions at or above the floor", () => {
	test("the exact floor, released, is ok", () => {
		const check = evaluateBunRuntime("1.4.0");
		expect(check.verdict).toBe("ok");
		expect(check.message).toBeNull();
		expect(check.version).toBe("1.4.0");
		expect(check.floor).toBe(MIN_BUN_VERSION);
	});

	test("build metadata alone does not make a release a prerelease", () => {
		// SemVer §10: build metadata is ignored for precedence. `1.4.0+vendor`
		// IS the 1.4.0 release, just rebuilt, so it must not be downgraded to
		// "unverified" the way a `-prerelease` tag is.
		expect(evaluateBunRuntime("1.4.0+vendor.3").verdict).toBe("ok");
	});

	test("higher patch, minor and major releases are ok", () => {
		expect(evaluateBunRuntime("1.4.1").verdict).toBe("ok");
		expect(evaluateBunRuntime("1.5.0").verdict).toBe("ok");
		expect(evaluateBunRuntime("2.0.0").verdict).toBe("ok");
	});

	test("component comparison is numeric, not lexicographic", () => {
		// "1.10.0" < "1.4.0" as strings; 1.10.0 > 1.4.0 as versions. Likewise
		// "1.4.10" vs "1.4.9", and "10.0.0" vs "9.0.0".
		expect(evaluateBunRuntime("1.10.0").verdict).toBe("ok");
		expect(evaluateBunRuntime("1.4.10").verdict).toBe("ok");
		expect(evaluateBunRuntime("10.0.0").verdict).toBe("ok");
		expect(evaluateBunRuntime("1.4.9", "1.4.10").verdict).toBe("below-floor");
		expect(evaluateBunRuntime("9.0.0", "10.0.0").verdict).toBe("below-floor");
	});

	test("whitespace around an otherwise valid version is tolerated", () => {
		expect(evaluateBunRuntime("  1.4.0\n").verdict).toBe("ok");
	});
});

describe("evaluateBunRuntime — versions below the floor", () => {
	test("the runtime this floor exists to exclude is refused", () => {
		const check = evaluateBunRuntime("1.3.14");
		expect(check.verdict).toBe("below-floor");
		expect(check.version).toBe("1.3.14");
		// The operator must be able to act on the message alone: it names the
		// upstream issue, the symptom and the remedy.
		expect(check.message).toContain("1.3.14");
		expect(check.message).toContain("1.4.0");
		expect(check.message).toContain("32111");
	});

	test("one patch below the floor is still below the floor", () => {
		expect(evaluateBunRuntime("1.3.99").verdict).toBe("below-floor");
	});

	test("a prerelease suffix does not rescue a lower release line", () => {
		// `1.3.15-canary.x` is built from the 1.3 line, so it cannot contain a
		// fix that only reached the 1.4 line.
		expect(evaluateBunRuntime("1.3.15-canary.20260601.1").verdict).toBe(
			"below-floor",
		);
		expect(evaluateBunRuntime("0.9.0-rc.1").verdict).toBe("below-floor");
	});
});

describe("evaluateBunRuntime — unverifiable inputs never refuse", () => {
	// The comparator must not become the outage it exists to prevent. Anything
	// it cannot positively read as "lower than the floor" boots, with a warning.

	test("missing version strings are unverified, not refused", () => {
		for (const input of [null, undefined, "", "   "]) {
			const check = evaluateBunRuntime(input);
			expect(check.verdict).toBe("unverified");
			expect(check.message).toBeString();
		}
	});

	test("malformed version strings are unverified, not refused", () => {
		for (const input of [
			"1.4",
			"1",
			"1.4.0.1",
			"v1.4.0",
			"1.4.x",
			"latest",
			"1.-4.0",
			"1.04.0", // leading zeros are not valid SemVer components
			"01.4.0",
		]) {
			expect(evaluateBunRuntime(input).verdict).toBe("unverified");
		}
	});

	test("the version match is anchored — no digging a version out of prose", () => {
		// A relaxed regex would find "1.3.14" inside these and refuse to boot on
		// a string that is not a version at all.
		for (const input of [
			"bun 1.3.14 (0d9b296af)",
			"Bun v1.3.14",
			"1.3.14-",
			"1.3.14 1.4.0",
		]) {
			expect(evaluateBunRuntime(input).verdict).toBe("unverified");
		}
	});

	test("absurdly long numeric components are unverified rather than compared", () => {
		// Beyond Number.MAX_SAFE_INTEGER the numeric comparison stops being
		// trustworthy, so the parser declines rather than guessing.
		expect(evaluateBunRuntime("1.4.99999999999999999999").verdict).toBe(
			"unverified",
		);
	});

	test("malformed prerelease and build tails do not sneak through as a refusal", () => {
		// The triple in front of a malformed tail parses fine, so a loose tail
		// pattern would classify these as "below-floor" and refuse to boot on a
		// string the module cannot actually read. Deliberately built on a
		// below-floor triple: on `1.4.0-…` these would land on "unverified"
		// anyway and hide the bug.
		for (const input of [
			"1.3.14-.", // empty identifier
			"1.3.14-.foo", // empty leading identifier
			"1.3.14-foo.", // empty trailing identifier
			"1.3.14-foo..bar", // empty inner identifier
			"1.3.14-01", // numeric identifier with a leading zero
			"1.3.14+.",
			"1.3.14+foo..bar",
		]) {
			expect(evaluateBunRuntime(input).verdict).toBe("unverified");
		}
	});

	test("well-formed tails still parse", () => {
		// The counterpart to the case above: tightening the grammar must not
		// start rejecting the shapes Bun actually ships.
		expect(evaluateBunRuntime("1.3.14-canary.0").verdict).toBe("below-floor");
		expect(evaluateBunRuntime("1.3.14-0.alpha-1+build.007").verdict).toBe(
			"below-floor",
		);
		expect(evaluateBunRuntime("1.4.0+build.007").verdict).toBe("ok");
	});

	test("an unparseable floor is unverified, never a refusal", () => {
		// A caller passing a broken floor must not be able to turn the guard
		// into a boot failure.
		const check = evaluateBunRuntime("1.0.0", "not-a-version");
		expect(check.verdict).toBe("unverified");
		expect(check.message).toContain("not-a-version");
	});

	test("a floor carrying a prerelease tag is rejected as a floor", () => {
		// Comparison is on release triples only, so a `1.4.0-canary` floor would
		// silently behave as `1.4.0` and mean something the caller did not
		// write. Refuse to interpret it rather than guess.
		const check = evaluateBunRuntime("1.0.0", "1.4.0-canary");
		expect(check.verdict).toBe("unverified");
		expect(check.message).toContain("stable MAJOR.MINOR.PATCH");
	});
});

describe("evaluateBunRuntime — prereleases of the floor line", () => {
	// Bun's own canaries are the reason this branch exists. `--revision` on the
	// binary this repo is deployed on prints `1.4.0-canary.1+8326d1bd3`, and
	// #32120 merged 2026-06-21 while 1.4.0 was released 2026-08-20, so a
	// 1.4.0-canary from before that merge would NOT carry the fix. We cannot
	// tell those apart from the version string, so they boot with a warning.

	test("a prerelease of the floor version is unverified, not ok and not refused", () => {
		const check = evaluateBunRuntime("1.4.0-canary.20260501.1");
		expect(check.verdict).toBe("unverified");
		expect(check.message).toContain("prerelease");
	});

	test("prereleases of higher lines are also unverified", () => {
		// A higher prerelease line is not proof of ancestry either, and SemVer
		// ranges do not admit prereleases by default. Reported honestly rather
		// than blessed.
		expect(evaluateBunRuntime("1.5.0-canary.20260901.1").verdict).toBe(
			"unverified",
		);
		expect(evaluateBunRuntime("2.0.0-rc.1").verdict).toBe("unverified");
	});

	test("every prerelease flavour Bun has shipped parses as a prerelease", () => {
		for (const input of [
			"1.4.0-canary.1",
			"1.4.0-canary.1+8326d1bd3",
			"1.4.0-canary.20260823.1",
			"1.4.0-alpha",
			"1.4.0-beta.2",
			"1.4.0-rc.1",
		]) {
			expect(evaluateBunRuntime(input).verdict).toBe("unverified");
		}
	});
});

describe("assertBunRuntimeFloor", () => {
	test("throws a typed, exit-code-carrying error below the floor", () => {
		let thrown: unknown;
		try {
			assertBunRuntimeFloor({ version: "1.3.14", warn: () => {} });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(BunRuntimeFloorError);
		const error = thrown as BunRuntimeFloorError;
		expect(error.exitCode).toBe(UNSUPPORTED_RUNTIME_EXIT_CODE);
		expect(error.check.verdict).toBe("below-floor");
		expect(error.message).toContain("32111");
	});

	test("does not warn or throw on a satisfied floor", () => {
		const warnings: string[] = [];
		const check = assertBunRuntimeFloor({
			version: "1.4.0",
			warn: (m) => warnings.push(m),
		});
		expect(check.verdict).toBe("ok");
		expect(warnings).toEqual([]);
	});

	test("warns once, and does not throw, when the runtime is unverifiable", () => {
		const warnings: string[] = [];
		const check = assertBunRuntimeFloor({
			version: "1.4.0-canary.1",
			revision: "8326d1bd3",
			warn: (m) => warnings.push(m),
		});
		expect(check.verdict).toBe("unverified");
		expect(warnings).toHaveLength(1);
		// The revision is the only thing that distinguishes two builds reporting
		// the same version string, so it has to reach the operator.
		expect(warnings[0]).toContain("8326d1bd3");
	});

	test("reads the live runtime when no version is injected", () => {
		// Positive control: the suite itself runs on a Bun that satisfies the
		// floor, so the un-injected path must not throw. If this ever fails, the
		// runtime running the tests is the problem, not the test.
		const check = assertBunRuntimeFloor({ warn: () => {} });
		expect(check.version).toBe(process.versions.bun);
		expect(check.verdict).not.toBe("below-floor");
	});
});

describe("the floor is declared consistently across the repo", () => {
	// Six places state the runtime floor: this constant, `engines.bun`,
	// `.bun-version` (what CI installs), two spots in the README, and the root
	// `devDependencies.bun` pin. That pin exists so package.json scripts do not
	// resolve the Bun binary that `bun-plugin-tailwind`'s peer dependency drops
	// into `node_modules/.bin`. Nothing enforces agreement at runtime, so it is
	// enforced here.

	async function readRepoFile(relative: string): Promise<string> {
		return await Bun.file(new URL(relative, REPO_ROOT).pathname).text();
	}

	test("the floor constant is itself a canonical stable version", async () => {
		// Everything below compares against MIN_BUN_VERSION, so a constant with
		// a prerelease tag or a malformed triple would quietly weaken the
		// checks rather than fail them.
		const self = evaluateBunRuntime(MIN_BUN_VERSION);
		expect(self.verdict).toBe("ok");
		expect(self.version).toBe(MIN_BUN_VERSION);
	});

	test("package.json engines.bun is exactly the constant's floor", async () => {
		const pkg = JSON.parse(await readRepoFile("package.json")) as {
			engines?: { bun?: string };
		};
		expect(pkg.engines?.bun).toBe(`>=${MIN_BUN_VERSION}`);
	});

	test("package.json pins the bun devDependency to the floor exactly", async () => {
		// Equality, for the same reason `.bun-version` uses it: a pin allowed to
		// drift above the floor would leave the declared minimum untested, and a
		// pin allowed to drift below re-creates the shadowed-runtime bug this
		// devDependency was added to fix — package.json scripts resolving the
		// Bun that `bun-plugin-tailwind`'s peer dependency drops into
		// `node_modules/.bin` instead of the one `.bun-version` declares.
		const pkg = JSON.parse(await readRepoFile("package.json")) as {
			devDependencies?: { bun?: string };
		};
		expect(pkg.devDependencies?.bun).toBe(MIN_BUN_VERSION);
	});

	test(".bun-version is the floor exactly, so CI tests the declared minimum", async () => {
		// Equality, not `>=`. Letting the pin drift above the floor would leave
		// the supported minimum untested while ci.yml and the deploy docs still
		// describe `.bun-version` as the floor. Raising the floor is one edit
		// here plus the constant, and this test names both.
		expect((await readRepoFile(".bun-version")).trim()).toBe(MIN_BUN_VERSION);
	});

	test("every Bun version the README states is the floor", async () => {
		const readme = await readRepoFile("README.md");
		// Structural, not existential: a stale badge left beside a correct one
		// would satisfy a `toContain` check. The badge encodes "≥" as the URL
		// escape %E2%89%A5.
		const badges = [...readme.matchAll(/Bun%20%E2%89%A5([0-9.]+)/g)].map(
			(m) => m[1],
		);
		expect(badges.length).toBeGreaterThan(0);
		expect(new Set(badges)).toEqual(new Set([MIN_BUN_VERSION]));

		const prose = readme.match(
			/Requires \[Bun\]\(https:\/\/bun\.sh\) (\S+) or newer/,
		);
		expect(prose?.[1]).toBe(MIN_BUN_VERSION);
	});

	test("every CI setup-bun step installs from .bun-version", async () => {
		const workflow = await readRepoFile(".github/workflows/ci.yml");
		// Counted, not merely present: a fifth job added later must not be able
		// to slip in on setup-bun's `latest` default or a hardcoded version.
		const setupSteps = workflow.match(/uses: oven-sh\/setup-bun@/g) ?? [];
		const versionFiles =
			workflow.match(/bun-version-file: \.bun-version/g) ?? [];
		expect(setupSteps.length).toBeGreaterThan(0);
		expect(versionFiles).toHaveLength(setupSteps.length);
		// A hardcoded `bun-version:` is exactly how CI ended up running 1.3.14
		// while the code required 1.4.0.
		expect(workflow).not.toContain("bun-version:");
	});

	test("the systemd drop-in suppresses restarts for the exit code we use", async () => {
		// If these drift, the restart suppression silently stops matching and a
		// refusal crash-loops through StartLimitBurst again, with nothing
		// failing to say so.
		const dropIn = await readRepoFile(
			"deploy/systemd/clankermux.service.d/runtime-floor.conf",
		);
		expect(dropIn).toContain(
			`RestartPreventExitStatus=${UNSUPPORTED_RUNTIME_EXIT_CODE}`,
		);
	});
});

describe("the refusal reaches the operator as a process exit", () => {
	test("a child process prints the reason to stderr and exits with the code", async () => {
		// Unit tests cannot show that the message survives termination: stderr
		// buffering, not the comparator, decides whether the operator ever sees
		// why the service stopped.
		//
		// This DUPLICATES the `import.meta.main` boundary in
		// apps/server/src/server.ts rather than executing it, so it does not
		// cover that wiring. Booting the real entrypoint on a below-floor
		// runtime is a manual check (done on the 1.3.14 binary: exit 78, full
		// message, no port bound).
		const modulePath = new URL("./bun-runtime-floor.ts", import.meta.url)
			.pathname;
		const proc = Bun.spawnSync([
			process.execPath,
			"-e",
			`
			const { assertBunRuntimeFloor, BunRuntimeFloorError } =
				await import(${JSON.stringify(modulePath)});
			try {
				assertBunRuntimeFloor({ version: "1.3.14" });
			} catch (error) {
				if (error instanceof BunRuntimeFloorError) {
					console.error(error.message);
					process.exit(error.exitCode);
				}
				throw error;
			}
			`,
		]);
		expect(proc.exitCode).toBe(UNSUPPORTED_RUNTIME_EXIT_CODE);
		const stderr = new TextDecoder().decode(proc.stderr);
		expect(stderr).toContain("32111");
		expect(stderr).toContain(MIN_BUN_VERSION);
	});
});
