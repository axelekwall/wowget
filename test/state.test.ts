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
