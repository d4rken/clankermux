import { expect } from "bun:test";

/**
 * Shared assertions for the `/public/v1/*` wire contract.
 *
 * Not a test file (bun's discovery skips this name deliberately) — these run
 * inside the resource tests, over whole serialized payloads, so a field added
 * anywhere is covered without anyone remembering to list it.
 */

/**
 * A field name that denotes an INSTANT.
 *
 * The naming rule is the contract: instants end in `At` (or are the bare `at` /
 * `until`), and they NEVER carry a unit suffix. The trap this guards is a real
 * one — `UsagePrediction.etaExhaustMs` is `last.t + offset`, an absolute epoch
 * instant wearing a duration's name — so a field called `somethingAtMs` fails
 * both halves of this: it is matched as an instant and rejected as a number.
 */
const INSTANT_KEY = /(?:^|[a-z])At$|^at$|^until$/;

/**
 * A field name that denotes a DURATION: the unit is IN the name, either `Ms` or
 * a trailing capital `S` for seconds (`uptimeS`). A plural like `causes` or
 * `windows` ends in a lowercase `s` and is not matched.
 */
const DURATION_KEY = /Ms$|[a-z]S$/;

function isIsoInstant(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return false;
	// Round-trip, so "2023-11-14" or a locale spelling does not pass as RFC3339.
	return new Date(parsed).toISOString() === value;
}

function walk(
	value: unknown,
	path: string,
	visit: (key: string, value: unknown, path: string) => void,
): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			walk(item, `${path}[${index}]`, visit);
		});
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			visit(key, child, `${path}.${key}`);
			walk(child, `${path}.${key}`, visit);
		}
	}
}

/**
 * Every instant field anywhere in the payload is an ISO string (or null), and
 * every duration field is a number (or null). Asserted over the SERIALIZED
 * value, so a Date object that would stringify acceptably still fails — the
 * consumers see JSON, not JavaScript.
 */
export function assertInstantsAreIso(payload: unknown): void {
	const wire = JSON.parse(JSON.stringify(payload));
	walk(wire, "$", (key, value, path) => {
		if (INSTANT_KEY.test(key)) {
			if (value === null) return;
			expect(
				isIsoInstant(value),
				`${path} is an instant and must be an ISO-8601 string, got ${JSON.stringify(value)}`,
			).toBe(true);
		}
		if (DURATION_KEY.test(key)) {
			if (value === null) return;
			expect(
				typeof value === "number",
				`${path} is a duration and must be a number, got ${JSON.stringify(value)}`,
			).toBe(true);
		}
	});
}

/** Deepest container nesting in a value, counting the root as 1. */
export function depthOf(value: unknown, depth = 1): number {
	if (Array.isArray(value)) {
		return value.reduce<number>(
			(max, item) => Math.max(max, depthOf(item, depth + 1)),
			depth,
		);
	}
	if (value && typeof value === "object") {
		return Object.values(value).reduce<number>(
			(max, item) => Math.max(max, depthOf(item, depth + 1)),
			depth,
		);
	}
	return depth;
}

/** Nesting level of the deepest ARRAY, counting the outermost as 1. */
export function arrayNesting(value: unknown, level = 0): number {
	if (Array.isArray(value)) {
		return value.reduce<number>(
			(max, item) => Math.max(max, arrayNesting(item, level + 1)),
			level + 1,
		);
	}
	if (value && typeof value === "object") {
		return Object.values(value).reduce<number>(
			(max, item) => Math.max(max, arrayNesting(item, level)),
			level,
		);
	}
	return level;
}
