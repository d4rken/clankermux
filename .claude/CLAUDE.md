# CLAUDE.md

ClankerMux (slug `clankermux`) — a multiplexing load-balancer proxy that fans
requests across multiple backend accounts/providers (Anthropic, Codex/OpenAI, and
others) through one front door to avoid rate limiting.

## Never curl the Anthropic endpoint

Not directly, and not via the proxy using the `claude` account. Real Anthropic
accounts can get banned for automated/scripted usage — the `claude` account is
only ever exercised through real Claude Code. To test, use a non-Anthropic
account (ollama, litellm, omniroute, …) and force-route with
`x-clankermux-account-id`. See the `running-clankermux` skill.

One sanctioned exception, approved 2026-08-25: the server's own
`GET api.anthropic.com/v1/models` metadata read
(`AnthropicModelCatalogCache`). It costs no tokens and starts no quota
window. Since the shared-catalogue page was removed it is demand-driven
and reached only by the one-shot `client_profiles` backfill, so on a
database created after 2026.9.52 it never runs at all.

A second one, approved 2026-09-22: Claude Code's banked resets
(`cedar_ember`), reached only through `AnthropicBankedResetCoordinator`.
That covers the status read
`GET api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1` and the
claim `POST api.anthropic.com/api/organizations/<org>/reset_rate_limits`.
The claim spends a grant, so it fires only from a dashboard click or a
per-account auto-apply toggle that is off by default.

A third one, approved 2026-09-23: the Agent SDK bridge
(`packages/claude-sdk-bridge`). It runs real Claude Code (SDK 0.3.280, CLI
2.1.280, entrypoint `sdk-ts`, never spoofed) with no credential of its own.
Its model calls reach ClankerMux only through the bridge's private loopback
listener and then take the normal Anthropic pipeline on the accounts. It is
reached only by client turns that route to an official Anthropic account
under the deny floor (Responses and Chat on `/wire/openai`). Driving it by
script or by hand against a real account stays forbidden, the spike drivers
included. Its tests use fake accounts and a mock upstream inside a
loopback-only network namespace. See the `claude-sdk-bridge` skill.

Everything else stays forbidden, including curling any exception's
endpoints by hand.

## This directory builds the deployment; it is not the deployment

`clankermux.service` does **not** run from `/home/darken/clankermux`. The
`zz-release.conf` systemd drop-in pins `WorkingDirectory` to a release snapshot
under `.codex/worktrees/release-<sha>` (legacy snapshots remain under
`.cache/releases/<sha>`) — a detached worktree of one reviewed commit, with
its own `node_modules`, built dashboard and inline DB workers. An unfinished
working tree therefore cannot reach production through a crash restart, a
watchdog restart or a reboot.

**Merging into `main` deploys nothing.** It changes what will ship the next time
someone promotes, and nothing about what is running now. Promote explicitly:

```
scripts/promote-release.sh              # promote refs/heads/main
scripts/promote-release.sh <commit-ish> # promote (or roll back to) a specific commit
```

The script creates the snapshot, installs and runs the guarded builds inside it
while the old release keeps serving, rewrites the drop-in, reloads, restarts,
and then checks that the unit really restarted (a new systemd invocation id,
not just a reloaded config), that the serving process's own cwd is the new
snapshot, that it logged the version its own `package.json` declares, and that
it stayed `active`, on one invocation, answering 200 for a settle window rather
than only reaching readiness once. It prints the rollback command first and
records each release that passes verification in `.cache/releases/LAST_VERIFIED`,
so the way back is always a release that actually came up rather than whatever
the pin happens to name after a failure. A settle window is a sampled check,
not a guarantee: a service that dies minutes later still passes it. It never
deletes old
snapshots; prune them by hand with `git worktree remove .codex/worktrees/release-<sha>`
once you no longer want them as rollback targets. Keeping several is cheap:
bun hardlinks `node_modules` from its global cache, so five snapshots occupied
712 MB together on 2026-09-07 despite each measuring ~500 MB alone, and
removing one frees far less than its apparent size.

Worktrees named `.codex/worktrees/release-*` are production snapshots. Never
remove them during agent worktree cleanup; the active release and retained
rollback targets must remain available.

To check what is running, ask the serving process, not the repo and not the
unit config. `WorkingDirectory` is only the pin systemd would use at the next
start: install a new drop-in and reload, and it reports the new release while
the old one is still serving. The process's own cwd names the sha that is
actually answering requests:

