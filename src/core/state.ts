import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface InstallRecord {
  id: number;
  target: string;
  addon: string;
  source: string;
  releaseId: string;
  version: string | null;
  filename: string;
  sha256: string;
  zipPath: string;
  installedAt: string;
  active: boolean;
  folders: string[];
  /** Folders another addon took over with --force; they count as missing for this install. */
  displacedFolders: string[];
}

export interface NewInstall {
  target: string;
  addon: string;
  source: string;
  releaseId: string;
  version?: string | null;
  filename: string;
  sha256: string;
  zipPath: string;
  folders: string[];
  installedAt?: string;
}

export interface CacheEntry {
  url: string;
  etag: string | null;
  lastModified: string | null;
  body: Uint8Array;
  fetchedAt: string;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE installs (
    id INTEGER PRIMARY KEY,
    addon TEXT NOT NULL,
    source TEXT NOT NULL,
    release_id TEXT NOT NULL,
    version TEXT,
    filename TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    zip_path TEXT NOT NULL,
    installed_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX installs_active ON installs(addon) WHERE active = 1;

  CREATE TABLE install_folders (
    install_id INTEGER NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
    folder TEXT NOT NULL,
    PRIMARY KEY (install_id, folder)
  );

  CREATE TABLE http_cache (
    url TEXT PRIMARY KEY,
    etag TEXT,
    last_modified TEXT,
    body BLOB NOT NULL,
    fetched_at TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE install_folders ADD COLUMN displaced INTEGER NOT NULL DEFAULT 0;
  `,
  // Before targets existed, every install went to the Forever AddOns directory.
  `
  ALTER TABLE installs ADD COLUMN target TEXT NOT NULL DEFAULT 'forever';
  DROP INDEX installs_active;
  CREATE UNIQUE INDEX installs_active ON installs(target, addon) WHERE active = 1;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

interface InstallRow {
  id: number;
  target: string;
  addon: string;
  source: string;
  release_id: string;
  version: string | null;
  filename: string;
  sha256: string;
  zip_path: string;
  installed_at: string;
  active: number;
}

interface CacheRow {
  url: string;
  etag: string | null;
  last_modified: string | null;
  body: Uint8Array;
  fetched_at: string;
}

function migrate(db: Database): void {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
}

export class State {
  readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  private foldersOf(id: number, displaced: boolean): string[] {
    return (
      this.db
        .query("SELECT folder FROM install_folders WHERE install_id = ? AND displaced = ? ORDER BY folder")
        .all(id, displaced ? 1 : 0) as { folder: string }[]
    ).map((r) => r.folder);
  }

  private toRecord(row: InstallRow): InstallRecord {
    return {
      id: row.id,
      target: row.target,
      addon: row.addon,
      source: row.source,
      releaseId: row.release_id,
      version: row.version,
      filename: row.filename,
      sha256: row.sha256,
      zipPath: row.zip_path,
      installedAt: row.installed_at,
      active: row.active === 1,
      folders: this.foldersOf(row.id, false),
      displacedFolders: this.foldersOf(row.id, true),
    };
  }

  getActiveInstall(target: string, addon: string): InstallRecord | undefined {
    const row = this.db
      .query("SELECT * FROM installs WHERE target = ? AND addon = ? AND active = 1")
      .get(target, addon.toLowerCase()) as InstallRow | null;
    return row ? this.toRecord(row) : undefined;
  }

  /**
   * The most recent inactive install of `addon` on `target` whose release differs from the active
   * install, for rolling back.
   */
  getPreviousInstall(target: string, addon: string): InstallRecord | undefined {
    const active = this.getActiveInstall(target, addon);
    const row = (
      active
        ? this.db
            .query(
              `SELECT * FROM installs WHERE target = ? AND addon = ? AND active = 0 AND release_id != ?
               ORDER BY id DESC LIMIT 1`,
            )
            .get(target, addon.toLowerCase(), active.releaseId)
        : this.db
            .query("SELECT * FROM installs WHERE target = ? AND addon = ? AND active = 0 ORDER BY id DESC LIMIT 1")
            .get(target, addon.toLowerCase())
    ) as InstallRow | null;
    return row ? this.toRecord(row) : undefined;
  }

  /** Active installs on `target`, or on every target, ordered by addon then target. */
  listActiveInstalls(target?: string): InstallRecord[] {
    const rows = (
      target === undefined
        ? this.db.query("SELECT * FROM installs WHERE active = 1 ORDER BY addon, target").all()
        : this.db.query("SELECT * FROM installs WHERE active = 1 AND target = ? ORDER BY addon").all(target)
    ) as InstallRow[];
    return rows.map((r) => this.toRecord(r));
  }

  /**
   * Inserts the install and its folders and deactivates the previous active row on the same
   * target, in one transaction. With `releaseFromOthers`, other active installs on the target stop
   * owning its folders and record them as displaced.
   */
  recordInstall(install: NewInstall, options?: { releaseFromOthers?: boolean }): InstallRecord {
    const addon = install.addon.toLowerCase();
    const { target } = install;
    const id = this.db.transaction(() => {
      this.db.query("UPDATE installs SET active = 0 WHERE target = ? AND addon = ? AND active = 1").run(target, addon);
      if (options?.releaseFromOthers) this.releaseFolders(target, install.folders, addon);
      const result = this.db
        .query(
          `INSERT INTO installs (target, addon, source, release_id, version, filename, sha256, zip_path, installed_at, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          target,
          addon,
          install.source,
          install.releaseId,
          install.version ?? null,
          install.filename,
          install.sha256,
          install.zipPath,
          install.installedAt ?? new Date().toISOString(),
        );
      const insertFolder = this.db.query("INSERT INTO install_folders (install_id, folder) VALUES (?, ?)");
      for (const folder of new Set(install.folders)) insertFolder.run(result.lastInsertRowid, folder);
      return Number(result.lastInsertRowid);
    })();
    return this.toRecord(this.db.query("SELECT * FROM installs WHERE id = ?").get(id) as InstallRow);
  }

  /**
   * Marks `folders` (case-insensitively) as displaced in every active install on `target` except
   * `exceptAddon`'s.
   */
  releaseFolders(target: string, folders: string[], exceptAddon: string): void {
    const displace = this.db.query(
      `UPDATE install_folders SET displaced = 1 WHERE folder = ? COLLATE NOCASE
         AND install_id IN (SELECT id FROM installs WHERE active = 1 AND target = ? AND addon != ?)`,
    );
    this.db.transaction(() => {
      for (const folder of folders) displace.run(folder, target, exceptAddon.toLowerCase());
    })();
  }

  /** Returns true when there was an active install to deactivate. */
  deactivateInstall(target: string, addon: string): boolean {
    const result = this.db
      .query("UPDATE installs SET active = 0 WHERE target = ? AND addon = ? AND active = 1")
      .run(target, addon.toLowerCase());
    return result.changes > 0;
  }

  /**
   * Makes an inactive install active again, for rolling back a newer install of the same addon.
   * Throws if the addon already has an active install on that target.
   */
  reactivateInstall(id: number): void {
    this.db.query("UPDATE installs SET active = 1 WHERE id = ?").run(id);
  }

  /**
   * Addon names (lower-case) whose active install on `target` recorded `folder`, compared
   * case-insensitively. Displaced folders do not count.
   */
  folderOwners(target: string, folder: string): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT i.addon FROM installs i JOIN install_folders f ON f.install_id = i.id
         WHERE i.active = 1 AND i.target = ? AND f.displaced = 0 AND f.folder = ? COLLATE NOCASE ORDER BY i.addon`,
      )
      .all(target, folder) as { addon: string }[];
    return rows.map((r) => r.addon);
  }

  folderOwner(target: string, folder: string): string | undefined {
    return this.folderOwners(target, folder)[0];
  }

  getCache(url: string): CacheEntry | undefined {
    const row = this.db.query("SELECT * FROM http_cache WHERE url = ?").get(url) as CacheRow | null;
    if (!row) return undefined;
    return {
      url: row.url,
      etag: row.etag,
      lastModified: row.last_modified,
      body: new Uint8Array(row.body),
      fetchedAt: row.fetched_at,
    };
  }

  putCache(
    url: string,
    entry: { etag?: string | null; lastModified?: string | null; body: Uint8Array; fetchedAt?: string },
  ): void {
    this.db
      .query(
        `INSERT INTO http_cache (url, etag, last_modified, body, fetched_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified,
           body = excluded.body, fetched_at = excluded.fetched_at`,
      )
      .run(url, entry.etag ?? null, entry.lastModified ?? null, entry.body, entry.fetchedAt ?? new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}

/** Opens (creating if needed) the state database at `path` and runs pending migrations. */
export function openState(path: string): State {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return new State(db);
}
