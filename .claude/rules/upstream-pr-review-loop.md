# Upstream PR Review Loop Rule

## When this rule applies

Any time an upstream PR has been opened against `tombii/better-ccflare` and Greptile is expected to review it (or has already started). This is the standard post-PR workflow — every recent fork PR (#210, #213, #215, #216, #217, #218, #219, #221, #226, #227, #228, #229, #230, #231, #234, ...) has gone through it.

Pairs with `fork-workflow.md` (Procedure A produces the upstream PR; this rule handles what happens *after* the PR is open).

## The loop

Once a fork PR is open upstream:

1. **Wait for Greptile.** Typical lag: 7–15 min after the PR opens or after each new push. Sometimes longer if the `review-labeled-synchronize` Action skips (which it often does — that's normal, Greptile still re-reviews on its own cadence).
2. **Read Greptile's state.** Greptile updates **in place** — there's one issue comment that holds the summary, plus inline review-thread comments. See "How to detect Greptile state" below for the right signals.
3. **If outstanding findings exist** (Prompt-to-Fix section present, or any review thread not `isResolved + isOutdated`):
   - Enter the existing worktree (or create one if you didn't).
   - Fix each finding with minimal scope. Add a regression test when the finding maps to one.
   - Run `bun run lint && bun run typecheck && bun run format && bun test packages/<the package you touched>/`.
   - Commit with subject `fix: <subject> (Greptile #<PR> round <N>)`.
   - Push to `origin/fix/<branch>`.
   - **Cherry-pick** the new SHA onto local main (NOT `git merge --no-ff`). Local main has fork-only divergence; merging silently reverts files. See `feedback_procedure_c4_with_rebased_branch` memory.
   - Push origin main.
   - Wait another ~7–15 min for Greptile to re-review.
4. **Repeat** until all signals are clean (see "Stop conditions" below).
5. **Restart the systemd service** so the live deployment runs the fix: `sudo systemctl restart better-ccflare.service` (per `CLAUDE.md`, the service rebuilds the dashboard and runs from the working-tree TypeScript on every restart). Run `sudo systemctl daemon-reload` first if a previous session set transient drop-ins via `systemctl set-property` — that produces a "unit file changed on disk" warning that clears once you reload.
6. **Update memory.** Edit the per-PR `project_pr_<name>.md` memory file with final SHAs, round count, and the deployment timestamp. Update `MEMORY.md` index entry.
7. **Clean up.** `git worktree remove --force .claude/worktrees/<name>` (the `--force` is fine for the orphan `bun.lock` change). Keep the branch — it's the open PR's head.

## How to detect Greptile state

Greptile's signals are **not** in the obvious places. Trust these, in order:

| Signal | API call | Meaning |
|--------|----------|---------|
| Summary `updated_at` | `gh api repos/tombii/better-ccflare/issues/<PR>/comments \| jq '.[0].updated_at'` | Greptile edits its single summary comment in place. If `updated_at` is newer than your last push, it has re-reviewed. |
| Last reviewed commit | `grep -oE 'Last reviewed commit:.*commit/[a-f0-9]+' <summary-body>` | The SHA at the bottom of the summary. Match against PR head; if equal, Greptile saw your latest push. |
| Confidence score | `grep -oE 'Confidence Score: [0-9]/5' <summary-body>` | 5/5 is the bar. |
| Outstanding findings | Search for `Prompt To Fix All With AI` in the summary body | If the section is **absent**, no outstanding findings. If present, parse the issue list. |
| Inline thread resolution | `gh api graphql` → `pullRequest(number).reviewThreads.nodes` → `isResolved && isOutdated && resolvedBy.login == "greptile-apps[bot]"` | All threads in this state means Greptile self-marked the fixes as landed. |
| "Safe to merge." sentence | `grep "Safe to merge" <summary-body>` | Explicit approval phrase. |

**What is NOT a signal:**

- `:+1:` / thumbs-up emoji reaction on the summary. **Greptile on this repo does not post one** — checking `comment.reactions.total_count` will always show 0 and is not a stop condition.
- The PR reviews API (`gh pr view <n> --json reviews`) only shows the original `COMMENTED` review at PR-open time. Subsequent re-reviews are summary edits, not new review records.
- The `review-labeled-synchronize` GH Action check being `SKIPPED`. That workflow is unrelated to whether Greptile will re-review.

## Stop conditions (all must be true)

1. Confidence Score: **5/5**.
2. `Prompt To Fix All With AI` section **absent** from the summary body.
3. All inline review threads `isResolved && isOutdated`, `resolvedBy == "greptile-apps[bot]"`.
4. "Safe to merge." appears in the summary body.
5. Summary's "Last reviewed commit" SHA matches PR head SHA.

When all five hold: stop, restart service, update memory, remove worktree.

## Cadence for the monitoring loop

When `/loop` is used to babysit this (the recommended approach for unattended monitoring):

- **Just pushed a fix**: wake every **270 s** (cache-warm) for the first ~15 min after push.
- **Waiting on initial review or idle**: wake every **1200–1800 s** (past the cache window anyway).
- **5/5 reached but findings still listed**: wake every **270 s** until they clear (Greptile sometimes lags clearing the section by one cycle).
- **Stop condition met**: omit `ScheduleWakeup`. The loop ends.

## Hard constraints

- **NEVER** merge the fix branch into local main with `git merge --no-ff`. Always cherry-pick. The fork-only divergence pattern (`feedback_procedure_c4_with_rebased_branch`) means a merge will silently revert files.
- **NEVER** push --force to `origin/main`. Cherry-picks add new commits, never rewrite.
- **ALWAYS** run `bun run lint && bun run typecheck && bun run format` before each commit, even for one-line Greptile fixes.
- **ALWAYS** add a regression test when the Greptile finding describes a behavior (race, missing accounting, wrong invariant). Counters-only fixes don't need one.
- **NEVER** modify `packages/proxy/src/inline-worker.ts` or other inlined autogen files (per `CLAUDE.md`).
- Treat <5/5 OR any outstanding finding as a blocker — even if you privately disagree, per `feedback_address_greptile_findings` memory ("we take them in any case").
- If Greptile flags something you genuinely think is wrong: push the fix anyway and add a comment on the PR explaining your reasoning. Do not skip the fix.

## Why a rule and not just memory

Memory entries like `feedback_address_greptile_findings` capture the "always fix" principle. This rule encodes the **mechanics** of the loop — the API calls, the signals to read, the cadence, the cherry-pick vs. merge decision — which are easy to get wrong (you can read a stale `updated_at`, miss `isResolved`, fall for the no-thumbs-up trap, or accidentally `--no-ff` and silently revert work). The rule keeps that procedural knowledge in one place that's loaded into every session.

## Related references

- `CLAUDE.md` — base repo rules, lint/typecheck/format, the systemd live-deployment fact.
- `.claude/rules/fork-workflow.md` — Procedure A produces the PR this rule monitors.
- `.claude/rules/main-checkout-safety.md` — why the cherry-pick happens in the worktree first, then in the main checkout.
- Memory `feedback_procedure_c4_with_rebased_branch` — the cherry-pick-not-merge rule.
- Memory `feedback_address_greptile_findings` — "take all findings, even <5/5".
- Any recent `project_pr_*.md` memory — concrete examples of round-by-round Greptile loops.
