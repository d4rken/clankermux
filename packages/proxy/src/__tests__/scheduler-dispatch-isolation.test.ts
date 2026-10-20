import { expect, it } from "bun:test";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

// Each child shares one module registry across its files, but not with this
// spawner or either other child. Never discover tests here: that would recurse.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const CACHE =
	"./packages/proxy/src/__tests__/cache-keepalive-scheduler.test.ts";
const AUTO = "./packages/proxy/src/__tests__/auto-refresh-race-guard.test.ts";
const INNER = "./packages/proxy/src/__tests__/sdk-bridge-inner.test.ts";
const SUBSTITUTION =
	"./packages/proxy/src/__tests__/served-model-substitution.test.ts";
const CASES = [
	{ name: "cache-first", files: [CACHE, INNER, SUBSTITUTION] },
	{ name: "auto-first", files: [AUTO, INNER, SUBSTITUTION] },
	{ name: "consumers-first", files: [INNER, SUBSTITUTION, CACHE, AUTO] },
] as const;
const PROCESS_TIMEOUT_MS = 180_000;

type CollectedTest = { name: string; status: string };

function parseOutput(output: string) {
	const files: string[] = [];
	const testsByFile = new Map<string, CollectedTest[]>();
	const failedTests: string[] = [];
	const problems: string[] = [];
	let currentFile: string | undefined;
	let recap = false;
	let passes = 0;
	let failures = 0;
	let collected = 0;
	let summaryPasses: number | undefined;
	let summaryFailures: number | undefined;
	let summaryTests: number | undefined;
	let summaryFiles: number | undefined;

	// Bun's default reporter prints file headers and (pass)/(fail) identities,
	// then repeats failures under "N tests failed:". Do not collect that recap
	// as more tests or assign its identities to the last executed file.
	for (const line of stripVTControlCharacters(output).split(/\r?\n/)) {
		const header = line.match(
			/^(?:##\[group\]|::group::)?((?:\.\/)?packages\/.*\.test\.ts):$/,
		);
		if (header) {
			currentFile = header[1].replace(/^\.\//, "");
			files.push(currentFile);
			if (testsByFile.has(currentFile)) {
				problems.push(`duplicate file header: ${currentFile}`);
			} else {
				testsByFile.set(currentFile, []);
			}
		}
		if (/^\d+ tests? failed:$/.test(line)) recap = true;
		const test = line.match(
			/^\((pass|fail|skip|todo)\) (.+?)(?: \[[\d.]+ms\])?$/,
		);
		if (test && !recap) {
			const [, status, name] = test;
			if (!currentFile) {
				problems.push(`test without a file header: ${name}`);
			} else {
				testsByFile.get(currentFile)?.push({ name, status });
			}
			collected++;
			if (status === "pass") passes++;
			if (status === "fail") {
				failures++;
				failedTests.push(name);
			}
		}
		const passSummary = line.match(/^\s+(\d+) pass$/);
		const failSummary = line.match(/^\s+(\d+) fail$/);
		const runSummary = line.match(/^Ran (\d+) tests? across (\d+) files?\./);
		if (passSummary) summaryPasses = Number(passSummary[1]);
		if (failSummary) summaryFailures = Number(failSummary[1]);
		if (runSummary) {
			summaryTests = Number(runSummary[1]);
			summaryFiles = Number(runSummary[2]);
		}
		if (
			/Unhandled error between tests|Cannot find module|ModuleNotFound/.test(
				line,
			)
		) {
			problems.push(`load/unhandled error: ${line}`);
		}
	}
	if (summaryPasses !== passes || summaryFailures !== failures) {
		problems.push(
			`missing or inconsistent pass/fail summary: collected ${passes}/${failures}, reported ${summaryPasses}/${summaryFailures}`,
		);
	}
	if (summaryTests !== collected || summaryFiles !== files.length) {
		problems.push(
			`missing or inconsistent run summary: collected ${collected} tests in ${files.length} files, reported ${summaryTests} in ${summaryFiles}`,
		);
	}
	return { files, testsByFile, passes, failures, failedTests, problems };
}

function runCase(testCase: (typeof CASES)[number]) {
	let proc: Bun.ReadableSyncSubprocess | undefined;
	let spawnError: unknown;
	try {
		proc = Bun.spawnSync(
			[process.execPath, "test", "--timeout", "30000", ...testCase.files],
			{
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
				timeout: PROCESS_TIMEOUT_MS,
				killSignal: "SIGKILL",
				env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
			},
		);
	} catch (error) {
		spawnError = error;
	}
	const output = proc
		? `${proc.stdout.toString()}\n${proc.stderr.toString()}`
		: "";
	const parsed = parseOutput(output);
	const exitCode = proc?.exitCode ?? null;
	if (spawnError) parsed.problems.push(`spawn failed: ${String(spawnError)}`);
	if (proc?.exitedDueToTimeout) {
		parsed.problems.push(`child timed out after ${PROCESS_TIMEOUT_MS}ms`);
	}
	if (proc?.signalCode) {
		parsed.problems.push(`child killed by signal ${proc.signalCode}`);
	}
	if (proc?.exitedDueToMaxBuffer) {
		parsed.problems.push("child killed after exceeding its output buffer");
	}
	if (exitCode !== 0) parsed.problems.push(`child exit code: ${exitCode}`);
	if (parsed.failures !== 0) {
		parsed.problems.push(`${parsed.failures} failing tests`);
	}

	// Emit every case before asserting, including both producer-first failures
	// and the control on an unfixed checkout. Keep the original child diagnostics.
	console.error(
		`scheduler isolation ${testCase.name} child output:\n${output}`,
	);
	console.log(
		`scheduler-isolation-result ${JSON.stringify({
			case: testCase.name,
			passes: parsed.passes,
			failures: parsed.failures,
			exitCode,
			files: parsed.files,
			failedTests: parsed.failedTests,
		})}`,
	);
	return { ...parsed, testCase };
}

it("scheduler tests leave the real dispatcher usable in either file order", () => {
	const results = CASES.map(runCase);
	const control = results.find(
		(result) => result.testCase.name === "consumers-first",
	);
	const problems: string[] = [];
	for (const result of results) {
		const expectedFiles = result.testCase.files.map((file) => file.slice(2));
		if (JSON.stringify(result.files) !== JSON.stringify(expectedFiles)) {
			result.problems.push(
				`wrong observed file order: ${JSON.stringify(result.files)}; expected ${JSON.stringify(expectedFiles)}`,
			);
		}
		for (const file of expectedFiles) {
			const tests = result.testsByFile.get(file) ?? [];
			if (!tests.some(({ status }) => status === "pass" || status === "fail")) {
				result.problems.push(`no executed test identities for ${file}`);
			}
			if (result !== control) {
				// Compare multisets, not just totals: a different/missing test must
				// fail even when counts match. Failed identities count during red.
				const identities = tests.map(({ name }) => name).sort();
				const controlIdentities = (control?.testsByFile.get(file) ?? [])
					.map(({ name }) => name)
					.sort();
				if (JSON.stringify(identities) !== JSON.stringify(controlIdentities)) {
					result.problems.push(
						`test identities/count differ from consumers-first for ${file}: ${JSON.stringify(identities)} versus ${JSON.stringify(controlIdentities)}`,
					);
				}
			}
		}
		problems.push(
			...result.problems.map(
				(problem) => `${result.testCase.name}: ${problem}`,
			),
		);
	}
	expect(problems).toEqual([]);
}, 600_000);

it("parses plain and CI-grouped Bun file headers", () => {
	const parsed = parseOutput(
		[
			"::group::packages/a.test.ts:",
			"(pass) x [1.00ms]",
			"::endgroup::",
			"##[group]packages/b.test.ts:",
			"(pass) y",
			"./packages/c.test.ts:",
			"(pass) z",
			"",
			" 3 pass",
			" 0 fail",
			"Ran 3 tests across 3 files. [5.00ms]",
		].join("\n"),
	);
	expect(parsed.files).toEqual([
		"packages/a.test.ts",
		"packages/b.test.ts",
		"packages/c.test.ts",
	]);
	expect(parsed.testsByFile.get("packages/a.test.ts")).toEqual([
		{ name: "x", status: "pass" },
	]);
	expect(parsed.problems).toEqual([]);
});
