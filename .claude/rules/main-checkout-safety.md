# Main Checkout Safety Rule

## When this rule applies

**Always.** Any time you're working in this repo, regardless of task, lane, or branch.

This rule is in addition to (not a replacement for) `.claude/rules/fork-workflow.md` and `CLAUDE.md`.

## Why this rule exists

The main checkout at `/home/darken/better-ccflare` is the **live deployment**. The systemd unit `clankermux.service` (defined at `/etc/systemd/system/clankermux.service` with drop-in `dashboard-build.conf`) runs the proxy from this directory:

- `WorkingDirectory=/home/darken/better-ccflare`
- `ExecStartPre=bun run build:dashboard` — rebuilds the dashboard from working-tree source on every restart
- `ExecStart=bun run apps/server/src/server.ts` — runs the server directly from working-tree TypeScript

**Whatever branch is checked out and whatever working-tree state exists at the moment of the next service start (manual restart, crash-recovery, or reboot) is what gets deployed.** There is no separate build artifact, no staging directory, no deploy pipeline between the working tree and production.

Past incident: an agent ran `git checkout upstream/main` (or equivalent) in this directory while the user had uncommitted feature work. On the next reboot, systemd rebuilt the dashboard from upstream's source and deployed the upstream version. The user's working-tree edits were not in the deployed bundle and the user observed "the original version" in the dashboard.

## Hard rule

The following commands are **FORBIDDEN inside `/home/darken/better-ccflare`** (the main checkout). They are **allowed inside `/home/darken/better-ccflare/.claude/worktrees/<name>/`** (worktrees).

| Forbidden command | Reason |
|-------------------|--------|
| `git checkout <branch>` | Moves HEAD; the next service restart deploys `<branch>`. |
| `git checkout <ref>` (any ref that isn't current HEAD) | Same — moves HEAD. |
| `git switch <branch>` | Same as `git checkout <branch>`. |
| `git reset --hard` | Discards working-tree edits the user is iterating on. |
| `git reset --merge`, `git reset --keep` | Same — touches the working tree. |
| `git restore .` / `git restore <path>` | Discards working-tree edits at that path. |
| `git checkout .` / `git checkout -- <path>` | Same — discards edits. |
| `git clean -fd` / `git clean -fx` | Deletes untracked files (often the user's WIP additions). |
| `git stash` / `git stash push` | Moves work off the tree where it can be forgotten. |
| `git rebase`, `git rebase -i` | Rewrites history and re-applies commits to the working tree. |
| `git merge <branch>` (without explicit user approval) | Can introduce conflicts that mangle working-tree files. |
| `git revert` (without explicit user approval) | Changes the working tree. |
| `gh pr checkout <n>` | Checks out the PR's branch, moving HEAD. |

**Allowed in the main checkout** (these are safe — they don't touch the working tree or HEAD without intent):

- Read-only inspection: `git status`, `git log`, `git diff`, `git show`, `git branch`, `git ls-files`, `git ls-tree`, `git rev-parse`, `git reflog`, `git blame`
- Fetch: `git fetch`, `git fetch upstream`, `git fetch origin` (updates refs only, never the working tree)
- Add/commit on the *current* branch: `git add <specific-files>`, `git commit` (per CLAUDE.md: never `git add .`)
- Pull on the current branch, **only when the user explicitly asks**: `git pull --ff-only` (refuses if a non-fast-forward would touch the working tree)

## What to do instead

### To switch branches, review another branch, or work on a different feature

Use a worktree. They live under `.claude/worktrees/<name>/` and are completely isolated from the live deployment.

```bash
# Create a worktree off origin/main (default) on a new branch
# In Claude Code, prefer the EnterWorktree tool, which handles cleanup automatically:
#   EnterWorktree(name="fork-<short-slug>")
#
# Or, outside the agent:
git worktree add .claude/worktrees/<name> -b <new-branch> origin/main
cd .claude/worktrees/<name>
```

For checking out an existing PR or branch:

```bash
git worktree add .claude/worktrees/pr-<num> -b pr-<num> origin/pr/<num>
# or
git fetch origin pull/<num>/head:pr-<num>
git worktree add .claude/worktrees/pr-<num> pr-<num>
```

### To read another branch's content without checking it out

All non-destructive — never moves HEAD, never touches the working tree:

```bash
git show <ref>:<path>             # print a file from another branch
git diff <ref> -- <path>          # diff against another branch
git diff <ref>...HEAD             # everything you have that <ref> doesn't
git ls-tree -r <ref> -- <path>    # list files at a path in another branch
git log <ref> -- <path>           # history of a path on another branch
```

### To compare against `main` without leaving the current branch

```bash
git fetch origin
git diff origin/main...HEAD                       # your branch's diff
git log origin/main..HEAD --oneline               # commits you have that main doesn't
git log HEAD..origin/main --oneline               # commits main has that you don't
```

## Recovery procedure: if you discover the main checkout is on the wrong branch with missing WIP

**STOP. Do not run any git commands. Tell the user immediately.** Their uncommitted work may still be recoverable, but a wrong move erases it.

Possible recovery locations the user (not you) should check:

1. **Reflog**: `git reflog` shows the previous HEAD. If a `checkout: moving from <old> to <new>` entry exists, `git checkout <old>` may restore the prior state — **but only if the working tree wasn't touched after**. Confirm with `git stash list` and look at the working tree first.
2. **Untracked files**: a `git checkout` between two branches that don't conflict on untracked files leaves untracked files in place. They may still be there: `git status --porcelain | grep '^??'`.
3. **Stash**: `git stash list`, `git stash show -p stash@{0}` — in case someone stashed before switching.
4. **Filesystem timestamps**: `find . -name '*.tsx' -newer <reference-file>` can locate edits that weren't committed.

After the user has assessed the state and decided on a recovery path, only then run git commands — and only the ones the user explicitly approves.

## Why hooks could complement this rule

A future hardening step is a `PreToolUse` hook in `.claude/settings.json` that intercepts the forbidden commands when the agent's CWD is the main checkout, and rejects them with a pointer to this rule. The hook is enforced by the harness; this rule is enforced by reading. Both layers are useful — a rule explains the *why*, a hook prevents the slip.

## Related references

- `CLAUDE.md` — general repo rules, file exclusions, commit prefixes, the lint/typecheck/format requirement
- `.claude/rules/fork-workflow.md` — ClankerMux dev workflow (fork-only, branch from origin/main), `--no-ff` merge pattern, cherry-pick-from-upstream
- `/etc/systemd/system/clankermux.service` — the systemd unit that makes this directory live
- `/etc/systemd/system/clankermux.service.d/dashboard-build.conf` — the drop-in that adds the `ExecStartPre` dashboard rebuild
