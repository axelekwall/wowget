// Codex review status and unresolved review threads for pull requests.
//
//   bun scripts/pr-reviews.ts [<pr>…] [--all] [--json]
//       Codex's review state for each PR's head commit and its unresolved review threads
//       (every open PR when none is named; --all includes resolved threads).
//   bun scripts/pr-reviews.ts wait <pr> [--timeout <minutes>]
//       polls until Codex has reviewed the PR's head commit, then lists its threads.
//       Exits 0 when nothing is unresolved, 1 when threads remain, 2 when Codex comments instead
//       of reviewing or on timeout (default 20 minutes).
//   bun scripts/pr-reviews.ts reply <thread-id> <body…>
//   bun scripts/pr-reviews.ts resolve <thread-id>…
//
// Codex reviews a PR when it is opened or marked ready for review, and when someone comments
// `@codex review`. A push to an open PR does not start a new review. Its summary comment carries a
// machine-readable `codex-review-state:v1` marker naming the reviewed commit and each review's status.

const CODEX_LOGIN = "chatgpt-codex-connector";
const STATE_MARKER = /<!--\s*codex-review-state:v1\s+(\{[\s\S]*?\})\s*-->/;
const POLL_SECONDS = 30;

export interface ReviewState {
  commitSha: string | null;
  status: string | null;
  hasUnresolvedFindings: boolean | null;
}

export interface CodexState {
  code: ReviewState | null;
  security: ReviewState | null;
}

interface Comment {
  author: string | null;
  body: string;
  url: string;
  createdAt: string;
}

interface Thread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: { nodes: { author: { login: string } | null; body: string; url: string }[] };
}

interface PullRequest {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isDraft: boolean;
  /** Every conversation comment, oldest first. */
  comments: Comment[];
  /** Every review thread. */
  threads: Thread[];
}

const THREADS = `
query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line
          comments(first: 50) { nodes { author { login } body url } }
        }
      }
    }
  }
}`;

const REPLY = `
mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) {
    comment { url }
  }
}`;

const RESOLVE = `
mutation($thread: ID!) {
  resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } }
}`;

export function isCodex(login: string | undefined): boolean {
  return login?.replace(/\[bot\]$/, "") === CODEX_LOGIN;
}

function reviewState(value: unknown): ReviewState | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  return {
    commitSha: typeof v.commit_sha === "string" ? v.commit_sha : null,
    status: typeof v.status === "string" ? v.status : null,
    hasUnresolvedFindings: typeof v.has_unresolved_findings === "boolean" ? v.has_unresolved_findings : null,
  };
}

/** Reads the `codex-review-state:v1` marker from a Codex summary comment, or null without one. */
export function parseCodexState(body: string): CodexState | null {
  const match = STATE_MARKER.exec(body);
  if (match?.[1] === undefined) return null;
  try {
    const raw = JSON.parse(match[1]) as Record<string, unknown>;
    return { code: reviewState(raw.code_review), security: reviewState(raw.security_review) };
  } catch {
    return null;
  }
}

const RUNNING = /pending|queued|progress|running|requested|started/i;

/** True when a review covered `head` and is no longer running. */
export function reviewSettled(review: ReviewState | null, head: string): boolean {
  return review !== null && review.commitSha === head && review.status !== null && !RUNNING.test(review.status);
}

/**
 * The code review must cover the head commit. The security review counts only when Codex reports
 * one, so a repository without it is not left waiting.
 */
export function codexDone(state: CodexState | null, head: string): boolean {
  if (state === null) return false;
  const securityDone = state.security?.status == null || reviewSettled(state.security, head);
  return reviewSettled(state.code, head) && securityDone;
}

function latestCodexState(pr: PullRequest): CodexState | null {
  for (const comment of [...pr.comments].reverse()) {
    if (!isCodex(comment.author ?? undefined)) continue;
    const state = parseCodexState(comment.body);
    if (state !== null) return state;
  }
  return null;
}

const REVIEW_REQUEST = /@codex\s+(security\s+)?review\b/i;

/** When the latest `@codex review` comment was posted, or "" when nobody asked. */
export function lastRequestAt(comments: { body: string; createdAt: string }[]): string {
  return comments.filter((c) => REVIEW_REQUEST.test(c.body)).at(-1)?.createdAt ?? "";
}

/**
 * Codex's latest comment since the last review request that is not the review summary, such as a
 * setup problem that blocks reviews. Notes from before the request belong to an earlier round.
 */
