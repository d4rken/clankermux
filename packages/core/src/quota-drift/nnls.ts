/**
 * Lawson-Hanson active-set non-negative least squares, over normal equations.
 *
 * Non-negativity is not a regularization convenience: a model cannot consume a
 * negative amount of a quota window, so an unconstrained fit that returns one is
 * reporting noise as a measurement. Clamping at zero keeps the estimate on the
 * feasible set, and a coefficient PINNED at zero is then correctly treated as
 * unidentified rather than as "this model is free".
 *
 * ## Numerical requirements this implementation meets
 *
 * - **Column scaling.** Each column is divided by its L2 norm before `XᵀX` is
 *   formed, and coefficients are unscaled afterwards. The normal equations
 *   square the condition number, and the exposure columns span orders of
 *   magnitude (a flagship model and a rarely-used one in the same fit), so
 *   without scaling the Cholesky is solving a badly conditioned system for no
 *   reason.
 * - **Rank check.** Cholesky on the active set falls back to a small diagonal
 *   jitter once so the active-set loop can still make progress, but a solve
 *   that needed the jitter is REPORTED as rank-deficient rather than passed off
 *   as a measurement. A rank-deficient active set means the columns in it do
 *   not determine their own coefficients; presenting a number anyway is how a
 *   collinear pair gets a confident-looking arbitrary split.
 *
 * Normal equations rather than per-iteration QR is a cost choice: the bootstrap
 * runs thousands of fits and `XᵀX` is formed once per resample. The substantive
 * protection against collinearity is the tolerance gate in `fit.ts`, not the
 * factorisation.
 */

export interface NnlsResult {
	/** Non-negative coefficients, one per column of X. */
	coefficients: number[];
	/**
	 * True when a Cholesky factorisation of an active set failed even after the
	 * jitter fallback. The coefficients are still returned (the last feasible
	 * iterate), but a caller must not present them as identified.
	 */
	rankDeficient: boolean;
	/** Iterations the active-set loop performed. */
	iterations: number;
}

/** Convergence tolerance on the dual (gradient) vector. */
const DUAL_TOLERANCE = 1e-10;

/** Relative jitter added to the Cholesky diagonal on a first failure. */
const CHOLESKY_JITTER = 1e-10;

/**
 * Solve `min ||Xb - y||²` subject to `b >= 0`.
 *
 * `X` is row-major with `X.length === y.length`. An empty problem returns zero
 * coefficients rather than throwing: a fit window with no segments is a normal
 * state, not an error.
 */
