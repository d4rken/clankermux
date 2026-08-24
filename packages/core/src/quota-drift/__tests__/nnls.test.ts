import { describe, expect, it } from "bun:test";
import { choleskySolve, nnls, olsSolve } from "../nnls";

describe("nnls", () => {
	it("recovers known non-negative coefficients from exact data", () => {
		const truth = [2.5, 0.7, 4.0];
		const X: number[][] = [];
		const y: number[] = [];
		for (let i = 0; i < 40; i++) {
			const row = [
				((i * 7) % 11) + 1,
				((i * 3) % 5) + 0.5,
				((i * 13) % 17) + 2,
			];
			X.push(row);
			y.push(row[0] * truth[0] + row[1] * truth[1] + row[2] * truth[2]);
		}

		const { coefficients, rankDeficient } = nnls(X, y);

		expect(rankDeficient).toBe(false);
		for (let j = 0; j < truth.length; j++) {
			expect(coefficients[j]).toBeCloseTo(truth[j], 6);
		}
	});

	it("recovers coefficients whose columns differ by orders of magnitude", () => {
		// The column-scaling requirement: without it the normal equations for a
		// design spanning 1e0 and 1e6 are badly conditioned for no reason.
		const truth = [3, 0.000_5];
		const X: number[][] = [];
		const y: number[] = [];
		for (let i = 0; i < 50; i++) {
			const row = [((i * 5) % 9) + 1, (((i * 11) % 13) + 1) * 1e6];
			X.push(row);
			y.push(row[0] * truth[0] + row[1] * truth[1]);
		}

		const { coefficients } = nnls(X, y);

		expect(coefficients[0]).toBeCloseTo(truth[0], 4);
		expect(coefficients[1] / truth[1]).toBeCloseTo(1, 4);
	});

	it("clamps a truly-negative coefficient to zero rather than reporting it", () => {
		// y is built with a NEGATIVE weight on column 1. A model cannot consume a
		// negative amount of a window, so the feasible answer is 0.
		const X: number[][] = [];
		const y: number[] = [];
		for (let i = 0; i < 30; i++) {
			const row = [((i * 3) % 7) + 1, ((i * 5) % 11) + 1];
			X.push(row);
			y.push(row[0] * 2 - row[1] * 1.5);
		}

		const { coefficients } = nnls(X, y);

		expect(coefficients[1]).toBe(0);
		expect(coefficients[0]).toBeGreaterThan(0);
	});

	it("returns zeros for an empty problem instead of throwing", () => {
		expect(nnls([], []).coefficients).toEqual([]);
	});

	it("resolves exactly-collinear columns by pinning one at zero, never by splitting", () => {
		// Two identical columns: the split between them is not determined by the
		// data. The non-negativity constraint resolves it on the boundary rather
		// than inventing a half-and-half answer, and a coefficient pinned at 0 is
		// what the identifiability gate reads as unidentified (see
		// collinearity.test.ts, which is where the display-side guarantee lives).
		const X: number[][] = [];
		const y: number[] = [];
		for (let i = 0; i < 30; i++) {
			const v = ((i * 3) % 7) + 1;
			X.push([v, v]);
			y.push(v * 4);
		}

		const { coefficients } = nnls(X, y);

		const zeroes = coefficients.filter((c) => c === 0).length;
		expect(zeroes).toBe(1);
		expect(coefficients[0] + coefficients[1]).toBeCloseTo(4, 6);
	});

	it("propagates a rank-deficient active set instead of solving through it", () => {
		// The guard itself: a Gram matrix that only factorises with the jitter must
		// come back flagged. Reached here through choleskySolve, which is the rank
		// check nnls consults on every active-set solve.
		const singular = [
			[1, 1],
			[1, 1],
		];
		const solved = choleskySolve(singular, [1, 1]);
		expect(solved?.jittered).toBe(true);
	});
});

describe("choleskySolve", () => {
	it("solves a positive-definite system without needing the jitter", () => {
		const A = [
			[4, 1],
			[1, 3],
		];
		const result = choleskySolve(A, [1, 2]);
		expect(result).not.toBeNull();
		const { x, jittered } = result as { x: number[]; jittered: boolean };
		expect(jittered).toBe(false);
		expect(A[0][0] * x[0] + A[0][1] * x[1]).toBeCloseTo(1, 10);
		expect(A[1][0] * x[0] + A[1][1] * x[1]).toBeCloseTo(2, 10);
	});

	it("flags a singular system as jittered rather than passing it off as solved", () => {
		const singular = [
			[1, 1],
			[1, 1],
		];
		const result = choleskySolve(singular, [1, 1]);
		expect(result).not.toBeNull();
		expect((result as { jittered: boolean }).jittered).toBe(true);
	});
});

describe("olsSolve", () => {
	it("recovers a negative coefficient (unlike nnls)", () => {
		const X: number[][] = [];
		const y: number[] = [];
		for (let i = 0; i < 30; i++) {
			const row = [((i * 3) % 7) + 1, ((i * 5) % 11) + 1];
			X.push(row);
			y.push(row[0] * 2 - row[1] * 1.5);
		}
		const beta = olsSolve(X, y);
		expect(beta).not.toBeNull();
		expect((beta as number[])[1]).toBeCloseTo(-1.5, 6);
	});
});
