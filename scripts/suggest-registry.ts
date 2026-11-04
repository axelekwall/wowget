/**
 * Turns a registry suggestion issue into registry entries: checks each suggested source on every
 * flavor the way registry:check does and appends the ones that install somewhere.
 *
 *   bun scripts/suggest-registry.ts --body <file> [--file <path>] [--report <path>]
 *
 * The body is the issue body; its "### Addons" section holds one `<source> [name]` per line.
 * Exits 1 on a usage error or a GitHub rate limit. Rejected suggestions are reported, not failures.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { WowgetError } from "../src/core/errors.ts";
import { HttpClient, type FetchFn } from "../src/core/http.ts";
import { parseRegistry } from "../src/core/registry.ts";
import { defaultAddonName, parseSource } from "../src/core/sources/parse.ts";
import type { Http } from "../src/core/sources/types.ts";
import { addonsSection, parseSuggestionLines, sourceKey, type Suggestion } from "../src/core/suggest.ts";
import { checkEntry, mapLimited, tomlList, type EntryReport } from "./check-registry.ts";

/** Most suggestions one issue is checked for, to bound the run. */
export const MAX_SUGGESTIONS = 25;
const MAX_NAME_LENGTH = 100;

export interface Added {
  name: string;
  source: string;
  flavors: string[];
  folders: string[];
}

export interface SuggestOutcome {
  /** The registry text with the accepted entries appended. */
  text: string;
  added: Added[];
  rejected: { source: string; name?: string; reason: string }[];
  rateLimited: boolean;
}

export interface SuggestDeps {
  http: Http;
  /** Holds downloads and extracted folders; the caller removes it. */
  workDir: string;
  fetch?: FetchFn;
}

export function entryText(entry: Added): string {
  return [
    "[[addon]]",
    `name = ${JSON.stringify(entry.name)}`,
    `source = ${JSON.stringify(entry.source)}`,
    `flavors = ${tomlList(entry.flavors)}`,
    `folders = ${tomlList(entry.folders)}`,
  ].join("\n");
}

/**
 * Appends `block` after `text` with a blank line between. `text` stays a prefix of the result,
 * which the workflow checks before it publishes.
 */
function append(text: string, block: string): string {
  return `${text}${text.endsWith("\n") ? "" : "\n"}\n${block}\n`;
}

/** Why a check found no flavor to install on, with flavors that failed the same way grouped. */
function noFlavorReason(report: EntryReport): string {
  const byReason = new Map<string, string[]>();
  for (const r of report.results) {
    const reason = r.reason ?? "installs";
    byReason.set(reason, [...(byReason.get(reason) ?? []), r.flavor]);
  }
  const reasons = [...byReason].map(([reason, flavors]) => `${flavors.join(", ")}: ${reason}`);
  return `installs on no flavor (${reasons.join("; ")})`;
}

