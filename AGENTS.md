# wowget

A CLI and terminal UI that installs, lists and updates World of Warcraft addons from a
declarative manifest. Bun and TypeScript, compiled to one binary per platform.

This file is the instructions for every coding agent working here. `CLAUDE.md` imports it and
adds only Claude Code specifics.

## Read when the task calls for it

Don't load these into every prompt; read the one for the area you change.

- `README.md`: what users see: commands, manifest format, install.
- `docs/PLAN.md`: the roadmap, the early product decisions and the reasons behind them.
- `docs/SPEC-*.md`: one spec per feature (MVP, targets and Windows, search, registry
  suggestions, TUI). A change follows the spec of the area it touches. A change in behaviour
  updates that spec in the same pull request.

## Commands

```
bun install              dependencies; run it first in every new checkout or worktree
bun test                 all tests
bun run typecheck        tsc --noEmit over src, test and scripts
bun run build            compile dist/wowget for this machine
bun run build:release    cross-compile every shipped binary (what CI runs)
bun run registry:check   check registry/addons.toml against the live sources
bun scripts/pr-reviews.ts   Codex review status and unresolved review threads (see Pull requests)
```

Bun only, never npm, npx, pnpm, yarn or node. CI pins Bun 1.4.4; use the same version.

CI (`.github/workflows/ci.yml`) runs typecheck, tests and `build:release` on Linux, the tests on
Windows, and the cross-compiled Windows binary. It does not run for pull requests that only
change Markdown, `docs/` or `LICENSE`. `pr-title.yml` lints every PR title.

## Layout

```
src/cli.ts     argument parsing, output and exit codes; loads the TUI with a dynamic import()
src/core/      operations (ops.ts), sources, search, installer, state (bun:sqlite), paths,
               flavor and TOC handling. Returns result objects and events; no console I/O.
src/tui/       the terminal UI (OpenTUI). Imports only from src/core.
scripts/       release, registry and maintenance scripts that CI and contributors run
registry/      addons.toml, the curated registry that search and bare-name add read
test/          bun tests; helpers/tmp.ts for temp directories, helpers/fetch.ts for a fake fetch
```

## Rules

- Tests never touch the real manifest, state, cache or AddOns folders. Use `useTempDirs()` and
  pass paths and `env` explicitly. Tests never hit the network: use `fakeFetch`. Live tests
  run only with `WOWGET_LIVE_TESTS=1`.
- Windows is a supported platform. Use `node:path`, expect files to be locked while the game
  runs, and mark POSIX-only tests with `test.skipIf(process.platform === "win32")`.
- Manifest, state and registry formats are read by binaries already installed on users'
  machines. Keep changes backwards compatible, or stop and ask.
- Every dependency ends up inside a cross-compiled binary. A native dependency needs its
  package for every target embedded by `build:release`, as OpenTUI has.
- Comments only for non-obvious logic, self-contained: no issue numbers, plan references or
  mentions of the work session.
- Only change tests for code the branch changes.

## Commits, releases and pull requests

- Conventional Commits. Pull requests are squash-merged, so the PR title (or the single
  commit's header) becomes the commit on `main`. `release-on-merge.yml` releases on every
  push to `main` that contains `feat`, `fix` or `perf` (`!` or `BREAKING CHANGE` for a
  major). Choose the type for what users get: `docs`, `ci`, `build`, `chore`, `refactor` and
  `test` ship nothing.
- One logical change per pull request, on a branch cut from an up-to-date `origin/main`.
- Description: short bullets of what changed and why, then `Decisions:` with the
  implementation decisions a reviewer could question. No test plan section.
- **This repository is public.** Commits, PR descriptions and comments are public: no local
  paths, no names of private repositories or machines, no secrets, no personal data.

## Worktrees

- The main checkout stays on `main`. Work happens in one worktree per branch, inside the
  repository under `.claude/worktrees/<name>` (ignored by git), or wherever your agent creates
  its own worktrees. Never in temporary or scratch directories, which get cleaned up from under
  you.
- Run `bun install` in a new worktree before anything else. Without its own `node_modules`, a
  worktree inside the repository resolves packages from the main checkout's, which differ
  whenever the branch changes dependencies.
- Worktrees run tests and typecheck in parallel safely: tests use their own temp directories,
  and neither `bun test` nor `tsconfig.json` reaches into `.claude/`.
- Remove the worktree once its pull request is merged (`git worktree remove <path>`).

## Working agreement

**Allowed without asking:** create branches, commit, push branches you created (rebase and
`--force-with-lease` on them are fine), open and update pull requests, reply to and resolve
review threads on pull requests you opened, request a Codex review, and make implementation
decisions inside the spec. List those decisions in the PR description.

**Stop and ask, without proceeding, for:**

- contradicting a spec or `docs/PLAN.md`, or an incompatible change to the manifest, state or
  registry formats;
- a new dependency, and any native one;
- anything outside this repository;
- repository settings, secrets and Actions permissions on GitHub;
- irreversible actions: merging a pull request (never run `gh pr merge`), pushing to `main`,
  force-pushing a branch you did not create, deleting branches or tags, creating tags or
  releases by hand.

## Pull requests and the Codex review

Codex reviews every pull request automatically. The loop for each one:

1. Implement, with tests for the obvious cases.
2. `bun run typecheck` and `bun test` pass. Run `bun run build:release` too when the change
   touches the build, dependencies or how the TUI loads.
3. Review your own diff against the spec and the rules above. For a large change, also hand
   the diff, the spec section and these rules to a reviewer with a fresh context (a subagent or
   a new session that only reads), without your own conclusions, and handle its findings.
4. Commit, push, and open the pull request **ready for review**, not as a draft: Codex starts
   when a PR is opened or marked ready, not on later pushes.
5. Handle the Codex review with the `pr-feedback` skill (`.agents/skills/pr-feedback/SKILL.md`):
   wait for it with `bun scripts/pr-reviews.ts wait <pr>`, verify each finding against the code,
   fix the valid ones in this PR, answer the rest with a reason, resolve the threads, then
   comment `@codex review` once to have the fixes reviewed. Handle what that second review
   finds the same way, then report; never request a third review.
6. CI is green (`gh pr checks <pr> --watch`).
7. Report: what changed, the check output, the decisions, and every review finding with how it
   was handled.

## Completion

A change is done when typecheck and tests pass and you have seen the output, not when it looks
right. Report the summary lines, not a statement that they passed. Expected skips are the live
test (without `WOWGET_LIVE_TESTS=1`) and the POSIX-only tests on Windows; any other skip is a
finding. A pull request is done when CI is green and the Codex review is handled. Say when a
check failed, was skipped or was not run.
