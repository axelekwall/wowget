import type { Flavor } from "../flavor.ts";
import { normaliseName } from "../registry.ts";
import type { Origin, SearchRow } from "./types.ts";

export type { Origin, SearchRow } from "./types.ts";

function tierFor(fields: string[], q: string, words: string[]): number | undefined {
  if (fields.some((f) => f === q)) return 1;
  if (fields.some((f) => f.startsWith(q))) return 2;
  if (fields.some((f) => f.includes(q))) return 3;
  if (words.length > 1 && words.every((w) => fields.some((f) => f.includes(w)))) return 4;
  return undefined;
}

/**
 * How well `row` matches the query, from 1 (exact) to 4 (every word somewhere), or undefined.
 * Names and aliases are compared first; a match on folder names only ranks half a tier lower.
 */
export function matchTier(row: SearchRow, query: string): number | undefined {
  const q = normaliseName(query);
  if (!q) return undefined;
  const words = query.split(/\s+/).map(normaliseName).filter(Boolean);
  const named = tierFor([row.name, ...row.aliases].map(normaliseName).filter(Boolean), q, words);
  const folders = tierFor(row.folders.map(normaliseName).filter(Boolean), q, words);
  if (named === undefined) return folders === undefined ? undefined : folders + 0.5;
  return folders === undefined ? named : Math.min(named, folders + 0.5);
}

const folderKey = (folders: string[]) => [...new Set(folders.map((f) => f.toLowerCase()))].sort().join("\0");

/**
 * Drops WoWInterface and GitHub rows that are the same addon as a registry row, and disabled
 * registry rows: the registry found their source installs on no flavor, whichever feed lists it.
 */
export function dedupe(rows: SearchRow[]): SearchRow[] {
  const registry = rows.filter((r) => r.origin === "registry");
  const sources = new Set(registry.map((r) => r.source.toLowerCase()));
  const folderSets = new Set(registry.map((r) => folderKey(r.folders)));
  return rows.filter((r) => {
    if (r.origin === "registry") return !r.disabled;
    if (sources.has(r.source.toLowerCase())) return false;
    return !(r.origin === "wowi" && r.folders.length && folderSets.has(folderKey(r.folders)));
  });
}

/** True when the row supports, or might support, one of `flavors`; always true without a filter. */
export function passesFlavors(row: SearchRow, flavors: Flavor[] | undefined): boolean {
  if (!flavors?.length) return true;
  return flavors.some((f) => row.flavors[f] === "yes" || row.flavors[f] === "unknown");
}

const ORIGIN_RANK: Record<Origin, number> = { registry: 0, wowi: 1, github: 2 };
const GITHUB_ONLY_TIER = 5;

/** Matches, filters, de-duplicates and sorts `rows`, returning at most `limit`. */
export function rankRows(rows: SearchRow[], query: string, opts: { flavors?: Flavor[]; limit: number }): SearchRow[] {
  const matched: { row: SearchRow; tier: number }[] = [];
  for (const row of dedupe(rows)) {
    if (!passesFlavors(row, opts.flavors)) continue;
    // GitHub already matched these on their description or topics; keep them after every other match.
    const tier = matchTier(row, query) ?? (row.origin === "github" ? GITHUB_ONLY_TIER : undefined);
    if (tier !== undefined) matched.push({ row, tier });
  }
  const popularity = (r: SearchRow) => r.downloadsMonthly ?? r.stars ?? 0;
  matched.sort(
    (a, b) =>
      a.tier - b.tier ||
      ORIGIN_RANK[a.row.origin] - ORIGIN_RANK[b.row.origin] ||
      (a.row.order ?? 0) - (b.row.order ?? 0) ||
      popularity(b.row) - popularity(a.row) ||
      a.row.name.toLowerCase().localeCompare(b.row.name.toLowerCase()),
  );
  return matched.slice(0, opts.limit).map((m) => m.row);
}
