# ClankerMux Development Workflow Rule

## When this rule applies

Any time you're fixing a bug, adding a feature, or making any change to the code
in this repo. The repo (`d4rken/better-ccflare` on GitHub) began as a fork of
`tombii/better-ccflare`, but it has diverged far enough — and intentionally
removed things upstream won't take — that **ClankerMux is now its own project**.
Treat it as such.

This rule decides:
- Which branch to base new work on (answer: `origin/main`, always)
- How to merge work back into `main` so it's usable immediately
- How (rarely) to pull a specific fix from upstream without re-adding removed code

This rule is in addition to (not a replacement for) `CLAUDE.md` and
`.claude/rules/main-checkout-safety.md`. Lint/typecheck/format, the autogen-file
exclusions, the "never bump version manually" rule, and all other repo rules
still apply.

## The one lane: fork-only

ClankerMux no longer maintains an "upstream-bound" lane. We do **not** open PRs
against `tombii/better-ccflare`. Every change is fork-only.

| Aspect | Value |
|--------|-------|
| Branch prefix | `fix/*`, `feat/*`, or `fork/*` (any is fine; they're all fork-only now) |
| Base branch | `origin/main` (the ClankerMux main) — **never** `upstream/main` |
| PR upstream? | **No.** Never. |
| Merge style | `--no-ff` into `main` (the merge commit is the undo handle) |

## Procedure — make a change

Run these in order. Substitute `<name>` with a kebab-case short identifier.

```bash
# 1. Start from ClankerMux main
git checkout main
git pull --ff-only
git checkout -b fix/<name>

# 2. Code the fix and tests. Follow TDD per CLAUDE.md.

# 3. Verify (mandatory, per CLAUDE.md "After Code Changes")
bun run lint && bun run typecheck && bun run format

# 4. Commit using a recognized prefix
#    (fix:|bug:|resolve:|feat:|add:|new:|security:|...|improve:|enhance:|update:|refactor:)
git add <specific files>            # never `git add .`
git commit -m "fix: <subject>"

# 5. (Optional) push the branch for backup
git push -u origin fix/<name>

# 6. Merge into main with --no-ff and push
git checkout main
git merge --no-ff fix/<name> -m "Merge fix/<name>"
git push origin main
```

> **Reminder (main-checkout-safety):** the branch-creating steps that move HEAD
> (`git checkout -b`, `git switch`) are forbidden *inside the live checkout*
> `/home/darken/clankermux` — do that work in a worktree. The final
> `git merge --no-ff <branch>` into `main` **is allowed** in the live checkout,
> since it advances `main` in place rather than switching HEAD; just confirm the
> working tree is clean first and `git merge --abort` if it conflicts. See
> `main-checkout-safety.md`.

After the merge, the change is in `main` and immediately usable — the systemd
service rebuilds from the working tree on the next restart.

### Clean up the worktree after a confirmed merge

Once the user has confirmed they're happy with the change **and** it has been
merged into `main`, **automatically clean up the worktree** the work was done in
— don't leave it lying around or wait to be asked.

- In Claude Code, the work was done in an `EnterWorktree` worktree: call
  `ExitWorktree(action: "remove")` after the merge is pushed. (It refuses to
  remove a worktree with uncommitted files or unmerged commits — if it does,
  surface that to the user rather than forcing it.)
- Outside the agent / for a manually-created worktree:
  `git worktree remove .claude/worktrees/<name>` then delete the merged topic
  branch (`git branch -d <name>`).

Only skip cleanup if the user explicitly says they want to keep iterating in the
worktree. "Merge it into main" with no other caveat means: merge, push, then
remove the worktree.

## The `upstream` remote: fetch-only, cherry-pick-only

The `upstream` remote (`tombii/better-ccflare`) is kept for **fetch only**; its
push URL is disabled (`git remote set-url --push upstream DISABLED`). We keep it
so we can occasionally pull a *specific* upstream fix.

**Pulling from upstream is rare and opportunistic, and is always a cherry-pick
of specific commits — never a merge or a re-baseline.** See the
`project_rebaseline_strategy` memory for the full rationale; the short version:

- ClankerMux **intentionally and permanently removes** code upstream keeps
  (e.g. Vertex/Bedrock and other unused providers are slated for removal). This
  is a Type-D divergence upstream will never accept.
- A `git merge upstream/main` or a re-baseline-onto-upstream **re-adds that
  removed code every time**, silently undoing fork-only decisions. Don't do it.

```bash
# Pull one specific upstream fix:
git fetch upstream
git log upstream/main --oneline           # find the commit you want
git checkout -b pull/<short-desc> origin/main
git cherry-pick <upstream-sha>             # resolve conflicts; drop re-added removals
bun run lint && bun run typecheck && bun run format
git commit                                  # if cherry-pick paused for conflicts
git checkout main && git merge --no-ff pull/<short-desc> -m "Cherry-pick upstream <sha>: <desc>"
git push origin main
```

If a cherry-pick drags in code we deliberately removed, **edit it out as part of
the cherry-pick** — the goal is the fix, not upstream's tree.

## Hard constraints

- **NEVER** branch off `upstream/main`. Always off `origin/main`.
- **NEVER** open a PR against `tombii/better-ccflare`.
- **NEVER** `git merge upstream/main` or re-baseline onto upstream — it re-adds
  intentionally-removed code. Cherry-pick specific commits instead.
- **ALWAYS** use `--no-ff` when merging a topic branch into `main`.
- **NEVER** `git push --force` (or `--force-with-lease`) to `origin/main` without
  explicit user confirmation for that specific operation.
- **NEVER** bump the version manually (per `CLAUDE.md`).
- **ALWAYS** run `bun run lint && bun run typecheck && bun run format` before merging.
- **NEVER** include the autogen inline files in commits (per `CLAUDE.md`).
- **ALWAYS** use `git add <specific files>` rather than `git add .` (per `CLAUDE.md`).

## Quick decision tree

```
New change requested
└── Branch fix/<name> from origin/main → code+test → verify → --no-ff merge to main → push.
    (No upstream PR. Ever.)

Want a specific upstream fix?
└── git fetch upstream → cherry-pick the commit onto a branch off origin/main →
    drop any re-added removed code → --no-ff merge to main. Never merge/re-baseline upstream.
```

## Related references

- `CLAUDE.md` — general repo rules, lint/typecheck/format, file exclusions, commit prefixes.
- `.claude/rules/main-checkout-safety.md` — why branch/merge happens in a worktree, not the live checkout.
- Memory `project_rebaseline_strategy` — the cherry-pick-not-re-baseline decision and why (permanent provider removal).
