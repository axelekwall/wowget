import { loadBundles, saveBundles } from "../cache.ts";
import { FLAVORS, type Flavor } from "../flavor.ts";
import { CachedHttp, type FetchFn } from "../http.ts";
import { normaliseName, type RegistryEntry } from "../registry.ts";
import { searchGithub } from "./github-search.ts";
import { queryWords, rankRows } from "./index.ts";
import { registryRows } from "./registry.ts";
import type { SearchRow } from "./types.ts";
import { catalogRow, type CatalogEntry } from "./wowi-catalog.ts";

export const GITHUB_SEARCH_MAX_AGE_MS = 60 * 60 * 1000;
/** More words than this only narrow the database lookup further; ranking still checks them all. */
const MAX_SQL_WORDS = 8;
const MAX_CANDIDATES = 500;

export interface SearchResponseRow {
  name: string;
  source: string;
  origin: SearchRow["origin"];
  flavors: Partial<Record<Flavor, "yes" | "unknown">>;
  folders: string[];
  description: string | null;
  downloads: number | null;
  stars: number | null;
  updatedAt: string | null;
  url: string | null;
}

export interface SearchDeps {
  db: D1Database;
  fetch: FetchFn;
  githubToken?: string;
  registry: RegistryEntry[];
  now?: () => number;
}

interface CatalogueRow {
  id: number;
  name: string;
  author: string | null;
  version: string | null;
  updated_at: string | null;
  downloads_monthly: number;
  versions: string;
  folders: string;
  url: string | null;
}

function jsonList(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toEntry(row: CatalogueRow): CatalogEntry {
  const entry: CatalogEntry = {
    id: String(row.id),
    name: row.name,
    downloadsMonthly: row.downloads_monthly,
    versions: jsonList(row.versions),
    folders: jsonList(row.folders),
  };
  if (row.author) entry.author = row.author;
  if (row.version) entry.version = row.version;
  if (row.updated_at) entry.updatedAt = row.updated_at;
  if (row.url) entry.url = row.url;
  return entry;
}

/**
 * Catalogue entries whose name or folders contain every query word, the widest set any match
 * tier accepts. The trigram index answers LIKE for words of three or more characters.
 *
 * A short or common query matches thousands of rows, so exact, prefix and substring matches are
 * fetched separately, each capped to the most downloaded. Ranking sorts by tier, then
 * popularity, so a cap only drops rows that would rank below MAX_CANDIDATES more popular ones
 * of the same kind.
 */
export async function catalogueCandidates(db: D1Database, query: string): Promise<CatalogEntry[]> {
  const words = [...new Set(queryWords(query))].slice(0, MAX_SQL_WORDS);
  const q = normaliseName(query);
  if (words.length === 0 || !q) return [];
  const where = words.map(() => "search_text LIKE ?").join(" AND ");
  const columns = "id, name, author, version, updated_at, downloads_monthly, versions, folders, url";
  const select = (condition: string, ...params: string[]) =>
    db
      .prepare(
        `SELECT ${columns} FROM catalogue WHERE id IN (SELECT rowid FROM catalogue_fts WHERE ${condition})
         ORDER BY downloads_monthly DESC LIMIT ${MAX_CANDIDATES}`,
      )
      .bind(...params);
  // search_text separates the name and each folder with a space, so a field boundary is the
  // start, the end or a space.
  const results = await db.batch<CatalogueRow>([
    select(
      "search_text = ? OR search_text LIKE ? OR search_text LIKE ? OR search_text LIKE ?",
      q,
      `${q} %`,
      `% ${q}`,
      `% ${q} %`,
    ),
    select("search_text LIKE ? OR search_text LIKE ?", `${q}%`, `% ${q}%`),
    select(where, ...words.map((w) => `%${w}%`)),
  ]);
  const byId = new Map<number, CatalogueRow>();
  for (const row of results.flatMap((r) => r.results)) if (!byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()].map(toEntry);
}

async function githubRows(deps: SearchDeps, query: string): Promise<SearchRow[]> {
  const q = query.toLowerCase();
  const key = JSON.stringify(["github-search", q]);
  const now = deps.now ?? Date.now;
  const bundles = await loadBundles(deps.db, [key]);
  const http = new CachedHttp({
    fetch: deps.fetch,
    githubToken: deps.githubToken,
    bundle: bundles.get(key),
    maxAgeMs: GITHUB_SEARCH_MAX_AGE_MS,
    now,
  });
  const rows = await searchGithub(http, q);
  if (http.dirty) await saveBundles(deps.db, [[key, http.bundle]], now()).catch((err) => console.error("saving the search cache failed", err));
  return rows;
}

function responseRow(row: SearchRow, filter: Flavor[] | undefined): SearchResponseRow {
  const flavors: SearchResponseRow["flavors"] = {};
  for (const f of [...(filter ?? []), ...FLAVORS]) {
    const support = row.flavors[f];
    if (support === "yes" || support === "unknown") flavors[f] = support;
  }
  return {
    name: row.name,
    source: row.source,
    origin: row.origin,
    flavors,
    folders: row.folders,
    description: row.description ?? null,
    downloads: row.downloadsMonthly ?? null,
    stars: row.stars ?? null,
    updatedAt: row.updatedAt ?? null,
    url: row.url ?? null,
  };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function search(
  deps: SearchDeps,
  opts: { query: string; flavors?: Flavor[]; github: boolean; limit: number },
): Promise<{ rows: SearchResponseRow[]; warnings: string[] }> {
  const warnings: string[] = [];
  const query = opts.query.trim();
  if (!normaliseName(query)) return { rows: [], warnings };
  const [catalogue, github] = await Promise.all([
    catalogueCandidates(deps.db, query).catch((err) => {
      console.error("catalogue search failed", err);
      warnings.push("WoWInterface catalogue unavailable; showing the other sources.");
      return [];
    }),
    opts.github
      ? githubRows(deps, query).catch((err) => {
          warnings.push(`GitHub search failed: ${message(err)}`);
          return [];
        })
      : Promise.resolve([]),
  ]);
  const rows = [...registryRows(deps.registry), ...catalogue.map(catalogRow), ...github];
  const ranked = rankRows(rows, query, { flavors: opts.flavors, limit: opts.limit });
  return { rows: ranked.map((r) => responseRow(r, opts.flavors)), warnings };
}
