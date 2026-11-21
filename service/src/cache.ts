import type { CacheBundle } from "./http.ts";

/** Bundle entries unused for longer are dropped when the bundle is written. */
const ENTRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Rows untouched for longer are deleted, a few at a time, whenever bundles are written. */
const ROW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** D1 rows hold at most 2 MB; a bundle that grows past this is not cached. */
const MAX_BUNDLE_BYTES = 1_000_000;

export async function loadBundles(db: D1Database, keys: string[]): Promise<Map<string, CacheBundle>> {
  const bundles = new Map<string, CacheBundle>();
  if (keys.length === 0) return bundles;
  const placeholders = keys.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT key, body FROM upstream_cache WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; body: string }>();
  for (const row of results) {
    try {
      const parsed: unknown = JSON.parse(row.body);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) bundles.set(row.key, parsed as CacheBundle);
    } catch {
      // An unreadable row is replaced on the next write.
    }
  }
  return bundles;
}

export async function saveBundles(db: D1Database, bundles: [string, CacheBundle][], now: number): Promise<void> {
  if (bundles.length === 0) return;
  const statements: D1PreparedStatement[] = [];
  for (const [key, bundle] of bundles) {
    const kept = Object.fromEntries(Object.entries(bundle).filter(([, e]) => now - e.fetchedAt < ENTRY_RETENTION_MS));
    const body = JSON.stringify(kept);
    if (body.length > MAX_BUNDLE_BYTES) continue;
    statements.push(
      db
        .prepare(
          "INSERT INTO upstream_cache (key, body, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
        )
        .bind(key, body, now),
    );
  }
  statements.push(
    db
      .prepare(
        "DELETE FROM upstream_cache WHERE key IN (SELECT key FROM upstream_cache WHERE updated_at < ? ORDER BY updated_at LIMIT 20)",
      )
      .bind(now - ROW_RETENTION_MS),
  );
  await db.batch(statements);
}