export function nnls(
	X: readonly (readonly number[])[],
	y: readonly number[],
	opts: { maxIterations?: number } = {},
): NnlsResult {
	const m = X.length;
	const n = m > 0 ? X[0].length : 0;
	if (m === 0 || n === 0) {
		return {
			coefficients: new Array(n).fill(0),
			rankDeficient: false,
			iterations: 0,
		};
	}

	// --- Column scaling ----------------------------------------------------
	const scale = new Array<number>(n).fill(0);
	for (let j = 0; j < n; j++) {
		let sum = 0;
		for (let i = 0; i < m; i++) sum += X[i][j] * X[i][j];
		const norm = Math.sqrt(sum);
		// A zero column carries no information; scale 1 leaves it as zeros and the
		// dual for it stays 0, so it is never brought into the active set.
		scale[j] = norm > 0 ? norm : 1;
	}
	const Xs: number[][] = new Array(m);
	for (let i = 0; i < m; i++) {
		const row = new Array<number>(n);
		for (let j = 0; j < n; j++) row[j] = X[i][j] / scale[j];
		Xs[i] = row;
	}

	// --- Precompute the normal equations -----------------------------------
	const XtX = matTMat(Xs, n);
	const Xty = matTVec(Xs, y, n);

	const b = new Array<number>(n).fill(0);
	const passive = new Array<boolean>(n).fill(false);
	let rankDeficient = false;
	const maxIterations = opts.maxIterations ?? 3 * n + 10;
	let iterations = 0;

	for (; iterations < maxIterations; iterations++) {
		// Dual: w = Xᵀ(y - Xb)
		const w = new Array<number>(n);
		for (let j = 0; j < n; j++) {
			let acc = Xty[j];
			for (let k = 0; k < n; k++) acc -= XtX[j][k] * b[k];
			w[j] = acc;
		}

		// Pick the most-violated inactive constraint.
		let best = -1;
		let bestVal = DUAL_TOLERANCE;
		for (let j = 0; j < n; j++) {
			if (passive[j]) continue;
			if (w[j] > bestVal) {
				bestVal = w[j];
				best = j;
			}
		}
		if (best === -1) break; // KKT satisfied

		passive[best] = true;

		// Inner loop: least-squares on the passive set, shrinking it until the
		// solution is feasible.
		for (;;) {
			const idx: number[] = [];
			for (let j = 0; j < n; j++) if (passive[j]) idx.push(j);
			if (idx.length === 0) break;

			const sub = subMatrix(XtX, idx);
			const rhs = idx.map((j) => Xty[j]);
			const solve = choleskySolve(sub, rhs);
			if (!solve) {
				// Not even the jitter made the active set solvable: back the column
				// out and report it.
				rankDeficient = true;
				passive[best] = false;
				break;
			}
			// A solve that only succeeded with the jitter means these columns do not
			// determine their own coefficients. Keep iterating (the loop needs a
			// direction) but never let the result be presented as identified.
			if (solve.jittered) rankDeficient = true;
			const solved = solve.x;

			let allPositive = true;
			for (const v of solved) {
				if (v <= 0) {
					allPositive = false;
					break;
				}
			}
			if (allPositive) {
				for (let j = 0; j < n; j++) if (!passive[j]) b[j] = 0;
				idx.forEach((j, k) => {
					b[j] = solved[k];
				});
				break;
			}

			// Step partway toward the infeasible solution.
			let alpha = Number.POSITIVE_INFINITY;
			idx.forEach((j, k) => {
				if (solved[k] <= 0) {
					const denom = b[j] - solved[k];
					if (denom > 0) alpha = Math.min(alpha, b[j] / denom);
				}
			});
			if (!Number.isFinite(alpha)) {
				rankDeficient = true;
				passive[best] = false;
				break;
			}
			idx.forEach((j, k) => {
				b[j] = b[j] + alpha * (solved[k] - b[j]);
			});
			let removedAny = false;
			for (const j of idx) {
				if (b[j] <= 1e-12) {
					b[j] = 0;
					passive[j] = false;
					removedAny = true;
				}
			}
			if (!removedAny) break; // no progress possible
		}
	}

	// Unscale.
	const coefficients = new Array<number>(n);
	for (let j = 0; j < n; j++) coefficients[j] = b[j] / scale[j];
	return { coefficients, rankDeficient, iterations };
}

function matTMat(X: readonly number[][], n: number): number[][] {
	const out: number[][] = Array.from({ length: n }, () =>
		new Array<number>(n).fill(0),
	);
	for (const row of X) {
		for (let j = 0; j < n; j++) {
			const rj = row[j];
			if (rj === 0) continue;
			for (let k = j; k < n; k++) out[j][k] += rj * row[k];
		}
	}
	for (let j = 0; j < n; j++) {
		for (let k = j + 1; k < n; k++) out[k][j] = out[j][k];
	}
	return out;
}

function matTVec(
	X: readonly number[][],
	y: readonly number[],
	n: number,
): number[] {
	const out = new Array<number>(n).fill(0);
	for (let i = 0; i < X.length; i++) {
		const row = X[i];
		const yi = y[i];
		if (yi === 0) continue;
		for (let j = 0; j < n; j++) out[j] += row[j] * yi;
	}
	return out;
}