function latestCodexNote(pr: PullRequest): Comment | null {
  const since = lastRequestAt(pr.comments);
  const notes = pr.comments.filter(
    (c) => isCodex(c.author ?? undefined) && c.createdAt > since && parseCodexState(c.body) === null,
  );
  return notes.at(-1) ?? null;
}

type Outcome = "reviewed" | "note" | "pending";

/**
 * Where Codex stands on the head commit. Only the summary marker names a commit, so it alone
 * counts as a review: a 👍 reaction could be left over from an earlier head. A comment without the
 * marker since the last request means Codex answered without reviewing, such as a setup problem.
 */
function codexOutcome(pr: PullRequest): Outcome {
  if (codexDone(latestCodexState(pr), pr.headRefOid)) return "reviewed";
  if (latestCodexNote(pr) !== null) return "note";
  return "pending";
}

function codexSummary(pr: PullRequest): string {
  const note = latestCodexNote(pr);
  if (codexOutcome(pr) === "note" && note !== null) return `no review; Codex commented: ${excerpt(note.body, 200)} ${note.url}`;
  const state = latestCodexState(pr);
  if (state === null) return pr.isDraft ? "no review yet (draft: mark it ready for review)" : "no review yet";
  const head = pr.headRefOid;
  const describe = (label: string, review: ReviewState | null): string | null => {
    if (review?.status == null) return null;
    const commit = review.commitSha === null ? "?" : review.commitSha.slice(0, 7);
    const stale = review.commitSha === head ? "" : ` (not the head ${head.slice(0, 7)})`;
    return `${label} ${review.status} on ${commit}${stale}`;
  };
  return [describe("code review", state.code), describe("security review", state.security)]
    .filter((part) => part !== null)
    .join("; ");
}

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${err.trim()}`);
  return out;
}

async function graphql<T>(query: string, vars: Record<string, string | number>): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(vars)) args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  return (JSON.parse(await gh(args)) as { data: T }).data;
}

async function repository(): Promise<{ owner: string; name: string }> {
  const out = await gh(["repo", "view", "--json", "owner,name"]);
  const repo = JSON.parse(out) as { owner: { login: string }; name: string };
  return { owner: repo.owner.login, name: repo.name };
}

async function pullRequest(number: number): Promise<PullRequest> {
  const { owner, name } = await repository();
  const fields = "number,title,url,headRefName,headRefOid,baseRefName,isDraft";
  const [meta, comments] = await Promise.all([
    gh(["pr", "view", String(number), "--json", fields]),
    // REST pages through every comment; Codex edits its one summary comment in place, so it can be
    // far from the end of the list.
    gh([
      "api",
      "--paginate",
      `repos/${owner}/${name}/issues/${number}/comments?per_page=100`,
      "--jq",
      ".[] | {author: .user.login, body, url: .html_url, createdAt: .created_at} | @json",
    ]),
  ]);
  // Threads are read after the comments, so a summary that says the review is complete is never
  // paired with a thread list from before Codex published its findings.
  const threads = await gh([
    "api",
    "graphql",
    "--paginate",
    "--slurp",
    "-f",
    `query=${THREADS}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${number}`,
  ]);
  type Page = { data: { repository: { pullRequest: { reviewThreads: { nodes: Thread[] } } } } };
  return {
    ...(JSON.parse(meta) as Omit<PullRequest, "comments" | "threads">),
    comments: lines(comments).map((line) => JSON.parse(line) as Comment),
    threads: (JSON.parse(threads) as Page[]).flatMap((page) => page.data.repository.pullRequest.reviewThreads.nodes),
  };
}

function lines(out: string): string[] {
  return out.split("\n").filter((line) => line.trim() !== "");
}

async function openNumbers(): Promise<number[]> {
  const { owner, name } = await repository();
  const out = await gh(["api", "--paginate", `repos/${owner}/${name}/pulls?state=open&per_page=100`, "--jq", ".[].number"]);
  return lines(out).map(Number).sort((a, b) => a - b);
}

function excerpt(body: string, length = 300): string {
  const flat = body.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

function threadsOf(pr: PullRequest, includeResolved: boolean): Thread[] {
  return pr.threads.filter((thread) => includeResolved || !thread.isResolved);
}

function print(pr: PullRequest, threads: Thread[]): void {
  console.log(`\n#${pr.number} ${pr.title}  (${pr.headRefName} → ${pr.baseRefName}, head ${pr.headRefOid.slice(0, 7)})`);
  console.log(pr.url);
  console.log(`  Codex: ${codexSummary(pr)}`);
  if (threads.length === 0) console.log("  No unresolved review threads.");
  for (const thread of threads) {
    const [first, ...answers] = thread.comments.nodes;
    const flags = [thread.isResolved ? "resolved" : "unresolved", thread.isOutdated ? "outdated" : null].filter(Boolean);
    console.log(`\n  ${thread.path}:${thread.line ?? "?"}  [${flags.join(", ")}]  thread ${thread.id}`);
    if (first !== undefined) {
      console.log(`    ${first.author?.login ?? "?"}: ${excerpt(first.body)}`);
      console.log(`    ${first.url}`);
    }
    for (const answer of answers) console.log(`    ↳ ${answer.author?.login ?? "?"}: ${excerpt(answer.body, 160)}`);
  }
}

