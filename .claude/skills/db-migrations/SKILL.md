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

## Constraints

Additive `ALTER TABLE ADD COLUMN` only — no destructive rebuilds, data backfills,
table renames, or pre-migration VACUUM backups. Those were one-time legacy
upgrades and have been removed.

New tables go in `ensureSchema()` with `CREATE TABLE IF NOT EXISTS`.

## Database location

- Default: `~/.config/clankermux/clankermux.db`
- Custom: `CLANKERMUX_DB_PATH=/path/to/dev.db` in env or `.env`
  (legacy `BETTER_CCFLARE_DB_PATH` still honored)

```bash
sqlite3 ~/.config/clankermux/clankermux.db "SELECT name, provider, custom_endpoint FROM accounts;"
```

The former offline DB CLI commands (`--repair-db`, `--doctor`, `--compact`,
`--analyze`) are removed — use `sqlite3` directly for offline maintenance.