```
readlink /proc/$(systemctl show clankermux -p MainPID --value)/cwd
systemctl show clankermux -p ActiveState -p WorkingDirectory -p InvocationID
journalctl -u clankermux \
  --since "$(systemctl show clankermux -p ExecMainStartTimestamp --value)" \
  --no-pager | grep -F "ClankerMux Server v" | tail -1
```

Scope the journal to the current start. An unscoped `journalctl` happily prints
a banner from an earlier boot, so it can report a healthy version for a service
that is down right now. The banner names a version string in any case, and many
commits can share one; the path is what identifies a commit.

A version banner that lags the root `package.json` is not a bug — it is the pin
telling you which commit is serving traffic.

**Forbidden here** (all fine inside `.claude/worktrees/`):

```
git checkout <branch|ref>   git switch          git reset --hard|--merge|--keep
git restore [.|<path>]      git checkout .      git checkout -- <path>
git clean -fd|-fx           git stash [push]    git rebase [-i]
git revert (without explicit user approval)     gh pr checkout <n>
```

These stay forbidden even though production is now insulated from the working
tree. This is the one checkout that owns `main` and the git dir every worktree
and release snapshot hangs off: moving HEAD here breaks the merge-into-`main`
workflow, and the destructive commands can strand or delete other agents' WIP.

**Allowed here:** `status` `log` `diff` `show` `branch` `ls-files` `ls-tree`
`rev-parse` `reflog` `blame`; `fetch`; `add <specific-files>` and `commit` on the
current branch; `pull --ff-only` when the user asks; `worktree add|list|remove`;
and `merge --no-ff <branch>` into the currently-checked-out `main` — that
advances `main` in place rather than switching HEAD, and is how work lands.
Confirm the tree is clean first so a conflict can't leave markers behind;
`git merge --abort` if it conflicts and resolve on the branch instead.

To switch branches, review a PR, or work on a different feature: use a worktree
(`EnterWorktree`). To read another branch: `git show <ref>:<path>`,
`git diff <ref>` — those never touch HEAD.

**If WIP appears to be already missing: stop, run no git commands, tell the
user.** Recovery steps are in the `git-recovery` skill.

## Files never to touch

Every `inline-*-worker.ts` named by the worker manifest is gitignored and
regenerated by `bun run build:db-workers` (part of `bun run build`). Exclude
them from all reads, edits, searches, and commits. Read the manifest for the
current set rather than trusting a list written down elsewhere — an enumeration
here has gone stale twice. It currently spans `packages/database/src` and
`packages/http-api/src/handlers`.

Which workers exist is decided by **one** list,
`packages/database/scripts/workers-manifest.ts`. Everything that needs to know —
the real build, the CI placeholder step, and the systemd staleness guard in
`scripts/guarded-build.ts` — derives from it, and `workers-manifest.test.ts`
fails if a `*-worker.ts` source in any directory the manifest claims has no
entry. Adding a worker is a one-line edit there; never hand-maintain a second
copy of the list.

The analytics and quota-drift workers run from their inline blob whenever one
is present, and fall back to the on-disk source only when it is empty. So in a
checkout that has built them, editing anything in their bundle closure (the
`*-direct.ts` handlers, `quota-drift-compute.ts`, `@clankermux/core`,
`@clankermux/database`, …) changes nothing until `bun run build:db-workers`
runs again. `build:db-workers:guarded` hashes that whole closure, so it
rebuilds on its own.

Committed ambient `.d.ts` stubs satisfy `bun run typecheck` on a clean checkout,
so fresh worktrees need no hand-created placeholders. `bun test` is a different
story — it loads the real modules, not the stubs — so a fresh worktree must
first run either `bun run build:db-workers` (~5s, real bundles) or
`bun packages/database/scripts/build-workers.ts --placeholders-only` (instant,
empty stubs; what CI uses). Skip it and whole test files fail to load with
`Cannot find module './inline-<name>-worker'`, taking hundreds of tests that
never register at all with them. **A suite that is merely *smaller* than
expected is the tell** — this never reports a missing file, only fewer tests, so
compare the file and test counts, not just pass/fail. Never commit the generated
`.ts` files.

A **stale** blob looks nothing like a missing one. The suite is the normal size
and one test fails on its assertion, so it reads as a bug in the change rather
than a build artifact. Merging a branch that rebuilt its own workers does not
rebuild this checkout's: the blobs are gitignored, so they never travel with the
merge. A test can therefore pass on the branch, pass again when the merge is
verified there, and fail on `main` against source that is byte-identical. Run
`bun run build:db-workers` in the live checkout after merging anything inside a
worker's bundle closure, and treat "green on the branch" as saying nothing about
`main`. Production is insulated: the systemd unit runs
`build:db-workers:guarded` as an `ExecStartPre`, and that target hashes the
closure.

