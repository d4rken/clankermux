/**
 * Regenerate the golden fixture of the UNSCOPED /api/analytics wire response.
 *
 *   bun run packages/http-api/scripts/generate-analytics-golden.ts
 *
 * The fixture is the regression baseline for section-scoping: it was captured
 * from the pre-sections handler, so `analytics-sections.test.ts` comparing
 * against it proves the no-`sections` path still emits every field with the
 * same values. Comparing "no sections" against "all sections explicitly" would
 * only prove the two NEW paths agree with each other.
 *
 * Only regenerate when the wire contract is INTENTIONALLY changed — a diff here
 * is exactly the signal the test exists to raise.
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunSqlAdapter, ensureSchema } from "@clankermux/database";
import { createAnalyticsHandler } from "../src/handlers/analytics-direct";
import {
	FIXED_NOW,
	seedAnalyticsFixture,
} from "../src/handlers/__tests__/analytics-section-fixture";
import type { APIContext } from "../src/types";

const OUTPUT = join(
	import.meta.dir,
	"..",
	"src",
	"handlers",
	"__tests__",
	"__fixtures__",
	"analytics-unscoped-golden.json",
);

// The handler reads Date.now() for the burn-rate windows and the range cutoff.
// Pin it to the fixture's anchor so the captured response is reproducible.
const realNow = Date.now;
Date.now = () => FIXED_NOW;

const db = new Database(":memory:");
ensureSchema(db);
seedAnalyticsFixture(db);

const adapter = new BunSqlAdapter(db);
const context = {
	db: adapter,
	config: {},
	dbOps: { getAdapter: () => adapter },
} as unknown as APIContext;

const response = await createAnalyticsHandler(context)(
	new URLSearchParams({ range: "all" }),
);
if (response.status !== 200) {
	throw new Error(`handler returned ${response.status}`);
}
const body = await response.json();

Date.now = realNow;
db.close();

writeFileSync(OUTPUT, `${JSON.stringify(body, null, "\t")}\n`);
console.log(`wrote ${OUTPUT}`);
