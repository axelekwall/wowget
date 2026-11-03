/**
 * Checks registry/addons.toml against the sources: every entry must install on exactly the
 * flavors it lists and produce exactly the folders it lists.
 *
 *   bun run registry:check [--only <name>]... [--file <path>] [--write] [--report <path>]
 *
 * --write puts the flavors and folders found into the file for entries that differ.
 * --report writes a Markdown summary of the changes and problems (for the update PR).
 * Exits 1 on mismatches it did not write, invalid entries or a GitHub rate limit. Other errors
 * reaching a source (a failed download, a checksum the source lists wrongly) are reported but
 * do not fail the run: they say the source is broken, not that the entry is wrong.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { WowgetError } from "../src/core/errors.ts";
import { FLAVORS, folderSupportsFlavor, type Flavor } from "../src/core/flavor.ts";
import { HttpClient, type FetchFn } from "../src/core/http.ts";
import { fetchToCache } from "../src/core/installer.ts";
import { normaliseName, parseRegistry, type RegistryEntry } from "../src/core/registry.ts";
import { sourceFor } from "../src/core/sources/index.ts";
import { parseSource } from "../src/core/sources/parse.ts";
import type { Http, Resolved } from "../src/core/sources/types.ts";
import { extractAddons } from "../src/core/zip.ts";

export interface FlavorResult {
  flavor: Flavor;
  /** Folder names when `add` would install on this flavor; undefined when it would not. */
  folders?: string[];
  reason?: string;
}

export interface EntryReport {
  name: string;
  results: FlavorResult[];
  supported: Flavor[];
  folders: string[];
  mismatches: string[];
}

export interface CheckDeps {
  http: Http;
  /** Holds downloaded zips and extracted folders; the caller removes it. */
  workDir: string;
  fetch?: FetchFn;
}

function sameSet(a: string[], b: string[]): boolean {
  const left = new Set(a.map((s) => s.toLowerCase()));
  const right = new Set(b.map((s) => s.toLowerCase()));
  return left.size === right.size && [...left].every((s) => right.has(s));
}

/** Resolves and inspects `entry` on every flavor the way `wowget add` would install it. */
export async function checkEntry(entry: RegistryEntry, deps: CheckDeps): Promise<EntryReport> {
  const source = sourceFor(parseSource(entry.source));
  // Several flavors often resolve to the same zip; download and extract each one once.
  const extracted = new Map<string, Promise<{ name: string; path: string }[]>>();
  const extract = (resolved: Resolved) => {
    let pending = extracted.get(resolved.downloadUrl);
    if (!pending) {
      pending = (async () => {
        const { bytes, sha256 } = await fetchToCache({
          addon: entry.name,
          resolved,
          cacheDir: join(deps.workDir, "cache"),
          fetch: deps.fetch,
        });
        return extractAddons(bytes, join(deps.workDir, "extract", sha256));
      })();
      extracted.set(resolved.downloadUrl, pending);
    }
    return pending;
  };

  const results: FlavorResult[] = [];
  for (const flavor of FLAVORS) {
    let resolved: Resolved;
    let folders: { name: string; path: string }[];
    try {
      resolved = await source.resolve({
        addon: entry.name,
        flavor,
        prerelease: false,
        http: deps.http,
        cacheDir: join(deps.workDir, "cache"),
      });
      folders = await extract(resolved);
    } catch (err) {
      if (err instanceof WowgetError && (err.code === "flavor" || err.code === "source" || err.code === "zip")) {
        results.push({ flavor, reason: err.message });
        continue;
      }
      throw err;
    }
    // Same rule as the installer without --force: every folder must clearly support the flavor.
    let reason: string | undefined;
    if (!resolved.flavorVerified) {
      for (const folder of folders) {
        const support = await folderSupportsFlavor(folder.path, flavor);
        if (support !== "yes") {
          reason = `${folder.name}: TOC support is "${support}"`;
          break;
        }
      }
    }
    results.push(reason ? { flavor, reason } : { flavor, folders: folders.map((f) => f.name) });
  }

  const supported = results.filter((r) => r.folders).map((r) => r.flavor);
  const folders = [...new Set(results.flatMap((r) => r.folders ?? []))].sort((a, b) => a.localeCompare(b));
  const mismatches: string[] = [];
  if (supported.length === 0) mismatches.push("installs on no flavor");
  for (const flavor of entry.flavors) {
    const result = results.find((r) => r.flavor === flavor)!;
    if (!result.folders) mismatches.push(`lists ${flavor}, which does not install: ${result.reason}`);
  }
  for (const flavor of supported) {
    if (!entry.flavors.includes(flavor)) mismatches.push(`installs on ${flavor}, which is not listed`);
  }
  if (supported.length && !sameSet(entry.folders, folders)) {
    mismatches.push(`lists folders ${JSON.stringify(entry.folders)}, installs ${JSON.stringify(folders)}`);
  }
  return { name: entry.name, results, supported, folders, mismatches };
}

/** Runs `fn` over `items` with at most `limit` calls in flight, keeping the input order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

const tomlList = (values: string[]) => `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;

/**
 * Replaces the `flavors` and `folders` lines of the `[[addon]]` block named `name`, leaving every
 * other line as it is. Both keys must be on one line each, as the registry writes them.
 */
