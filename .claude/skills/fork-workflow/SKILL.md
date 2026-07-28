---
name: fork-workflow
description: How ClankerMux work is branched, merged and released. Read this when starting a branch, merging into main, cutting a version bump, pulling a fix from the tombii/better-ccflare upstream, or merging an inbound PR from an external contributor.
---

# ClankerMux development workflow

The repo (`d4rken/better-ccflare` on GitHub) began as a fork of
`tombii/better-ccflare`, but it has diverged far enough — and intentionally
removed things upstream won't take — that **ClankerMux is now its own project**.
Treat it as such.

## The one lane: fork-only

| Aspect | Value |
|---|---|
| Branch prefix | `fix/*`, `feat/*`, or `fork/*` (any is fine; they're all fork-only) |
| Base branch | `origin/main` — never `upstream/main` |
| PR upstream? | No. We don't contribute to `tombii/better-ccflare`. |
| Merge style | `--no-ff` into `main` (the merge commit is the undo handle) |

## Making a change

Branch-creating steps move HEAD, so they happen **in a worktree** — never in the
live checkout. See the live-checkout section of `CLAUDE.md`.

```bash
# 1. Worktree off origin/main (EnterWorktree in Claude Code, or:)
git worktree add .claude/worktrees/<name> -b fix/<name> origin/main

# 2. Code the fix and tests. Write tests first for new functionality.

# 3. Verify — mandatory. `lint` rewrites files (biome check --write --unsafe),
#    so typecheck must run after it. No trailing `format`: check already formats.
bun run lint && bun run typecheck

# 4. Commit with a recognized prefix
git add <specific files>            # never `git add .`
git commit -m "fix: <subject>"

# 5. Bump the app version in the root package.json (see below)

# 6. Merge into main. This IS allowed in the live checkout — it advances main
#    in place rather than switching HEAD. Confirm the tree is clean first;
#    `git merge --abort` if it conflicts and resolve on the branch instead.
git merge --no-ff fix/<name> -m "Merge fix/<name>"
git push origin refs/heads/main:refs/heads/main
```

Ask Codex to review each commit's diff before merging, not just at plan time.

If Greptile leaves fewer than 5 findings on a branch, fix them on that same
branch before merging.

### Clean up the worktree after a confirmed merge

Once the user confirms they're happy **and** it's merged into `main`, remove the
worktree without waiting to be asked: `ExitWorktree(action: "remove")`, or
`git worktree remove .claude/worktrees/<name>` + `git branch -d <name>`. If the
tool refuses because of uncommitted files or unmerged commits, surface that
rather than forcing it. Only keep the worktree if the user says they want to
keep iterating in it.

## Version bumps

Two independent version values — don't confuse them:

- **`CLAUDE_CLI_VERSION`** (`packages/core/src/version.ts`) — the Claude Code CLI
  version echoed in upstream user-agent headers. Never bump manually; the
  pre-push hook auto-updates it to track the real CLI.
- **The app version** — the `"version"` field in the **root `package.json`**.
  Single source of truth (dashboard badge and startup log both read it).
  CalVer `YYYY.M.N`, deliberately diverged from upstream's `3.5.x` lineage so
  the two can never be numerically compared.

Bump the app version when landing a notable change into `main` — a fix, feature,
or anything user-visible, but not pure docs/comment tweaks. Same month → bump the
third segment (`2026.7.0` → `2026.7.1`); first release of a new month → roll the
month and reset (`2026.8.0`).

The string is purely a human-readable label — nothing parses it as semver. The
dashboard's "is my deploy current?" check is commit-SHA based via
`/api/version/check`. The `__CLANKERMUX_VERSION__` build define referenced in
`version.ts` is not currently injected anywhere; the app version resolves from
the root `package.json` at runtime (legacy `BETTER_CCFLARE_VERSION` env still
honored if set).

## Commit prefixes

The changelog tooling keys off these:

- Features: `feat:` `add:` `new:`
- Fixes: `fix:` `bug:` `resolve:`
- Security: `security:` `vulnerabilit:` `redact:` `ReDoS:`
- Improvements: `improve:` `enhance:` `update:` `refactor:`

## Publishing

ClankerMux is **not published** — build-from-source + systemd only. There is no
npm publish / release lane (the `release*.yml` and `docker-publish.yml` workflows
were removed). Don't run `bun publish`.

## The `upstream` remote: fetch-only, cherry-pick-only

`upstream` (`tombii/better-ccflare`) is kept for fetch only; its push URL is
disabled (`git remote set-url --push upstream DISABLED`).

**Pulling from upstream is rare and opportunistic, and is always a cherry-pick of
specific commits — never a merge or a re-baseline.** ClankerMux intentionally and
permanently removes code upstream keeps (Vertex/Bedrock and other unused
providers). A `git merge upstream/main` or a re-baseline re-adds that removed
code every time, silently undoing fork-only decisions.

```bash
git fetch upstream
git log upstream/main --oneline           # find the commit you want
# worktree off origin/main, then:
git cherry-pick <upstream-sha>            # resolve conflicts; drop re-added removals
bun run lint && bun run typecheck         # lint rewrites; typecheck runs after
# merge --no-ff into main as above
```

If a cherry-pick drags in code we deliberately removed, edit it out as part of
the cherry-pick — the goal is the fix, not upstream's tree.

## Merging inbound PRs from external contributors

Create a merge commit (`git merge --no-ff <branch-name>`) so their history and
identity are preserved. Don't use `gh pr merge` — it may squash or rebase. If the
branch isn't local: `git fetch origin pull/<PR_NUMBER>/head:<branch-name>`.
After merging, thank the contributor in the README Acknowledgements.

Before merging any branch, check what `main` gained since it forked:

```bash
MERGE_BASE=$(git merge-base <branch-name> origin/main)
git log $MERGE_BASE..origin/main --oneline       # commits on main the branch lacks
git diff $MERGE_BASE..origin/main --name-only    # files main changed since
```

Cross-check overlapping files and inspect those hunks before merging.

## Working a GitHub issue

Before implementing any issue, check whether recent commits already address it —
rate limiting, health, and proxy code change frequently:

```bash
git log refs/heads/main --since='<issue-open-date>' --oneline --no-merges -- <relevant-paths>
```

Ask the user whether the issue still applies given recent changes before
proceeding. Especially check: has the reported symptom been fixed? Does the
proposal conflict with new architecture?

Never close issues automatically — wait for the reporter to confirm the fix works
for them.

## Hard constraints

- Never branch off `upstream/main`, never open a PR against
  `tombii/better-ccflare`, never `git merge upstream/main` or re-baseline.
- Never `git push --force` (or `--force-with-lease`) to `origin/main` without
  explicit user confirmation for that specific operation.
- If `git push origin main` fails with `src refspec main matches more than one`
  (branch/tag name collision), push explicitly:
  `git push origin refs/heads/main:refs/heads/main`.