export async function suggestEntries(registryText: string, body: string, deps: SuggestDeps): Promise<SuggestOutcome> {
  const { entries, problems } = parseRegistry(registryText, { strict: true });
  if (problems.length) throw new Error(`the registry is invalid before any change:\n${problems.join("\n")}`);
  const listed = new Map(entries.map((e) => [sourceKey(e.source), e.name]));

  const rejected: SuggestOutcome["rejected"] = [];
  const reject = (s: Suggestion, reason: string) => rejected.push({ ...s, reason });
  const all = parseSuggestionLines(addonsSection(body));
  for (const s of all.slice(MAX_SUGGESTIONS)) reject(s, `skipped: an issue is checked for at most ${MAX_SUGGESTIONS} addons`);

  const seen = new Set<string>();
  const candidates: Suggestion[] = [];
  for (const s of all.slice(0, MAX_SUGGESTIONS)) {
    let kind: string;
    try {
      kind = parseSource(s.source).kind;
    } catch (err) {
      reject(s, err instanceof Error ? err.message : String(err));
      continue;
    }
    const key = sourceKey(s.source);
    if (s.name && s.name.length > MAX_NAME_LENGTH) reject(s, `the name is longer than ${MAX_NAME_LENGTH} characters`);
    else if (kind === "url") reject(s, "url: sources are not allowed in the registry");
    else if (listed.has(key)) reject(s, `already in the registry as ${listed.get(key)}`);
    else if (seen.has(key)) reject(s, "listed twice in the issue");
    else candidates.push(s);
    seen.add(key);
  }

  let rateLimited = false;
  const checked = await mapLimited(candidates, 4, async (s) => {
    const provisional = s.name ?? defaultAddonName(parseSource(s.source));
    try {
      const report = await checkEntry(
        { name: provisional, source: s.source, flavors: [], folders: [], aliases: [] },
        { http: deps.http, workDir: join(deps.workDir, String(candidates.indexOf(s))), fetch: deps.fetch },
      );
      return { s, report, name: s.name ?? report.defaultName ?? provisional };
    } catch (err) {
      if (err instanceof WowgetError && err.code === "rate_limited") rateLimited = true;
      return { s, error: err instanceof Error ? err.message : String(err) };
    }
  });

  let text = registryText;
  const added: Added[] = [];
  for (const c of checked) {
    if ("error" in c) {
      reject(c.s, `could not be checked: ${c.error}`);
      continue;
    }
    if (!c.report.supported.length) {
      reject(c.s, noFlavorReason(c.report));
      continue;
    }
    const entry: Added = { name: c.name, source: c.s.source, flavors: c.report.supported, folders: c.report.folders };
    const next = append(text, entryText(entry));
    // Strict parsing catches name and alias clashes with existing and earlier entries.
    const after = parseRegistry(next, { strict: true }).problems;
    if (after.length) {
      reject(c.s, after.map((p) => p.replace(/^addon #\d+ /, "")).join("; "));
      continue;
    }
    text = next;
    added.push(entry);
  }
  return { text, added, rejected, rateLimited };
}

/**
 * Issue text for a Markdown report: no backticks that could close a code span, no @mentions
 * that would notify someone, and a bounded length.
 */
function safe(text: string): string {
  const clipped = text.length > 300 ? `${text.slice(0, 300)}...` : text;
  return clipped.replace(/`/g, "'").replace(/@/g, "@\u200b");
}

export function reportMarkdown(outcome: SuggestOutcome): string {
  const sections: string[] = [];
  if (outcome.added.length) {
    const rows = outcome.added.map(
      (a) => `- **${safe(a.name)}** (\`${a.source}\`): ${a.flavors.join(", ")}; folders ${safe(a.folders.join(", "))}`,
    );
    sections.push(`### Added\n\n${rows.join("\n")}`);
  }
  if (outcome.rejected.length) {
    const rows = outcome.rejected.map(
      (r) => `- \`${safe(r.source)}\`${r.name ? ` (${safe(r.name)})` : ""}: ${safe(r.reason)}`,
    );
    sections.push(`### Not added\n\n${rows.join("\n")}`);
  }
  return `${sections.join("\n\n") || "The issue lists no addons. Put one `<source> [name]` per line in the Addons field."}\n`;
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      body: { type: "string" },
      file: { type: "string" },
      report: { type: "string" },
    },
  });
  if (!values.body) {
    console.error("--body <file> is required");
    return 1;
  }
  const file = values.file ?? join(import.meta.dir, "..", "registry", "addons.toml");
  const workDir = await mkdtemp(join(tmpdir(), "wowget-suggest-"));
  let outcome: SuggestOutcome;
  try {
    outcome = await suggestEntries(await readFile(file, "utf8"), await readFile(values.body, "utf8"), {
      http: new HttpClient(),
      workDir,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  if (outcome.added.length) await writeFile(file, outcome.text);
  const report = reportMarkdown(outcome);
  console.log(report);
  if (values.report) await writeFile(values.report, report);
  return outcome.rateLimited ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
