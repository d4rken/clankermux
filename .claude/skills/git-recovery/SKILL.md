---
name: git-recovery
description: Recovering uncommitted work in the live ClankerMux checkout, and the worktree recipes for reading or checking out another branch. Read this if the main checkout is on an unexpected branch, if WIP appears missing, or when you need to inspect another branch without moving HEAD.
---

# Git recovery and worktree recipes

The live checkout at `/home/darken/clankermux` is the systemd deployment —
whatever branch and working-tree state exists at the next service start is what
gets deployed. The forbidden-command list lives in `CLAUDE.md`; this file covers
what to do instead, and what to do when it's already gone wrong.

## If the main checkout is on the wrong branch with missing WIP

**STOP. Do not run any git commands. Tell the user immediately.** Their
uncommitted work may still be recoverable, but a wrong move erases it.

Possible recovery locations the **user** (not you) should check:

1. **Reflog**: `git reflog` shows the previous HEAD. If a `checkout: moving from
   <old> to <new>` entry exists, `git checkout <old>` may restore the prior state
   — but only if the working tree wasn't touched after. Confirm with
   `git stash list` and look at the working tree first.
2. **Untracked files**: a `git checkout` between two branches that don't conflict
   on untracked files leaves untracked files in place. They may still be there:
   `git status --porcelain | grep '^??'`.
3. **Stash**: `git stash list`, `git stash show -p stash@{0}` — in case someone
   stashed before switching.
4. **Filesystem timestamps**: `find . -name '*.tsx' -newer <reference-file>` can
   locate edits that weren't committed.

After the user has assessed the state and decided on a recovery path, only then
run git commands — and only the ones the user explicitly approves.

## Past incident

An agent ran `git checkout upstream/main` (or equivalent) in this directory while
the user had uncommitted feature work. On the next reboot, systemd rebuilt the
dashboard from upstream's source and deployed the upstream version. The user's
working-tree edits were not in the deployed bundle and the user observed "the
original version" in the dashboard.

## Worktree recipes

Worktrees live under `.claude/worktrees/<name>/` and are completely isolated from
the live deployment. Every command forbidden in the live checkout is fine inside
one.

```bash
# New branch off origin/main — prefer EnterWorktree in Claude Code, which
# handles cleanup automatically:  EnterWorktree(name="<short-slug>")
git worktree add .claude/worktrees/<name> -b <new-branch> origin/main

# Existing PR or branch
git worktree add .claude/worktrees/pr-<num> -b pr-<num> origin/pr/<num>
# or
git fetch origin pull/<num>/head:pr-<num>
git worktree add .claude/worktrees/pr-<num> pr-<num>
```

If local `main` has commits not yet on `origin/main`, base the worktree on
`refs/heads/main` rather than `origin/main` and enter it by path.

## Reading another branch without checking it out

All non-destructive — never moves HEAD, never touches the working tree:

```bash
git show <ref>:<path>             # print a file from another branch
git diff <ref> -- <path>          # diff against another branch
git diff <ref>...HEAD             # everything you have that <ref> doesn't
git ls-tree -r <ref> -- <path>    # list files at a path in another branch
git log <ref> -- <path>           # history of a path on another branch
```

## Comparing against main without leaving the current branch

```bash
git fetch origin
git diff origin/main...HEAD                       # your branch's diff
git log origin/main..HEAD --oneline               # commits you have that main doesn't
git log HEAD..origin/main --oneline               # commits main has that you don't
```

## A hook would complement the rule

A `PreToolUse` hook in `.claude/settings.json` could intercept the forbidden
commands when the agent's CWD is the main checkout and reject them with a pointer
to the rule. The hook is enforced by the harness; the rule is enforced by
reading. Both layers are useful — a rule explains the *why*, a hook prevents the
slip. Not currently implemented.

## Related

- `/etc/systemd/system/clankermux.service` — the unit that makes the checkout live
- `/etc/systemd/system/clankermux.service.d/dashboard-build.conf` — the drop-in
  adding the `ExecStartPre` dashboard rebuild and `build:db-workers` regeneration
