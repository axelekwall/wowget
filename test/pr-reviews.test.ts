import { describe, expect, test } from "bun:test";
import { codexDone, isCodex, parseCodexState } from "../scripts/pr-reviews.ts";

const HEAD = "ac26aa9305b6c59638c5e02ac2d488f0dfa8fb49";

function summary(code: object, security: object): string {
  return [
    "<!-- codex-pull-request-review-summary -->",
    `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: code, security_review: security })} -->`,
    "## Codex Review Summary",
  ].join("\n");
}

describe("parseCodexState", () => {
  test("reads the reviewed commit and status of both reviews", () => {
    const body = summary(
      { commit_sha: HEAD, has_any_findings: true, has_unresolved_findings: true, status: "completed" },
      { commit_sha: HEAD, has_any_findings: null, has_unresolved_findings: null, status: "completed" },
    );
    expect(parseCodexState(body)).toEqual({
      code: { commitSha: HEAD, status: "completed", hasUnresolvedFindings: true },
      security: { commitSha: HEAD, status: "completed", hasUnresolvedFindings: null },
    });
  });

  test("returns null without the marker or with broken JSON", () => {
    expect(parseCodexState("Here are some automated review suggestions.")).toBeNull();
    expect(parseCodexState("<!-- codex-review-state:v1 {nope} -->")).toBeNull();
  });
});

describe("codexDone", () => {
  const done = { commit_sha: HEAD, status: "completed" };

  test("needs both reviews settled on the head commit", () => {
    expect(codexDone(parseCodexState(summary(done, done)), HEAD)).toBe(true);
    expect(codexDone(parseCodexState(summary(done, { commit_sha: HEAD, status: "in_progress" })), HEAD)).toBe(false);
    expect(codexDone(parseCodexState(summary(done, done)), "0000000")).toBe(false);
    expect(codexDone(null, HEAD)).toBe(false);
  });

  test("does not wait for a security review Codex does not report", () => {
    expect(codexDone(parseCodexState(summary(done, { status: null })), HEAD)).toBe(true);
  });
});

test("isCodex matches the connector with or without the bot suffix", () => {
  expect(isCodex("chatgpt-codex-connector[bot]")).toBe(true);
  expect(isCodex("chatgpt-codex-connector")).toBe(true);
  expect(isCodex("axelekwall")).toBe(false);
  expect(isCodex(undefined)).toBe(false);
});