`packages/proxy/src/{inline-worker,embedded-tiktoken-wasm}.ts` are **retired** —
no longer generated or imported. Stale gitignored copies may linger in the live
checkout; they're dead weight. Don't hand-edit, commit, or recreate them.

`./README.md` (root) is the only user-facing README. The other seven —
`deploy/caddy`, `deploy/systemd`, `docs/client-api`, `docs/public-api`,
`docs/public-api/examples`,
`packages/providers/src/providers/anthropic-compatible` and
`packages/security` — document their own directory and nothing beyond it.

## What goes in `docs/`

Published reference material only: the public API contract
(`docs/public-api/`) and end-user product documentation. README media lives
in `.assets/`.

Implementation records, handovers between agents, backtest output and
investigation reports do **not** get committed there. A durable finding goes
to `.claude/CLAUDE.md` or a skill under `.claude/skills/`; everything else
stays out of the repository.

## Git refspecs

This repo has both a `main` **branch** and a `main` **tag**. Always use
`refs/heads/main`, never bare `main`, or commands fail with an ambiguous-refspec
error: `git log refs/heads/main`, `git diff refs/heads/main...`,
`git merge-base refs/heads/main`, `git push origin refs/heads/main:refs/heads/main`.

## Deploying from a worktree-isolated session

While the session is inside a worktree, Claude Code refuses every git command
that targets `/home/darken/clankermux`, reads included: `git -C … status` is
blocked exactly like `git merge`. The refusal is path-based (it also catches
`cd`, `env -C`, `--git-dir`, `GIT_DIR=`, globs and git behind `bash -c`) and has
no opt-out setting.

Leaving the worktree lifts it. Commit the work on the worktree branch, then call
`ExitWorktree` with `action: "keep"`: the session returns to
`/home/darken/clankermux`, the branch and the worktree stay on disk, and git
works normally again. This section is the project instruction that authorises
that exit, so do not stop to ask for it. Land the branch yourself, in two
stages.

Stage 1 needs no approval, because merging into `main` deploys nothing. Confirm
the checkout is on `main` and clean, then `git merge --no-ff worktree-<name>`,
`bun run build:db-workers` (those blobs are gitignored, so the merged tree needs
them rebuilt), `bun run lint && bun run typecheck`, then `bun run test`. Use
`bun run test`, not `bun test`: the former adds the `test:dom` lane. Report and
stop there.

Stage 2, only once the user has authorised it in this session:
`git push origin refs/heads/main:refs/heads/main`, then
`scripts/promote-release.sh`. Promotion restarts the live service, so it never
runs on your initiative.

If stage 1 turns up more work, `EnterWorktree` with `path` set to
`.claude/worktrees/<name>` puts you back on the same branch; fix it there,
commit, exit again and re-merge. Never re-point git at the checkout to get
around the refusal.

## Working in this repo

- Run `git status` before making changes, and note which files were already
  modified so you can tell your changes from the user's throughout the session.
- Stage with `git add <specific-files>`, never `git add .` — that picks up the
  gitignored autogen files.
- After code changes: `bun run lint && bun run typecheck` — in that order.
  `lint` is `biome check --write --unsafe`, which **rewrites files** (formatting,
  import sorting, and unsafe lint fixes), so typecheck has to run on the bytes it
  produced. Do not append `bun run format`: `biome check` already formats, so a
  trailing `biome format --write` reports "No fixes applied" and changes nothing.
  Use `bun run format` only on its own, never as the last link of the chain.
- New functionality: write the tests first, then implement, then run them.
- UI tests default to `renderToStaticMarkup`. A test that has to mount a
  component for real is named `*.dom-test.tsx` and lives next to the code it
  tests. Bun's default discovery skips those names — it only picks up
  `.test`/`_test_`/`.spec`/`_spec_` — so they run via `bun run test:dom`, which
  globs the lane files and starts a separate `bun test --preload …` process
  with their paths passed explicitly. Do not invoke one directly as
  `bun test <path>`: bun does run an explicitly named path, but that skips the
  preload, so the DOM is missing and portalled content renders empty. The
  separation is required twice over: happy-dom's globals are process-wide and
  replace `fetch`, `Request`, `Response` and friends, which must never happen
  to the proxy suite; and `@radix-ui/react-use-layout-effect` binds
  `globalThis.document` once per process, so anything portal-based renders
  empty unless the DOM exists before any test module loads.
- Prefer the clean, robust implementation over the minimal diff.
- Hand independent tasks to subagents rather than doing them sequentially in the
  main context — context isolation matters more than speed here.

