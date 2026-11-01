import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openState, SCHEMA_VERSION } from "../src/core/state.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();

const base = {
  source: "github:Questie/Questie",
  filename: "Questie.zip",
  sha256: "ab".repeat(32),
  zipPath: "/cache/questie/v1/Questie.zip",
};

describe("openState", () => {
  test("creates the schema once and reopens without re-running migrations", async () => {
    const path = join(await tempDir(), "nested", "state.db");
    const first = openState(path);
    expect((first.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    first.recordInstall({ ...base, addon: "Questie", releaseId: "v1", folders: ["Questie"] });
    first.close();

    const second = openState(path);
    expect((second.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(second.getActiveInstall("questie")?.releaseId).toBe("v1");
    second.close();
  });

  test("migrates a version 1 database, keeping its rows", async () => {
    const path = join(await tempDir(), "state.db");
    const v1 = new Database(path, { create: true });
    v1.exec(`
      CREATE TABLE installs (
        id INTEGER PRIMARY KEY, addon TEXT NOT NULL, source TEXT NOT NULL, release_id TEXT NOT NULL,
        version TEXT, filename TEXT NOT NULL, sha256 TEXT NOT NULL, zip_path TEXT NOT NULL,
        installed_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX installs_active ON installs(addon) WHERE active = 1;
      CREATE TABLE install_folders (
        install_id INTEGER NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
        folder TEXT NOT NULL,
        PRIMARY KEY (install_id, folder)
      );
      CREATE TABLE http_cache (
        url TEXT PRIMARY KEY, etag TEXT, last_modified TEXT, body BLOB NOT NULL, fetched_at TEXT NOT NULL
      );
      INSERT INTO installs (id, addon, source, release_id, filename, sha256, zip_path, installed_at)
        VALUES (1, 'questie', 'github:Questie/Questie', 'v1', 'Questie.zip', 'ab', '/z', '2026-01-01T00:00:00Z');
      INSERT INTO install_folders (install_id, folder) VALUES (1, 'Questie');
      PRAGMA user_version = 1;
    `);
    v1.close();

    const state = openState(path);
    expect((state.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    const columns = (state.db.query("PRAGMA table_info(install_folders)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain("displaced");
    expect(state.getActiveInstall("Questie")).toMatchObject({ releaseId: "v1", folders: ["Questie"], displacedFolders: [] });
    expect(state.folderOwner("questie")).toBe("questie");
    state.close();
  });
});

describe("installs", () => {
  test("recordInstall deactivates the previous row and replaces the folder set", async () => {
    const state = openState(join(await tempDir(), "state.db"));
    const v1 = state.recordInstall({ ...base, addon: "Questie", releaseId: "v1", version: "1", folders: ["Questie", "QuestieExtra"] });
    const v2 = state.recordInstall({ ...base, addon: "QUESTIE", releaseId: "v2", folders: ["Questie"] });

    expect(v2.addon).toBe("questie");
    expect(v2.version).toBeNull();
    expect(state.getActiveInstall("Questie")).toEqual(v2);
    expect(state.listActiveInstalls()).toEqual([v2]);
    const old = state.db.query("SELECT active FROM installs WHERE id = ?").get(v1.id) as { active: number };
    expect(old.active).toBe(0);
    expect(state.folderOwner("questieextra")).toBeUndefined();
    expect(state.folderOwner("questie")).toBe("questie");
    state.close();
  });

  test("deactivateInstall clears the active install", async () => {
    const state = openState(join(await tempDir(), "state.db"));
    state.recordInstall({ ...base, addon: "Questie", releaseId: "v1", folders: ["Questie"] });
    expect(state.deactivateInstall("Questie")).toBe(true);
    expect(state.getActiveInstall("Questie")).toBeUndefined();
    expect(state.folderOwner("Questie")).toBeUndefined();
    expect(state.deactivateInstall("Questie")).toBe(false);
    state.close();
  });
});

describe("http cache", () => {
  test("put then get, and put overwrites", async () => {
    const state = openState(join(await tempDir(), "state.db"));
    expect(state.getCache("https://x")).toBeUndefined();
    state.putCache("https://x", { etag: '"a"', body: new Uint8Array([1, 2]) });
    state.putCache("https://x", { etag: '"b"', lastModified: "Sat, 01 Nov 2026 00:00:00 GMT", body: new Uint8Array([3]) });
    const entry = state.getCache("https://x");
    expect(entry?.etag).toBe('"b"');
    expect(entry?.lastModified).toBe("Sat, 01 Nov 2026 00:00:00 GMT");
    expect(entry?.body).toEqual(new Uint8Array([3]));
    state.close();
  });
});
