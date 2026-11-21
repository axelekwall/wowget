import { catalogFlavorMask, catalogSearchText, type CatalogEntry } from "../../src/search/wowi-catalog.ts";

export interface CatalogueDiff {
  /** True when `changed` is the whole catalogue and every other row goes. */
  full: boolean;
  changed: CatalogEntry[];
  removed: string[];
}

/** The first entry for each id, since the id is the catalogue table's key. */
export function uniqueById(entries: CatalogEntry[]): CatalogEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => !seen.has(e.id) && seen.add(e.id));
}

/**
 * What changed between two projections. Without a previous projection every entry is staged
 * and the import replaces the whole catalogue.
 */
export function diffCatalogue(previous: CatalogEntry[] | undefined, nextList: CatalogEntry[]): CatalogueDiff {
  const next = uniqueById(nextList);
  if (!previous) return { full: true, changed: next, removed: [] };
  const before = new Map(previous.map((e) => [e.id, JSON.stringify(e)]));
  const nextIds = new Set(next.map((e) => e.id));
  return {
    full: false,
    changed: next.filter((e) => before.get(e.id) !== JSON.stringify(e)),
    removed: [...before.keys()].filter((id) => !nextIds.has(id)),
  };
}

/** A SQL literal. NUL cannot appear in a SQLite text literal, so it is dropped. */
export function sqlValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`cannot write ${value} as SQL`);
    return String(value);
  }
  return `'${value.replaceAll("\0", "").replaceAll("'", "''")}'`;
}

const ROWS_PER_INSERT = 50;
const IDS_PER_INSERT = 200;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Statements that abandon unfinished imports, record this one and stage its rows. They change
 * nothing search reads; applySql does that in one statement.
 */
export function stagingSql(importId: string, diff: CatalogueDiff, entries: number, startedAt: string): string {
  const id = sqlValue(importId);
  const lines = [
    "UPDATE catalogue_imports SET status = 'abandoned' WHERE status = 'staging';",
    "DELETE FROM catalogue_staging WHERE import_id NOT IN (SELECT id FROM catalogue_imports WHERE status = 'staging');",
    "DELETE FROM catalogue_staging_removed WHERE import_id NOT IN (SELECT id FROM catalogue_imports WHERE status = 'staging');",
    `INSERT INTO catalogue_imports (id, status, full, entries, changed, removed, started_at) VALUES (${[
      id,
      "'staging'",
      diff.full ? 1 : 0,
      entries,
      diff.changed.length,
      diff.removed.length,
      sqlValue(startedAt),
    ].join(", ")});`,
  ];
  for (const chunk of chunks(diff.changed, ROWS_PER_INSERT)) {
    const rows = chunk.map(
      (e) =>
        `(${[
          id,
          Number(e.id),
          sqlValue(e.name),
          sqlValue(e.author),
          sqlValue(e.version),
          sqlValue(e.updatedAt),
          e.downloadsMonthly,
          sqlValue(JSON.stringify(e.versions)),
          catalogFlavorMask(e),
          sqlValue(JSON.stringify(e.folders)),
          sqlValue(e.url),
          sqlValue(catalogSearchText(e)),
        ].join(", ")})`,
    );
    lines.push(
      `INSERT INTO catalogue_staging (import_id, id, name, author, version, updated_at, downloads_monthly, versions, flavors, folders, url, search_text) VALUES\n${rows.join(",\n")};`,
    );
  }
  for (const chunk of chunks(diff.removed, IDS_PER_INSERT)) {
    lines.push(`INSERT INTO catalogue_staging_removed (import_id, id) VALUES ${chunk.map((r) => `(${id}, ${Number(r)})`).join(", ")};`);
  }
  return `${lines.join("\n")}\n`;
}

/** The one statement that applies a staged import (through the catalogue_import_apply trigger). */
export function applySql(importId: string, appliedAt: string): string {
  return `UPDATE catalogue_imports SET status = 'applied', applied_at = ${sqlValue(appliedAt)} WHERE id = ${sqlValue(importId)} AND status = 'staging';`;
}
