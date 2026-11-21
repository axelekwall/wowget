import { loadBundles, saveBundles } from "../cache.ts";
import { FLAVORS, flavorMask, type Flavor } from "../flavor.ts";
import { CachedHttp, type FetchFn } from "../http.ts";
import { normaliseName, type RegistryEntry } from "../registry.ts";
import { searchGithub } from "./github-search.ts";
import { queryWords, rankRows } from "./index.ts";
import { registryRows } from "./registry.ts";
import type { SearchRow } from "./types.ts";
import { catalogRow, type CatalogEntry } from "./wowi-catalog.ts";

export const GITHUB_SEARCH_MAX_AGE_MS = 60 * 60 * 1000;
/**
 * The most distinct words a query may have. Every word filters the database lookup, since a
 * candidate cap applied after filtering on only some words could fill with rows that ranking
 * then drops, hiding real matches.
 */
export const MAX_QUERY_WORDS = 16;
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
/** D1 rejects LIKE patterns longer than this many bytes. */
const MAX_LIKE_PATTERN_BYTES = 50;
const likeFits = (pattern: string) => new TextEncoder().encode(pattern).length <= MAX_LIKE_PATTERN_BYTES;

type Condition = [sql: string, params: string[]];

// LIKE can use the trigram index; the substr and instr forms cover longer text, which is rare
// and selective, at the cost of scanning the index table.
const startsWith = (text: string): Condition =>
  likeFits(`${text}%`) ? ["search_text LIKE ?", [`${text}%`]] : ["substr(search_text, 1, length(?)) = ?", [text, text]];
const endsWith = (text: string): Condition =>
  likeFits(`%${text}`) ? ["search_text LIKE ?", [`%${text}`]] : ["substr(search_text, -length(?)) = ?", [text, text]];
const contains = (text: string): Condition =>
  likeFits(`%${text}%`) ? ["search_text LIKE ?", [`%${text}%`]] : ["instr(search_text, ?) > 0", [text]];

function any(...conditions: Condition[]): Condition {
  return [conditions.map(([sql]) => `(${sql})`).join(" OR "), conditions.flatMap(([, params]) => params)];
}

function all(...conditions: Condition[]): Condition {
  return [conditions.map(([sql]) => `(${sql})`).join(" AND "), conditions.flatMap(([, params]) => params)];
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
export async function catalogueCandidates(db: D1Database, query: string, flavors?: readonly Flavor[]): Promise<CatalogEntry[]> {
  const words = [...new Set(queryWords(query))];
  if (words.length > MAX_QUERY_WORDS) throw new RangeError(`A query may have at most ${MAX_QUERY_WORDS} distinct words.`);
  const q = normaliseName(query);
  if (words.length === 0 || !q) return [];
  const columns = "id, name, author, version, updated_at, downloads_monthly, versions, folders, url";
  // The flavor filter runs before the cap, or a broad query could fill the cap with rows for
  // other flavors that ranking then drops. Catalogue rows are "unknown" for Forever, so a filter
  // that includes Forever keeps every row.
  const mask = flavors?.length && !flavors.includes("forever") ? flavorMask(flavors) : 0;
  const flavorSql = mask ? " AND (flavors & ?) != 0" : "";
  const select = ([condition, params]: Condition) =>
    db
      .prepare(
        `SELECT ${columns} FROM catalogue WHERE id IN (SELECT rowid FROM catalogue_fts WHERE ${condition})${flavorSql}
         ORDER BY downloads_monthly DESC LIMIT ${MAX_CANDIDATES}`,
      )
      .bind(...params, ...(mask ? [mask] : []));
  // search_text separates the name and each folder with a space, so a field boundary is the
  // start, the end or a space.
  const results = await db.batch<CatalogueRow>([
    select(any(["search_text = ?", [q]], startsWith(`${q} `), endsWith(` ${q}`), contains(` ${q} `))),
    select(any(startsWith(q), contains(` ${q}`))),
    select(all(...words.map(contains))),
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
    catalogueCandidates(deps.db, query, opts.flavors).catch((err) => {
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
