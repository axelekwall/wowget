---
name: pr-feedback
description: Wait for the Codex review on a wowget pull request, verify each finding against the code, fix the valid ones, answer the rest, resolve the threads and request a re-review until nothing is left. Use after opening or updating a pull request, or when asked to "check the review", "handle the Codex comments" or "address the feedback".
---

# Handle review feedback on a pull request

Codex reviews each pull request when it is opened or marked ready for review, and again when
someone comments `@codex review`. A push to an open pull request does not start a new review.
Findings arrive as inline review threads with a priority badge (P0 is the most severe). Codex
also keeps one summary comment naming the commit it reviewed. Only that comment shows a review
of the head commit; a 👍 reaction can be left over from an earlier commit.
Human reviewers' threads go through the same steps.

`bun scripts/pr-reviews.ts` does the GitHub side:

```
bun scripts/pr-reviews.ts wait <pr> [--timeout <minutes>]   wait for Codex on the head commit
bun scripts/pr-reviews.ts <pr> [--all] [--json]              status and unresolved threads
bun scripts/pr-reviews.ts reply <thread-id> <body…>          answer a thread
bun scripts/pr-reviews.ts resolve <thread-id>…               resolve threads
```

`wait` exits 0 when the head commit is reviewed with nothing unresolved, 1 when threads remain
(it lists them), and 2 when Codex commented instead of reviewing or has not reviewed the head
commit in time (20 minutes by default). A review usually takes a few minutes.

## 1. Wait for the review

Run `bun scripts/pr-reviews.ts wait <pr>`. On exit 0 there is nothing to do; go to step 6. On
exit 2, read what it printed:

- Codex commented instead of reviewing, for example asking for a Codex environment for the
  repository: that is a setting only the maintainer can change. Report it with the comment's
  link and stop; don't request another review.
- A draft: mark it ready for review (`gh pr ready <pr>`), then wait again.
- No sign of Codex at all: say so in your report instead of waiting longer.

## 2. Verify every finding

A finding is a claim, not an order. For each unresolved thread:

- Restate the claim in one line.
- Prove or disprove it in the code on the head commit: read the code paths involved, and
  reproduce it with a test when that is cheap. Check library behaviour in the library's source.
- Give it a verdict: **confirmed**, **partly** (the mechanism is real but the trigger or impact
  differs; say how), **refuted** (with the evidence), or **unproven** (what you tried and what
  would settle it).

Never accept or reject a finding from reading it alone. Outdated threads still get a verdict:
the code may have moved without fixing the problem.

## 3. Fix the confirmed ones

- Fix the cause, not the symptom. Findings that share a cause get one fix. A guard at the call
  site, a special case or a cleanup step after the fact usually means the cause is elsewhere.
- Add a test that fails without the fix.
- Something that predates the pull request: fix it here when it is small and safe, and say it
  predates the change. Otherwise leave it and list it in your report as a follow-up.
- A fix that needs a decision the working agreement reserves (a format change, a new
  dependency, contradicting a spec): stop and ask.
- Run `bun run typecheck` and `bun test`, then commit with a normal Conventional Commit message
  that describes the change, not the review.

## 4. Answer every thread

One reply per thread with `reply`, then `resolve` it:

- Confirmed: what changed and the commit, e.g. `Fixed in abc1234: disabled entries now go
  through de-duplication, so …`.
- Refuted: the reason in one or two sentences, with the evidence (file and line, test).
- Unproven or deferred: what is known and why it stays as it is. Leave a human reviewer's
  thread open when you disagree with them; resolve Codex's.

Replies are public. Write them for a developer who has not seen the code: what happens, why,
what changed.

## 5. Request a re-review

When this round changed code, push, then comment on the pull request:

```
gh pr comment <pr> --body "@codex review"
```

Go back to step 1. When a round changed no code, there is nothing new to review.

**Stop after three rounds** that each still had findings, or as soon as the same kind of
problem keeps coming back in a new place. That pattern usually means the design needs a
different shape, not another patch. Report the findings and the options instead of patching
again.

## 6. Report

In your report to the person you work for, and in a pull request comment when the PR is ready:
each finding with its verdict, what was done (commit or reason), the rounds it took, and
anything left open.
