/**
 * Checks registry/addons.toml against the sources: every entry must install on exactly the
 * flavors it lists and produce exactly the folders it lists. Never edits the file.
 *
 *   bun run registry:check [--only <name>]... [--file <path>]
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { only: { type: "string", multiple: true }, file: { type: "string" } },
  });
  const file = values.file ?? join(import.meta.dir, "..", "registry", "addons.toml");
  const { entries, problems } = parseRegistry(await readFile(file, "utf8"), { strict: true });
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
  let failed = 0;
  try {
    await mapLimited(selected, 4, async (entry) => {
      const lines: string[] = [];
      try {
        const report = await checkEntry(entry, { http, workDir: join(workDir, normaliseName(entry.name)) });
        if (report.mismatches.length === 0) {
          lines.push(`ok       ${entry.name} (${report.supported.join(", ")})`);
        } else {
          failed++;
          lines.push(`mismatch ${entry.name} (${entry.source})`);
          for (const m of report.mismatches) lines.push(`  ${m}`);
          if (report.supported.length) {
            lines.push(`  found: flavors = ${tomlList(report.supported)}`);
            lines.push(`         folders = ${tomlList(report.folders)}`);
          }
        }
      } catch (err) {
        failed++;
        lines.push(`error    ${entry.name} (${entry.source}): ${err instanceof Error ? err.message : String(err)}`);
      }
      console.log(lines.join("\n"));
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  console.log(`\n${selected.length - failed} of ${selected.length} entries match.`);
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
