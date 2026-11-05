/**
 * Checks registry/addons.toml against the sources: every entry must install on exactly the
 * flavors it lists and produce exactly the folders it lists. A disabled entry must install on
 * no flavor.
 *
 *   bun run registry:check [--only <name>]... [--file <path>] [--base <path>] [--write] [--report <path>]
 *
 * --write puts the flavors and folders found into the file for entries that differ, disables
 * entries that install on no flavor and re-enables disabled entries that install again.
 * --base names the registry the change started from: mismatches in entries it has unchanged
 * are warnings, since upstream changes to those are the scheduled update's job.
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
  /** The name the source suggests on `add`, from the first flavor that resolved. */
  defaultName?: string;
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
  let defaultName: string | undefined;
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
      defaultName ??= resolved.defaultName;
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
  const report = { name: entry.name, results, supported, folders, mismatches, ...(defaultName ? { defaultName } : {}) };
  if (entry.disabled !== undefined) {
    if (supported.length) mismatches.push(`is disabled, but installs on ${supported.join(", ")}`);
    return report;
  }
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
  return report;
}

/** The `disabled` value for an entry that installs on no flavor: the date and the first reason. */
export function disabledReason(report: EntryReport, date: string): string {
  const first = report.results.find((r) => r.reason)?.reason ?? "";
  const reason = first.replace(/\s+/g, " ").trim();
  return `installs on no flavor (checked ${date})${reason ? `: ${reason.length > 160 ? `${reason.slice(0, 159)}…` : reason}` : ""}`;
}

/**
 * Names of the entries in `entries` that the registry in `baseText` has with the same name,
 * source, flavors, folders and disabled reason, i.e. whose check result a change did not touch.
 */
export function unchangedEntries(entries: RegistryEntry[], baseText: string): Set<string> {
  const key = (e: RegistryEntry) =>
    JSON.stringify([
      e.source,
      [...e.flavors].sort(),
      e.folders.map((f) => f.toLowerCase()).sort(),
      e.disabled ?? null,
    ]);
  const base = new Map(parseRegistry(baseText).entries.map((e) => [normaliseName(e.name), key(e)]));
  return new Set(entries.filter((e) => base.get(normaliseName(e.name)) === key(e)).map((e) => e.name));
}

/** Runs `fn` over `items` with at most `limit` calls in flight, keeping the input order. */
export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

