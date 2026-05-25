# `.claude/rules/`

Project-specific rules Claude follows when working in this repo. Each file describes a workflow or constraint that's too detailed to put inline in `CLAUDE.md`. `CLAUDE.md` itself contains short pointers to the rules in this directory.

| Rule | When it applies |
|------|-----------------|
| [`main-checkout-safety.md`](main-checkout-safety.md) | **Always.** Forbids destructive git operations (`checkout`, `switch`, `reset --hard`, `restore`, `clean`, `stash`, etc.) inside `/home/darken/better-ccflare` because that directory is the live systemd deployment (`clankermux.service`). Use worktrees instead. |
| [`fork-workflow.md`](fork-workflow.md) | Any bug fix or change to ClankerMux. ClankerMux is now its own project: branch from `origin/main`, merge back with `--no-ff`, no upstream PRs. The `tombii/better-ccflare` upstream remote is fetch-only and pulled from via occasional cherry-pick (never merge/re-baseline). |
