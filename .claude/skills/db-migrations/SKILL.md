---
name: db-migrations
description: Adding a column, table or migration to the ClankerMux SQLite database. Read this before editing packages/database/src/migrations.ts or adding any schema change — there is a two-step requirement whose omission fails silently on every existing live database.
---

# Database migrations (SQLite only)

SQLite is the only backend — there is **no PostgreSQL support** and no
`migrations-pg.ts`.

Fresh installs get the **complete** schema from `ensureSchema()` in
`packages/database/src/migrations.ts`. Existing live DBs are brought forward by
`runMigrations()`, which applies only the columns added since they were created.

## The supported floor

`runMigrations()` can only carry a DB forward from the oldest schema we declare
support for. That floor is the schema a fresh install produced from the newest
`migrations.ts` available when the repository went public on 2026-05-13 —
commit `0e4ad752`. Anything older (a private pre-public ClankerMux DB, or an
upstream better-ccflare / ccflare one) is deliberately unsupported.

The floor is not a claim, it is a fixture:
`packages/database/src/__tests__/schema-floor.fixture.ts` holds the floor DDL,
the first-shipped column set of every table created since, and the list of
deliberately retired columns and tables. It is **frozen historical data** —
measured by executing the floor commit's own `ensureSchema()`/`runMigrations()`,
never regenerated from the current schema. Refreshing it from HEAD would make
the floor tests assert that the current schema equals itself.

Legitimate edits to it: a baseline for a table you just added, a
`RETIRED_AFTER_FLOOR` entry for something you deliberately dropped, and (only by
explicit decision) re-measuring `FLOOR_SCHEMA_SQL` to raise the floor.

## Order: ALTERs first, then ensureSchema()

`runMigrations()` applies `ADDITIVE_COLUMNS` **before** `ensureSchema()`. That
order is load-bearing. `ensureSchema()` creates indexes, and an index over a
column only `ADDITIVE_COLUMNS` can supply throws `no such column` at startup on
every upgraded DB if it runs first — which already happened once, to
`idx_request_payloads_size` over `request_payloads.bytes`. With the ALTERs
first, index DDL can reference any column unconditionally.

Entries are **never removed**. An entry is the only thing that can carry a
column onto a DB created before it existed; deleting one silently narrows the
supported floor. (That is exactly how the floor was lost once already: `35b993f0`
emptied the array on the premise that only two populations existed, this
deployment and fresh installs, missing everyone who cloned during the public
window.)

## Adding a column — both steps are required

1. Add it to the relevant `CREATE TABLE` in `ensureSchema()` — so fresh installs
   have it.
2. Append one entry to the `ADDITIVE_COLUMNS` array in `runMigrations()` — so
   existing live DBs gain it on the next restart.

> **Skip step 2 and the column is silently missing on every existing live DB.**
> `ensureSchema()` only runs `CREATE TABLE IF NOT EXISTS`, which is a no-op when
> the table already exists. There is no startup error; the omission surfaces
> later as a runtime failure.

New columns also need the corresponding repository `SELECT` statements updated,
or they'll be written but never read back.

## Never change a DEFAULT inside a CREATE TABLE

An `ALTER TABLE ADD COLUMN` cannot alter an existing column's default, so
editing a `DEFAULT` in `ensureSchema()` changes fresh installs **only** and
splits behavior permanently between old and new databases.

This has already happened once and cannot be repaired:
`accounts.auto_pause_on_overage_enabled` is `DEFAULT 0` on the floor and on this
deployment's DB, and `DEFAULT 1` on a fresh install (changed by `c20d32c3`).
`migrations-floor.test.ts` pins it in `KNOWN_DEFAULT_DIVERGENCES` and asserts
that set by **equality**, so a second divergence fails the suite.

What defuses it: every production `INSERT INTO accounts` names the column
explicitly and passes `1`, so the table default is not load-bearing on any code
path. Do the same for any column whose default matters — never rely on the
table default in an INSERT.

## Constraints

Additive `ALTER TABLE ADD COLUMN` only — no destructive rebuilds, data
backfills, table renames, or pre-migration VACUUM backups inside migrations.
Those were one-time legacy upgrades and have been removed.

New tables go in `ensureSchema()` with `CREATE TABLE IF NOT EXISTS`.

## Data backfills live in backfills.ts

One-shot data passes go in `packages/database/src/backfills.ts`
(`runOneShotBackfills()`, called right after `runMigrations()`), never inside
`runMigrations()` — migrations stay schema-only.

Each pass must be **one-shot, not level-triggered**, and must record that it
ran: a marker row in the `strategies` table under a `backfill:` name, written in
the SAME transaction as the UPDATE so a crash cannot half-apply it. A pass that
re-derives state on every start silently overwrites whatever the operator
changed by hand afterwards — for a user-facing toggle that means re-enabling it
on every restart, forever.

## What the tests enforce

- `schema-invariant.test.ts` — for every table, current columns must equal
  baseline minus retired plus `ADDITIVE_COLUMNS`. **This is what catches a
  column added to a `CREATE TABLE` with no entry**, and it fails immediately
  rather than years later on someone else's install. It also rejects orphaned
  entries and an unaccounted-for new table.
- `migrations-floor.test.ts` — upgrades a real floor DB (leftovers and all, rows
  seeded first so a `NOT NULL` column missing its `DEFAULT` fails like it would
  in production) and compares every column's type/notnull/default/pk and every
  index's definition against a fresh install.
- `migrations-upgrade.test.ts` — strips every `ADDITIVE_COLUMNS` column from a
  fresh DB and proves `runMigrations()` puts it back identically.
- `ensure-schema-completeness.test.ts` — `ensureSchema()` alone produces the
  full current schema for a fresh install.
- `backfills.test.ts` — the one-shot passes apply once and never re-apply.

## Database location

- Default: `~/.config/clankermux/clankermux.db`
- Custom: `CLANKERMUX_DB_PATH=/path/to/dev.db` in env or `.env`
  (legacy `BETTER_CCFLARE_DB_PATH` still honored)

```bash
sqlite3 ~/.config/clankermux/clankermux.db "SELECT name, provider, custom_endpoint FROM accounts;"
```

The former offline DB CLI commands (`--repair-db`, `--doctor`, `--compact`,
`--analyze`) are removed — use `sqlite3` directly for offline maintenance.