export const tomlList = (values: string[]) => `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;

export interface EntryChange {
  flavors?: string[];
  folders?: string[];
  /** A reason sets the `disabled` line; null removes it. */
  disabled?: string | null;
}

/**
 * Replaces the `flavors` and `folders` lines of the `[[addon]]` block named `name` and sets or
 * removes its `disabled` line, leaving every other line as it is. Each key must be on one line,
 * as the registry writes them.
 */
export function rewriteEntry(text: string, name: string, change: EntryChange): string {
  const lines = text.split("\n");
  const nameLine = lines.findIndex((l) => l.trim() === `name = ${JSON.stringify(name)}`);
  if (nameLine === -1) throw new Error(`no [[addon]] with name = ${JSON.stringify(name)}`);
  let start = nameLine;
  while (start > 0 && lines[start]!.trim() !== "[[addon]]") start--;
  let end = nameLine + 1;
  while (end < lines.length && lines[end]!.trim() !== "[[addon]]") end++;
  const lineOf = (key: string) => lines.findIndex((l, n) => n >= start && n < end && new RegExp(`^${key}\\s*=`).test(l.trim()));
  for (const [key, values] of [["flavors", change.flavors], ["folders", change.folders]] as const) {
    if (!values) continue;
    const i = lineOf(key);
    if (i === -1 || !/\]\s*(#.*)?$/.test(lines[i]!)) throw new Error(`${name}: ${key} is not a one-line array`);
    lines[i] = `${key} = ${tomlList(values)}`;
  }
  if (change.disabled !== undefined) {
    const i = lineOf("disabled");
    if (change.disabled === null) {
      if (i !== -1) lines.splice(i, 1);
    } else if (i !== -1) {
      lines[i] = `disabled = ${JSON.stringify(change.disabled)}`;
    } else {
      const folders = lineOf("folders");
      if (folders === -1) throw new Error(`${name}: no folders line to put disabled after`);
      lines.splice(folders + 1, 0, `disabled = ${JSON.stringify(change.disabled)}`);
    }
  }
  return lines.join("\n");
}

interface Outcome {
  entry: RegistryEntry;
  report?: EntryReport;
  error?: WowgetError | Error;
}

/** A GitHub Actions annotation, so a warning shows on the pull request; plain text elsewhere. */
function warn(title: string, message: string): void {
  if (process.env.GITHUB_ACTIONS === "true") {
    const escape = (v: string) => v.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    console.log(`::warning title=${escape(title).replace(/[:,]/g, " ")}::${escape(message)}`);
  } else {
    console.log(`  warning: ${message}`);
  }
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      only: { type: "string", multiple: true },
      file: { type: "string" },
      base: { type: "string" },
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
  let unchanged = new Set<string>();
  if (values.base) {
    try {
      unchanged = unchangedEntries(entries, await readFile(values.base, "utf8"));
    } catch (err) {
      console.error(`--base ${values.base} could not be read, so every entry counts as changed: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  const today = new Date().toISOString().slice(0, 10);
  const updated: string[] = [];
  const disabled: string[] = [];
  const reenabled: string[] = [];
  const unfixed: string[] = [];
  const drifted: string[] = [];
  const errors: string[] = [];
  let rateLimited = false;
  for (const { entry, report, error } of outcomes) {
    const label = `- **${entry.name}** (\`${entry.source}\`)`;
    if (error) {
      if (error instanceof WowgetError && error.code === "rate_limited") rateLimited = true;
      console.log(`error    ${entry.name} (${entry.source}): ${error.message}`);
      errors.push(`${label}: ${error.message}`);
      continue;
    }
    if (report!.mismatches.length === 0) {
      console.log(`ok       ${entry.name} (${entry.disabled !== undefined ? "disabled" : report!.supported.join(", ")})`);
      continue;
    }
    console.log(`mismatch ${entry.name} (${entry.source})`);
    for (const m of report!.mismatches) console.log(`  ${m}`);
    const details = report!.mismatches.map((m) => `  - ${m}`).join("\n");
    if (report!.supported.length) {
      console.log(`  found: flavors = ${tomlList(report!.supported)}`);
      console.log(`         folders = ${tomlList(report!.folders)}`);
    }
    if (!values.write) {
      if (unchanged.has(entry.name)) {
        for (const m of report!.mismatches) warn(`${entry.name} changed upstream`, `${entry.name}: ${m}`);
        drifted.push(`${label}\n${details}`);
      } else {
        unfixed.push(`${label}\n${details}`);
      }
      continue;
    }
    try {
      if (!report!.supported.length) {
        const reason = disabledReason(report!, today);
        text = rewriteEntry(text, entry.name, { disabled: reason });
        console.log(`  disabled: ${reason}`);
        disabled.push(`${label}: ${reason}\n${details}`);
      } else {
        const wasDisabled = entry.disabled !== undefined;
        text = rewriteEntry(text, entry.name, {
          flavors: report!.supported,
          folders: report!.folders,
          ...(wasDisabled ? { disabled: null } : {}),
        });
        (wasDisabled ? reenabled : updated).push(`${label}\n${details}`);
      }
    } catch (err) {
      unfixed.push(`${label}: ${err instanceof Error ? err.message : String(err)}\n${details}`);
    }
  }
  const written = updated.length + disabled.length + reenabled.length;
  if (written) await writeFile(file, text);

  const ok = outcomes.length - written - unfixed.length - drifted.length - errors.length;
  console.log(
    `\n${ok} of ${outcomes.length} entries match` +
      (updated.length ? `, ${updated.length} updated` : "") +
      (reenabled.length ? `, ${reenabled.length} re-enabled` : "") +
      (disabled.length ? `, ${disabled.length} disabled` : "") +
      (unfixed.length ? `, ${unfixed.length} mismatched` : "") +
      (drifted.length ? `, ${drifted.length} changed upstream but not by this change (warnings)` : "") +
      (errors.length ? `, ${errors.length} could not be checked` : "") +
      ".",
  );
  if (values.report) {
    const sections: string[] = [];
    if (updated.length) sections.push(`### Updated from what installs today\n\n${updated.join("\n")}`);
    if (reenabled.length) sections.push(`### Re-enabled, they install again\n\n${reenabled.join("\n")}`);
    if (disabled.length) sections.push(`### Disabled, they install on no flavor\n\n${disabled.join("\n")}`);
    if (unfixed.length) sections.push(`### Needs a person\n\n${unfixed.join("\n")}`);
    if (drifted.length) sections.push(`### Changed upstream, left for the scheduled update\n\n${drifted.join("\n")}`);
    if (errors.length) sections.push(`### Could not be checked (source problems, not changed)\n\n${errors.join("\n")}`);
    await writeFile(values.report, `${sections.join("\n\n") || "Every entry matches."}\n`);
  }
  return unfixed.length || rateLimited ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