function subMatrix(A: readonly number[][], idx: readonly number[]): number[][] {
	return idx.map((i) => idx.map((j) => A[i][j]));
}

/** A Cholesky solve, plus whether it needed the rank-deficiency fallback. */
export interface CholeskySolution {
	x: number[];
	/**
	 * True when the unjittered factorisation failed, i.e. the matrix is (numerically)
	 * singular. The returned `x` is then one of infinitely many answers and must
	 * never be reported as an identified estimate.
	 */
	jittered: boolean;
}

/**
 * Solve `A x = rhs` for symmetric positive-definite A via Cholesky, retrying
 * once with a small relative diagonal jitter.
 *
 * The retry exists so an iterative caller can keep making progress, NOT so a
 * singular system can quietly produce a number: `jittered` is the rank check
 * and every caller must propagate it. Returns null when even the jittered
 * factorisation fails.
 */
export function choleskySolve(
	A: readonly number[][],
	rhs: readonly number[],
): CholeskySolution | null {
	const direct = tryCholeskySolve(A, rhs, 0);
	if (direct) return { x: direct, jittered: false };
	let maxDiag = 0;
	for (let i = 0; i < A.length; i++) maxDiag = Math.max(maxDiag, A[i][i]);
	if (maxDiag <= 0) return null;
	const jittered = tryCholeskySolve(A, rhs, maxDiag * CHOLESKY_JITTER);
	return jittered ? { x: jittered, jittered: true } : null;
}

function tryCholeskySolve(
	A: readonly number[][],
	rhs: readonly number[],
	jitter: number,
): number[] | null {
	const n = A.length;
	const L: number[][] = Array.from({ length: n }, () =>
		new Array<number>(n).fill(0),
	);
	for (let i = 0; i < n; i++) {
		for (let j = 0; j <= i; j++) {
			let sum = A[i][j] + (i === j ? jitter : 0);
			for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
			if (i === j) {
				if (!(sum > 0) || !Number.isFinite(sum)) return null;
				L[i][j] = Math.sqrt(sum);
			} else {
				L[i][j] = sum / L[j][j];
				if (!Number.isFinite(L[i][j])) return null;
			}
		}
	}
	// Forward then back substitution.
	const z = new Array<number>(n).fill(0);
	for (let i = 0; i < n; i++) {
		let sum = rhs[i];
		for (let k = 0; k < i; k++) sum -= L[i][k] * z[k];
		z[i] = sum / L[i][i];
	}
	const x = new Array<number>(n).fill(0);
	for (let i = n - 1; i >= 0; i--) {
		let sum = z[i];
		for (let k = i + 1; k < n; k++) sum -= L[k][i] * x[k];
		x[i] = sum / L[i][i];
	}
	for (const v of x) if (!Number.isFinite(v)) return null;
	return x;
}

/**
 * Ordinary (sign-unconstrained) least squares via the same normal equations,
 * used by the tolerance diagnostic (regressing one exposure column on the
 * others). Returns null on a rank-deficient system.
 */
export function olsSolve(
	X: readonly (readonly number[])[],
	y: readonly number[],
): number[] | null {
	const m = X.length;
	const n = m > 0 ? X[0].length : 0;
	if (m === 0 || n === 0) return null;
	const scale = new Array<number>(n).fill(0);
	for (let j = 0; j < n; j++) {
		let sum = 0;
		for (let i = 0; i < m; i++) sum += X[i][j] * X[i][j];
		const norm = Math.sqrt(sum);
		scale[j] = norm > 0 ? norm : 1;
	}
	const Xs: number[][] = new Array(m);
	for (let i = 0; i < m; i++) {
		const row = new Array<number>(n);
		for (let j = 0; j < n; j++) row[j] = X[i][j] / scale[j];
		Xs[i] = row;
	}
	const solved = choleskySolve(matTMat(Xs, n), matTVec(Xs, y, n));
	if (!solved) return null;
	return solved.x.map((v, j) => v / scale[j]);
}
