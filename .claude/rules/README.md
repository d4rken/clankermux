# `.claude/rules/`

Project-specific rules Claude follows when working in this repo. Each file describes a workflow or constraint that's too detailed to put inline in `CLAUDE.md`. `CLAUDE.md` itself contains short pointers to the rules in this directory.

| Rule | When it applies |
|------|-----------------|
| [`main-checkout-safety.md`](main-checkout-safety.md) | **Always.** Forbids destructive git operations (`checkout`, `switch`, `reset --hard`, `restore`, `clean`, `stash`, etc.) inside `/home/darken/better-ccflare` because that directory is the live systemd deployment. Use worktrees instead. |
| [`fork-workflow.md`](fork-workflow.md) | Any bug fix or change to fork code, with optional upstream PR to `tombii/better-ccflare`. Covers branch conventions, the `--no-ff` merge pattern, and post-upstream-merge reconciliation. |
| [`upstream-pr-review-loop.md`](upstream-pr-review-loop.md) | After any upstream PR is opened — Greptile review loop, stop conditions, cherry-pick-vs-merge for fork-only divergence, service redeploy. Pairs with `fork-workflow.md`. |
