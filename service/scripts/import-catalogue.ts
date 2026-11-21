/**
 * Imports the WoWInterface catalogue into D1.
 *
 *   node scripts/import-catalogue.ts (--local | --remote) [--input <filelist.json>]
 *     [--previous <projection.json>] [--out <projection.json>] [--database <name>] [--dry-run]
 *
 * Downloads filelist.json (or reads --input), keeps the fields search uses and compares them
 * with --previous, the projection the last successful import wrote with --out. Only changed
 * rows and removed ids are staged in D1; one statement then applies them, so search sees either
 * the old catalogue or the new one. Without a usable previous projection every row is staged
 * and the import replaces the catalogue. --out is written only after the import is applied.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CATALOG_URL, projectCatalog, type CatalogEntry } from "../src/search/wowi-catalog.ts";
import { applySql, diffCatalogue, stagingSql, uniqueById } from "./lib/catalogue-sql.ts";

const root = join(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    local: { type: "boolean", default: false },
    remote: { type: "boolean", default: false },
    input: { type: "string" },
    previous: { type: "string" },
    out: { type: "string" },
    database: { type: "string", default: "DB" },
    "dry-run": { type: "boolean", default: false },
  },
});
if (values.local === values.remote) {
  console.error("Pass exactly one of --local and --remote.");
  process.exit(2);
}
const target = values.local ? "--local" : "--remote";
const wranglerBin = join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");

function wrangler(args: string[]): string {
  const result = spawnSync(wranglerBin, ["d1", "execute", values.database!, target, "--yes", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function query<T>(sql: string): T[] {
  const parsed: unknown = JSON.parse(wrangler(["--json", "--command", sql]));
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  return (first?.results ?? []) as T[];
}

async function readProjection(path: string | undefined): Promise<CatalogEntry[] | undefined> {
  if (!path) return undefined;
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(data) ? (data as CatalogEntry[]) : undefined;
  } catch (err) {
    console.warn(`Ignoring the previous projection ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

async function download(): Promise<unknown> {
  if (values.input) return JSON.parse(await readFile(values.input, "utf8"));
  const response = await fetch(CATALOG_URL, { headers: { "User-Agent": "wowget-catalogue-import" } });
  if (!response.ok) throw new Error(`GET ${CATALOG_URL} failed: HTTP ${response.status}`);
  return response.json();
}

const started = performance.now();
const entries = uniqueById(projectCatalog(await download()));
console.log(`Projected ${entries.length} catalogue entries.`);

const live = query<{ n: number }>("SELECT COUNT(*) AS n FROM catalogue")[0]?.n ?? 0;
let previous = await readProjection(values.previous);
if (previous && previous.length !== live) {
  console.warn(`The previous projection has ${previous.length} entries but D1 has ${live}; replacing the whole catalogue.`);
  previous = undefined;
}
// A truncated or empty download must not wipe the catalogue.
if (live > 0 && entries.length < live / 2) {
  console.error(`The download has ${entries.length} entries, fewer than half of the ${live} in D1; not importing.`);
  process.exit(1);
}

const diff = diffCatalogue(previous, entries);
console.log(`${diff.full ? "Full import" : "Changes"}: ${diff.changed.length} rows to write, ${diff.removed.length} to remove.`);

if (values["dry-run"]) process.exit(0);

if (diff.full || diff.changed.length || diff.removed.length) {
  const importId = new Date().toISOString();
  const dir = await mkdtemp(join(tmpdir(), "wowget-catalogue-"));
  try {
    const file = join(dir, "staging.sql");
    await writeFile(file, stagingSql(importId, diff, entries.length, importId));
    wrangler(["--file", file]);
    console.log(`Staged import ${importId}.`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  wrangler(["--command", applySql(importId, new Date().toISOString())]);
  const status = query<{ status: string }>(`SELECT status FROM catalogue_imports WHERE id = '${importId}'`)[0]?.status;
  if (status !== "applied") {
    console.error(`Import ${importId} was not applied (status: ${status ?? "missing"}).`);
    process.exit(1);
  }
  const count = query<{ n: number }>("SELECT COUNT(*) AS n FROM catalogue")[0]?.n;
  console.log(`Applied import ${importId}; the catalogue has ${count} entries.`);
}

if (values.out) await writeFile(values.out, JSON.stringify(entries));
console.log(`Done in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
