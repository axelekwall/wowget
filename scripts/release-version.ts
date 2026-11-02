// Works out the next release from the Conventional Commits since the last stable tag.
//
//   bun scripts/release-version.ts           prints the next tag; with GITHUB_OUTPUT set,
//                                            also writes `tag`, `previous` and `release`
//   bun scripts/release-version.ts --lint T  exits 1 when T is not a Conventional Commit header
import { appendFile } from "node:fs/promises";

export type Bump = "major" | "minor" | "patch";

export interface Header {
  type: string;
  scope?: string;
  breaking: boolean;
  description: string;
}

/** Types a commit header may use. Only feat, fix and perf lead to a release. */
export const TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "ci", "build", "chore", "style", "revert"];

const HEADER = /^([a-z]+)(?:\(([^()\r\n]+)\))?(!)?: (\S.*)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: /m;
const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function parseHeader(line: string): Header | undefined {
  const match = HEADER.exec(line.trim());
  if (!match) return undefined;
  const header: Header = { type: match[1]!, breaking: match[3] === "!", description: match[4]! };
  if (match[2] !== undefined) header.scope = match[2];
  return header;
}

/** Why `title` cannot be a release-relevant commit header, or undefined when it can. */
export function lintHeader(title: string): string | undefined {
  const header = parseHeader(title);
  if (!header) return `"${title}" is not a Conventional Commit header like "feat: add search" or "fix(wowi): handle 404".`;
  if (!TYPES.includes(header.type)) return `"${header.type}" is not one of the commit types: ${TYPES.join(", ")}.`;
  return undefined;
}

/** The largest bump the commit messages ask for, or undefined when none of them releases. */
export function bumpFor(messages: string[]): Bump | undefined {
  let bump: Bump | undefined;
  for (const message of messages) {
    const header = parseHeader(message.split("\n", 1)[0] ?? "");
    if (!header) continue;
    if (header.breaking || BREAKING_FOOTER.test(message)) return "major";
    if (header.type === "feat") bump = "minor";
    else if ((header.type === "fix" || header.type === "perf") && bump === undefined) bump = "patch";
  }
  return bump;
}

/** Applies `bump` to a "x.y.z" version. Before 1.0 a breaking change bumps the minor version. */
export function nextVersion(current: string, bump: Bump): string {
  const [major, minor, patch] = current.split(".").map(Number) as [number, number, number];
  if (bump === "major" && major > 0) return `${major + 1}.0.0`;
  if (bump === "major" || bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

/** The newest `vX.Y.Z` tag reachable from HEAD; pre-release tags are skipped. */
function lastStableTag(): string | undefined {
  return git("tag", "--merged", "HEAD", "--list", "v*", "--sort=-v:refname")
    .split("\n")
    .find((t) => STABLE_TAG.test(t));
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--lint") {
    const problem = lintHeader(argv.slice(1).join(" "));
    if (problem) console.error(problem);
    return problem ? 1 : 0;
  }

  const previous = lastStableTag();
  const range = previous ? [`${previous}..HEAD`] : ["HEAD"];
  // Records end with a NUL so multi-line bodies stay together.
  const messages = git("log", "--format=%B%x00", ...range)
    .split("\0")
    .map((m) => m.trim())
    .filter(Boolean);
  const bump = bumpFor(messages);
  const tag = bump ? `v${nextVersion(previous ? previous.slice(1) : "0.0.0", bump)}` : "";

  const since = previous ?? "the first commit";
  console.log(bump ? `${tag} (${bump}, ${messages.length} commits since ${since})` : `No release: none of the ${messages.length} commits since ${since} is a feat, fix, perf or breaking change.`);
  const output = process.env.GITHUB_OUTPUT;
  if (output) await appendFile(output, `tag=${tag}\nprevious=${previous ?? ""}\nrelease=${bump ? "true" : "false"}\n`);
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