function toJson(pr: PullRequest, threads: Thread[]) {
  return {
    number: pr.number,
    url: pr.url,
    head: pr.headRefOid,
    codex: latestCodexState(pr),
    outcome: codexOutcome(pr),
    threads: threads.map((t) => ({
      id: t.id,
      resolved: t.isResolved,
      outdated: t.isOutdated,
      path: t.path,
      line: t.line,
      comments: t.comments.nodes.map((c) => ({ author: c.author?.login ?? null, body: c.body, url: c.url })),
    })),
  };
}

async function wait(number: number, timeoutMinutes: number): Promise<number> {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  for (;;) {
    const pr = await pullRequest(number);
    const outcome = codexOutcome(pr);
    if (outcome !== "pending") {
      const threads = threadsOf(pr, false);
      print(pr, threads);
      if (outcome === "note") {
        console.error("\nCodex commented instead of reviewing; see its comment above.");
        return 2;
      }
      return threads.length === 0 ? 0 : 1;
    }
    if (Date.now() >= deadline) {
      print(pr, threadsOf(pr, false));
      console.error(`\nCodex has not reviewed ${pr.headRefOid.slice(0, 7)} after ${timeoutMinutes} minutes.`);
      return 2;
    }
    console.error(`#${number}: ${codexSummary(pr)}; checking again in ${POLL_SECONDS}s`);
    await Bun.sleep(POLL_SECONDS * 1000);
  }
}

const USAGE = `usage:
  bun scripts/pr-reviews.ts [<pr>…] [--all] [--json]
  bun scripts/pr-reviews.ts wait <pr> [--timeout <minutes>]
  bun scripts/pr-reviews.ts reply <thread-id> <body…>
  bun scripts/pr-reviews.ts resolve <thread-id>…`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "wait") {
    const number = Number(rest[0]);
    const flag = rest.indexOf("--timeout");
    const timeout = flag === -1 ? 20 : Number(rest[flag + 1]);
    if (!Number.isInteger(number) || !(timeout > 0)) {
      console.error(USAGE);
      return 2;
    }
    return wait(number, timeout);
  }
  if (command === "reply") {
    const [thread, ...words] = rest;
    if (thread === undefined || words.length === 0) {
      console.error(USAGE);
      return 2;
    }
    const data = await graphql<{ addPullRequestReviewThreadReply: { comment: { url: string } } }>(REPLY, {
      thread,
      body: words.join(" "),
    });
    console.log(`Replied: ${data.addPullRequestReviewThreadReply.comment.url}`);
    return 0;
  }
  if (command === "resolve") {
    if (rest.length === 0) {
      console.error(USAGE);
      return 2;
    }
    for (const thread of rest) {
      await graphql(RESOLVE, { thread });
      console.log(`Resolved ${thread}`);
    }
    return 0;
  }
  if (argv.some((arg) => !/^(\d+|--all|--json)$/.test(arg))) {
    console.error(USAGE);
    return 2;
  }
  const includeResolved = argv.includes("--all");
  const named = argv.filter((arg) => /^\d+$/.test(arg)).map(Number);
  const numbers = named.length > 0 ? named : await openNumbers();
  const prs = await Promise.all(numbers.map(pullRequest));
  if (argv.includes("--json")) {
    console.log(JSON.stringify(prs.map((pr) => toJson(pr, threadsOf(pr, includeResolved))), null, 2));
  } else {
    if (prs.length === 0) console.log("No open pull requests.");
    for (const pr of prs) print(pr, threadsOf(pr, includeResolved));
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
