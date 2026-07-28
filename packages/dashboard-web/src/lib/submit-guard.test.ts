import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runGuarded } from "./submit-guard";

/** A submit that stays in flight until it is released, counting its runs. */
function pendingSubmit() {
	const state = { runs: 0, release: () => {} };
	const gate = new Promise<void>((resolve) => {
		state.release = resolve;
	});
	return {
		state,
		submit: async () => {
			state.runs += 1;
			await gate;
		},
	};
}

describe("runGuarded", () => {
	it("ignores a SECOND SYNCHRONOUS call while the first request is in flight", async () => {
		const latch = { current: false };
		const { state, submit } = pendingSubmit();

		// Two clicks in the same tick — the case React state cannot catch, because
		// its update would not have landed before the second handler ran.
		const first = runGuarded(latch, () => {}, submit);
		const second = runGuarded(latch, () => {}, submit);

		expect(state.runs).toBe(1);
		state.release();
		await Promise.all([first, second]);
		expect(state.runs).toBe(1);
	});

	it("does not rely on the setSubmitting mirror to make the decision", async () => {
		// The mirror is deliberately a no-op here: the latch alone must hold.
		const latch = { current: false };
		const { state, submit } = pendingSubmit();
		const calls: boolean[] = [];
		const setSubmitting = (v: boolean) => {
			calls.push(v);
		};

		const first = runGuarded(latch, setSubmitting, submit);
		await runGuarded(latch, setSubmitting, submit);
		expect(state.runs).toBe(1);
		// Only the admitted call touched the mirror.
		expect(calls).toEqual([true]);

		state.release();
		await first;
		expect(calls).toEqual([true, false]);
	});

	it("releases after the request settles so a retry is possible", async () => {
		const latch = { current: false };
		let runs = 0;
		const submit = async () => {
			runs += 1;
		};

		await runGuarded(latch, () => {}, submit);
		await runGuarded(latch, () => {}, submit);
		expect(runs).toBe(2);
		expect(latch.current).toBe(false);
	});

	it("releases (and rethrows) when the request fails", async () => {
		const latch = { current: false };
		const calls: boolean[] = [];
		await expect(
			runGuarded(
				latch,
				(v) => calls.push(v),
				async () => {
					throw new Error("boom");
				},
			),
		).rejects.toThrow("boom");
		expect(latch.current).toBe(false);
		expect(calls).toEqual([true, false]);
	});

	it("guards each handler independently when they share one latch", async () => {
		// The four account-creation handlers share a single latch, so a submit of
		// ANY kind blocks a concurrent submit of any other kind — a duplicate
		// device session is the same bug class as a duplicate account row.
		const latch = { current: false };
		const a = pendingSubmit();
		const b = pendingSubmit();

		const first = runGuarded(latch, () => {}, a.submit);
		const second = runGuarded(latch, () => {}, b.submit);
		expect(a.state.runs).toBe(1);
		expect(b.state.runs).toBe(0);

		a.state.release();
		b.state.release();
		await Promise.all([first, second]);
	});
});

/**
 * Structural coverage for the wiring. There is no DOM test harness in this repo
 * (component tests use `renderToStaticMarkup`, which cannot click), so the four
 * handlers' use of the guard is pinned against the source instead of simulated.
 */
describe("AccountAddForm submit wiring", () => {
	const source = readFileSync(
		join(import.meta.dir, "..", "components", "accounts", "AccountAddForm.tsx"),
		"utf8",
	);

	const handlers = [
		"handleStartQwenAuth",
		"handleStartCodexAuth",
		"handleAddAccount",
		"handleCodeSubmit",
	] as const;

	for (const handler of handlers) {
		it(`routes ${handler} through the guard`, () => {
			expect(source).toContain(
				`const ${handler} = () => guardSubmit(${handler}Inner);`,
			);
		});
	}

	it("uses a ref (not state) as the guard, and state only for `disabled`", () => {
		expect(source).toContain("const submittingRef = useRef(false);");
		expect(source).toContain(
			"runGuarded(submittingRef, setIsSubmitting, submit)",
		);
		// One `disabled` per account-creation button.
		expect(source.split("disabled={isSubmitting}").length - 1).toBe(
			handlers.length,
		);
	});
});
