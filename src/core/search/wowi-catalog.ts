import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OnEvent } from "../events.ts";
import type { Flavor, Support } from "../flavor.ts";
import type { Http } from "../sources/types.ts";
import type { SearchRow } from "./types.ts";

export const CATALOG_URL = "https://api.mmoui.com/v3/game/WOW/filelist.json";
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECORD_KEY = "catalog:wowi";

/** The fields of a WoWInterface filelist entry that search and reconcile use. */
export interface CatalogEntry {
  id: string;
  name: string;
  author?: string;
  version?: string;
  updatedAt?: string;
  downloadsMonthly: number;
  /** Patch numbers from UICompatibility, such as "1.15.7". */
  versions: string[];
  folders: string[];
  url?: string;
}

export interface CatalogResult {
  entries: CatalogEntry[];
  /** Set when the catalogue could not be refreshed; says what was used instead. */
  warning?: string;
}

/** `<cacheDir>/.catalog/wowi.json`. */
export function catalogPath(cacheDir: string): string {
  return join(cacheDir, ".catalog", "wowi.json");
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** Keeps the used fields of a filelist response, dropping entries without an id or a name. */
export function projectCatalog(raw: unknown): CatalogEntry[] {
  if (!Array.isArray(raw)) throw new Error("the WoWInterface file list is not an array");
  const out: CatalogEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    const id = str(String(e.UID ?? ""));
    const name = str(e.UIName);
    if (!id || !/^[1-9][0-9]*$/.test(id) || !name) continue;
    const date = Number(e.UIDate);
    const compat = Array.isArray(e.UICompatibility) ? e.UICompatibility : [];
    const entry: CatalogEntry = {
      id,
      name,
      downloadsMonthly: Number(e.UIDownloadMonthly) || 0,
      versions: compat.flatMap((c) => (typeof c?.version === "string" ? [c.version] : [])),
      folders: Array.isArray(e.UIDir) ? e.UIDir.filter((d): d is string => typeof d === "string" && d !== "") : [],
    };
    const author = str(e.UIAuthorName);
    const version = str(e.UIVersion);
    const url = str(e.UIFileInfoURL);
    if (author) entry.author = author;
    if (version) entry.version = version;
    if (Number.isFinite(date) && date > 0) entry.updatedAt = new Date(date).toISOString();
    if (url) entry.url = url;
    out.push(entry);
  }
  return out;
}

/** Flavors named by WoWInterface patch numbers. Forever has no known patch number, so it is never listed. */
export function flavorsForVersions(versions: string[]): Flavor[] {
  const flavors = new Set<Flavor>();
  for (const v of versions) {
    const major = Number.parseInt(v, 10);
    if (major === 1) flavors.add("classic");
    else if (major === 2) flavors.add("bcc");
    else if (major === 3) flavors.add("wrath");
    else if (major === 4) flavors.add("cata");
    else if (major === 5) flavors.add("mists");
    else if (major >= 6) flavors.add("mainline");
  }
  return [...flavors];
}

export function catalogRow(entry: CatalogEntry): SearchRow {
  const flavors: Partial<Record<Flavor, Support>> = { forever: "unknown" };
  for (const f of flavorsForVersions(entry.versions)) flavors[f] = "yes";
  const row: SearchRow = {
    name: entry.name,
    source: `wowi:${entry.id}`,
    origin: "wowi",
    flavors,
    aliases: [],
    folders: entry.folders,
    downloadsMonthly: entry.downloadsMonthly,
  };
  if (entry.updatedAt) row.updatedAt = entry.updatedAt;
  if (entry.url) row.url = entry.url;
  return row;
}

async function readCopy(cacheDir: string): Promise<CatalogEntry[] | undefined> {
  try {
    const data = JSON.parse(await readFile(catalogPath(cacheDir), "utf8"));
    return Array.isArray(data) ? (data as CatalogEntry[]) : undefined;
  } catch {
    return undefined;
  }
}

function fetchedAt(http: Http): number | undefined {
  const record = http.readRecord(RECORD_KEY);
  if (!record) return undefined;
  const at = Date.parse(new TextDecoder().decode(record.body));
  return Number.isFinite(at) ? at : undefined;
}

/** The cached catalogue without any network access; empty when there is none. */
export async function readCachedCatalog(cacheDir: string): Promise<CatalogEntry[]> {
  return (await readCopy(cacheDir)) ?? [];
}

/**
 * The WoWInterface catalogue, downloaded when the cached copy is missing, older than
 * CATALOG_MAX_AGE_MS or `refresh` is set. A failed download falls back to the cached copy.
 */
export async function loadCatalog(opts: {
  http: Http;
  cacheDir: string;
  refresh?: boolean;
  onEvent?: OnEvent;
  now?: number;
}): Promise<CatalogResult> {
  const now = opts.now ?? Date.now();
  const at = fetchedAt(opts.http);
  const copy = await readCopy(opts.cacheDir);
  if (copy && at !== undefined && now - at < CATALOG_MAX_AGE_MS && !opts.refresh) return { entries: copy };

  try {
    opts.onEvent?.({ type: "catalog:download", url: CATALOG_URL });
    const result = await opts.http.getConditional(CATALOG_URL, {});
    const entries = projectCatalog(JSON.parse(new TextDecoder().decode(result.body!)));
    const path = catalogPath(opts.cacheDir);
    await mkdir(join(opts.cacheDir, ".catalog"), { recursive: true });
    const tmp = `${path}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(entries));
      await rename(tmp, path);
    } finally {
      await rm(tmp, { force: true });
    }
    opts.http.writeRecord(RECORD_KEY, {
      etag: null,
      lastModified: null,
      body: new TextEncoder().encode(new Date(now).toISOString()),
    });
    return { entries };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (copy) {
      const age = at === undefined ? "an unknown time" : `${Math.max(0, Math.round((now - at) / 3_600_000))} hours`;
      return { entries: copy, warning: `WoWInterface catalogue refresh failed (${reason}); using the copy from ${age} ago.` };
    }
    return { entries: [], warning: `WoWInterface catalogue unavailable: ${reason}` };
  }
}
