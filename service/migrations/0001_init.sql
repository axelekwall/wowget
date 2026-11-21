-- The release metadata /v1/version serves, as the JSON body. One row.
CREATE TABLE app_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Upstream responses for /v1/resolve (key: source, prerelease, pin) and GitHub search
-- (key: query). body is a JSON object of URL -> { etag, lastModified, body, fetchedAt }.
CREATE TABLE upstream_cache (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX upstream_cache_updated ON upstream_cache (updated_at);

-- The WoWInterface catalogue, as projected in SPEC-SEARCH.md. versions and folders are JSON
-- arrays; search_text is the normalised name and folder names, space-separated.
CREATE TABLE catalogue (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  author TEXT,
  version TEXT,
  updated_at TEXT,
  downloads_monthly INTEGER NOT NULL DEFAULT 0,
  versions TEXT NOT NULL DEFAULT '[]',
  folders TEXT NOT NULL DEFAULT '[]',
  url TEXT,
  search_text TEXT NOT NULL
);

-- Substring search over search_text: the trigram tokenizer serves LIKE '%word%' from the index
-- for words of three or more characters.
CREATE VIRTUAL TABLE catalogue_fts USING fts5(
  search_text,
  content = 'catalogue',
  content_rowid = 'id',
  tokenize = 'trigram'
);

CREATE TRIGGER catalogue_fts_insert AFTER INSERT ON catalogue BEGIN
  INSERT INTO catalogue_fts (rowid, search_text) VALUES (new.id, new.search_text);
END;
CREATE TRIGGER catalogue_fts_delete AFTER DELETE ON catalogue BEGIN
  INSERT INTO catalogue_fts (catalogue_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
END;
CREATE TRIGGER catalogue_fts_update AFTER UPDATE ON catalogue BEGIN
  INSERT INTO catalogue_fts (catalogue_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
  INSERT INTO catalogue_fts (rowid, search_text) VALUES (new.id, new.search_text);
END;

-- Catalogue imports. An import stages its changed rows and removed ids, then applies them by
-- moving its status from 'staging' to 'applied' (see catalogue_import_apply). full = 1 means
-- the staged rows are the whole catalogue, so every other row is removed.
CREATE TABLE catalogue_imports (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('staging', 'applied', 'abandoned')),
  full INTEGER NOT NULL DEFAULT 0,
  entries INTEGER NOT NULL,
  changed INTEGER NOT NULL,
  removed INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE TABLE catalogue_staging (
  import_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  name TEXT NOT NULL,
  author TEXT,
  version TEXT,
  updated_at TEXT,
  downloads_monthly INTEGER NOT NULL DEFAULT 0,
  versions TEXT NOT NULL DEFAULT '[]',
  folders TEXT NOT NULL DEFAULT '[]',
  url TEXT,
  search_text TEXT NOT NULL,
  PRIMARY KEY (import_id, id)
);

CREATE TABLE catalogue_staging_removed (
  import_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  PRIMARY KEY (import_id, id)
);

-- A single UPDATE statement, with everything its trigger does, is atomic in SQLite. Applying an
-- import through this trigger therefore replaces the catalogue in one step even when the
-- statement is sent with `wrangler d1 execute`, which offers no transaction.
CREATE TRIGGER catalogue_import_apply AFTER UPDATE OF status ON catalogue_imports
WHEN old.status = 'staging' AND new.status = 'applied'
BEGIN
  DELETE FROM catalogue
  WHERE new.full = 1 AND id NOT IN (SELECT id FROM catalogue_staging WHERE import_id = new.id);
  DELETE FROM catalogue
  WHERE id IN (SELECT id FROM catalogue_staging_removed WHERE import_id = new.id);
  INSERT INTO catalogue (id, name, author, version, updated_at, downloads_monthly, versions, folders, url, search_text)
  SELECT id, name, author, version, updated_at, downloads_monthly, versions, folders, url, search_text
  FROM catalogue_staging WHERE import_id = new.id
  ON CONFLICT (id) DO UPDATE SET
    name = excluded.name,
    author = excluded.author,
    version = excluded.version,
    updated_at = excluded.updated_at,
    downloads_monthly = excluded.downloads_monthly,
    versions = excluded.versions,
    folders = excluded.folders,
    url = excluded.url,
    search_text = excluded.search_text;
  DELETE FROM catalogue_staging WHERE import_id = new.id;
  DELETE FROM catalogue_staging_removed WHERE import_id = new.id;
END;