export function rewriteEntry(text: string, name: string, found: { flavors: string[]; folders: string[] }): string {
  const lines = text.split("\n");
  const nameLine = lines.findIndex((l) => l.trim() === `name = ${JSON.stringify(name)}`);
  if (nameLine === -1) throw new Error(`no [[addon]] with name = ${JSON.stringify(name)}`);
  let start = nameLine;
  while (start > 0 && lines[start]!.trim() !== "[[addon]]") start--;
  let end = nameLine + 1;
  while (end < lines.length && lines[end]!.trim() !== "[[addon]]") end++;
  for (const [key, values] of [["flavors", found.flavors], ["folders", found.folders]] as const) {
    const i = lines.findIndex((l, n) => n >= start && n < end && new RegExp(`^${key}\\s*=`).test(l.trim()));
    if (i === -1 || !/\]\s*(#.*)?$/.test(lines[i]!)) throw new Error(`${name}: ${key} is not a one-line array`);
    lines[i] = `${key} = ${tomlList(values)}`;
  }
  return lines.join("\n");
}

interface Outcome {
  entry: RegistryEntry;
  report?: EntryReport;
  error?: WowgetError | Error;
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      only: { type: "string", multiple: true },
      file: { type: "string" },
      write: { type: "boolean" },
      report: { type: "string" },
    },
  });
  const file = values.file ?? join(import.meta.dir, "..", "registry", "addons.toml");
  let text = await readFile(file, "utf8");
  const { entries, problems } = parseRegistry(text, { strict: true });
  for (const problem of problems) console.error(`invalid  ${problem}`);
  if (problems.length) return 1;

  const only = new Set((values.only ?? []).map(normaliseName));
  const selected = only.size ? entries.filter((e) => only.has(normaliseName(e.name))) : entries;
  if (only.size && selected.length !== only.size) {
    console.error(`--only matched ${selected.length} of ${only.size} names`);
    return 1;
  }

  const http = new HttpClient();
  const workDir = await mkdtemp(join(tmpdir(), "wowget-registry-"));
  let outcomes: Outcome[];
  try {
    outcomes = await mapLimited(selected, 4, async (entry): Promise<Outcome> => {
      try {
        return { entry, report: await checkEntry(entry, { http, workDir: join(workDir, normaliseName(entry.name)) }) };
      } catch (err) {
        return { entry, error: err instanceof Error ? err : new Error(String(err)) };
      }
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  const updated: string[] = [];
  const unfixed: string[] = [];
  const errors: string[] = [];
  let rateLimited = false;
  for (const { entry, report, error } of outcomes) {
    if (error) {
      if (error instanceof WowgetError && error.code === "rate_limited") rateLimited = true;
      console.log(`error    ${entry.name} (${entry.source}): ${error.message}`);
      errors.push(`- **${entry.name}** (\`${entry.source}\`): ${error.message}`);
      continue;
    }
    if (report!.mismatches.length === 0) {
      console.log(`ok       ${entry.name} (${report!.supported.join(", ")})`);
      continue;
    }
    console.log(`mismatch ${entry.name} (${entry.source})`);
    for (const m of report!.mismatches) console.log(`  ${m}`);
    const details = report!.mismatches.map((m) => `  - ${m}`).join("\n");
    // An entry that installs nowhere needs a person: drop it or find another source.
    if (!report!.supported.length) {
      unfixed.push(`- **${entry.name}** (\`${entry.source}\`)\n${details}`);
      continue;
    }
    console.log(`  found: flavors = ${tomlList(report!.supported)}`);
    console.log(`         folders = ${tomlList(report!.folders)}`);
    if (!values.write) {
      unfixed.push(`- **${entry.name}** (\`${entry.source}\`)\n${details}`);
      continue;
    }
    try {
      text = rewriteEntry(text, entry.name, { flavors: report!.supported, folders: report!.folders });
      updated.push(`- **${entry.name}** (\`${entry.source}\`)\n${details}`);
    } catch (err) {
      unfixed.push(`- **${entry.name}** (\`${entry.source}\`): ${err instanceof Error ? err.message : String(err)}\n${details}`);
    }
  }
  if (updated.length) await writeFile(file, text);

  const ok = outcomes.length - updated.length - unfixed.length - errors.length;
  console.log(
    `\n${ok} of ${outcomes.length} entries match` +
      (updated.length ? `, ${updated.length} updated` : "") +
      (unfixed.length ? `, ${unfixed.length} mismatched` : "") +
      (errors.length ? `, ${errors.length} could not be checked` : "") +
      ".",
  );
  if (values.report) {
    const sections: string[] = [];
    if (updated.length) sections.push(`### Updated from what installs today\n\n${updated.join("\n")}`);
    if (unfixed.length) sections.push(`### Needs a person\n\n${unfixed.join("\n")}`);
    if (errors.length) sections.push(`### Could not be checked (source problems, not changed)\n\n${errors.join("\n")}`);
    await writeFile(values.report, `${sections.join("\n\n") || "Every entry matches."}\n`);
  }
  return unfixed.length || rateLimited ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
