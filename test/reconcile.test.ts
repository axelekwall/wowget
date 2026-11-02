import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readManifest } from "../src/core/manifest.ts";
import * as ops from "../src/core/ops.ts";
import { detectSourceFromFields, scanUnmanaged } from "../src/core/reconcile.ts";
import { openState } from "../src/core/state.ts";
import { fakeFetch, json } from "./helpers/fetch.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();
const text = (s: string) => new TextEncoder().encode(s);

async function makeFolder(addonsDir: string, name: string, tocText: string): Promise<void> {
  const dir = join(addonsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.toc`), tocText);
}

describe("detectSourceFromFields", () => {
  test("recognises X-GitHub, GitHub URLs in X-Website and X-WoWI-ID", () => {
    expect(detectSourceFromFields({ "X-GitHub": "Questie/Questie" })).toBe("github:Questie/Questie");
    expect(detectSourceFromFields({ "X-Website": "https://github.com/WeakAuras/WeakAuras2.git" })).toBe(
      "github:WeakAuras/WeakAuras2",
    );
    expect(detectSourceFromFields({ "X-WoWI-ID": "26270" })).toBe("wowi:26270");
    expect(detectSourceFromFields({ "X-Website": "https://www.curseforge.com/wow/addons/foo" })).toBeNull();
  });
});

describe("reconcile", () => {
  test("groups companion folders by dependency or prefix and ignores managed folders", async () => {
    const root = await tempDir();
    const state = openState(join(root, "state", "state.db"));
    try {
      const addons = join(root, "AddOns");
      await makeFolder(addons, "Managed", "## Version: 1.0\n## X-GitHub: a/managed\n");
      state.recordInstall({
        target: "forever",
        addon: "Managed",
        source: "github:a/managed",
        releaseId: "v1",
        filename: "Managed.zip",
        sha256: "00",
        zipPath: "/z",
        folders: ["Managed"],
      });

      await makeFolder(addons, "Details", "## Version: 2.0\n## X-GitHub: Tercioo/Details-Damage-Meter\n");
      await makeFolder(addons, "Details_TinyThreat", "## Dependencies: Details\n");
      await makeFolder(addons, "Details_Streamer", "## Title: Streamer\n");
      await makeFolder(addons, "Mystery", "## Version: 0.1\n");

      const unmanaged = await scanUnmanaged(addons, "forever", state);
      expect(unmanaged).toEqual([
        {
          name: "Details",
          target: "forever",
          folders: ["Details", "Details_Streamer", "Details_TinyThreat"],
          version: "2.0",
          source: "github:Tercioo/Details-Damage-Meter",
        },
        {
          name: "Mystery",
          target: "forever",
          folders: ["Mystery"],
          version: "0.1",
          source: null,
        },
      ]);
    } finally {
      state.close();
    }
  });

  test("reconcile reports unmanaged addons and --adopt installs and records matched ones", async () => {
    const root = await tempDir();
    const state = openState(join(root, "state", "state.db"));
    try {
      const manifestPath = join(root, "wowget.toml");
      const addons = join(root, "AddOns");
      await ops.init({ manifestPath, path: addons });
      await makeFolder(addons, "Questie", "## Interface: 16001\n## Version: 11.1.0\n## X-GitHub: Questie/Questie\n");
      await makeFolder(addons, "Mystery", "## Interface: 16001\n## Version: 0.1\n");

      const report = await ops.reconcile({ manifestPath, state, cacheDir: join(root, "cache"), env: {} });
      expect(report.addons.map((a) => [a.name, a.status, a.source])).toEqual([
        ["Mystery", "unmatched", null],
        ["Questie", "unmanaged", "github:Questie/Questie"],
      ]);

      const releases = "https://api.github.com/repos/Questie/Questie/releases?per_page=30";
      const zipUrl = "https://github.com/Questie/Questie/releases/download/v11.2.0/Questie.zip";
      const fake = fakeFetch({
        [releases]: () =>
          json([{ tag_name: "v11.2.0", draft: false, prerelease: false, assets: [{ name: "Questie.zip", browser_download_url: zipUrl }] }]),
        [zipUrl]: () =>
          new Response(zipSync({ "Questie/Questie_Forever.toc": text("## Version: 11.2.0\n"), "Questie/core.lua": text("adopted") })),
      });

      const adopted = await ops.reconcile({
        manifestPath,
        state,
        cacheDir: join(root, "cache"),
        fetch: fake.fetch,
        env: {},
        adopt: true,
      });
      expect(adopted.addons).toEqual([
        {
          name: "Mystery",
          target: "forever",
          folders: ["Mystery"],
          version: "0.1",
          source: null,
          status: "unmatched",
        },
        {
          name: "Questie",
          target: "forever",
          folders: ["Questie"],
          version: "11.2.0",
          source: "github:Questie/Questie",
          status: "adopted",
        },
      ]);
      expect((await readManifest(manifestPath)).addons).toEqual([
        { name: "Questie", source: "github:Questie/Questie", prerelease: false },
      ]);
      expect(await readFile(join(addons, "Questie", "core.lua"), "utf8")).toBe("adopted");
      expect(state.folderOwners("forever", "Questie")).toEqual(["questie"]);
    } finally {
      state.close();
    }
  });
});
