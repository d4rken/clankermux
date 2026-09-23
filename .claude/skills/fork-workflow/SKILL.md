---
name: fork-workflow
description: How ClankerMux work is branched, merged and released. Read this when starting a branch, merging into main, cutting a version bump, or merging an inbound PR from an external contributor.
---

# ClankerMux development workflow

ClankerMux (`d4rken/clankermux` on GitHub) is a standalone project. It has no
upstream to track and takes nothing from one.

## The one lane

| Aspect | Value |
|---|---|
| Branch prefix | `fix/*`, `feat/*` (any is fine) |
| Base branch | `origin/main` |
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
  version sent in the user-agent of the requests ClankerMux originates itself,
  where there is no client user-agent to pass through: usage polling
  (`packages/providers/src/usage-fetcher.ts`), the Anthropic profile fetch
  (`packages/providers/src/providers/anthropic/profile.ts`), and the auto-refresh
  keepalive (`packages/proxy/src/auto-refresh-scheduler.ts`), which reaches it
  only through `getClientVersion()`'s fallback and so sends it just until the
  first inbound client request is tracked. Hand-maintained: nothing automates it,
  so refresh it yourself from `claude --version`.
- **The app version** — the `"version"` field in the **root `package.json`**.
  Single source of truth (dashboard badge and startup log both read it).
  CalVer `YYYY.M.N`.

Bump the app version when landing a notable change into `main` — a fix, feature,
or anything user-visible, but not pure docs/comment tweaks. Same month → bump the
third segment (`2026.7.0` → `2026.7.1`); first release of a new month → roll the
month and reset (`2026.8.0`).

The string is purely a human-readable label — nothing parses it as semver. The
dashboard's "is my deploy current?" check is commit-SHA based via
`/api/version/check`. The app version resolves from the root `package.json` at
runtime.

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

## Merging inbound PRs from external contributors

Contributions come in under MIT (`CONTRIBUTING.md`, restated in the PR
template), so ClankerMux keeps the option of shipping under terms other than
AGPL later. Before merging, check that the PR body still carries the template's
MIT statement and that the contributor hasn't objected to it in the thread. If
either fails, don't merge: ask the user. Without those terms the contribution
comes in under AGPL only, and relicensing would need that contributor's
permission.

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

- Never `git push --force` (or `--force-with-lease`) to `origin/main` without
  explicit user confirmation for that specific operation.
- If `git push origin main` fails with `src refspec main matches more than one`
  (branch/tag name collision), push explicitly:
  `git push origin refs/heads/main:refs/heads/main`.
