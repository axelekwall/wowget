@AGENTS.md

# Claude Code

- Skills live in `.agents/skills/`, which Codex reads. `.claude/skills/` links to them, so the
  same `pr-feedback` skill is available here.
- Prefer Claude Code's native worktrees under `.claude/worktrees/`. Run `bun install` in each
  before anything else (see Worktrees in `AGENTS.md`).
- Run `bun scripts/pr-reviews.ts wait <pr>` in the background; it can take longer than a
  foreground command's timeout, and you are notified when it exits. Don't poll with sleeps.
- The fresh-context review in `AGENTS.md` is a subagent started with the Agent tool. Give it the
  diff, the spec section and the rules, not your conclusions, and tell it to only read.
