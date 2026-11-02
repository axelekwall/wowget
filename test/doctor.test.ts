import { afterEach, describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clientBuildForAddonsDir, parseBuildInfo, pruneAddonCache, versionToInterface } from "../src/core/doctor.ts";
import * as ops from "../src/core/ops.ts";
import { openState, type State } from "../src/core/state.ts";
import { fakeFetch, json } from "./helpers/fetch.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const text = (s: string) => new TextEncoder().encode(s);

let state: State | undefined;
afterEach(() => {
  state?.close();
  state = undefined;
});
// Registered after the hook above so the database is closed before its directory is removed.
const tempDir = useTempDirs();

function makeZip(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, text(v)])),
    { mtime: new Date("2026-01-01T00:00:00Z") },
  );
}

describe("doctor helpers", () => {
  test("versionToInterface converts client versions to Interface numbers", () => {
    expect(versionToInterface("1.16.1.58123")).toBe(16001);
    expect(versionToInterface("1.16.2.58900")).toBe(16002);
    expect(versionToInterface("16.0.3.59000")).toBe(16003);
    expect(versionToInterface("1.15.7.60000")).toBe(11507);
    expect(versionToInterface("11.1.5.59000")).toBe(110105);
    expect(versionToInterface("not-a-version")).toBeUndefined();
  });

  test("parseBuildInfo extracts active product versions and clientBuildForAddonsDir reads .build.info", async () => {
    const buildInfo = [
      "Branch!STRING:0|Active!DEC:1|Version!STRING:0|Product!STRING:0",
      "us|1|1.16.2.58900|wowf",
      "us|0|1.16.1.58123|wowf",
      "us|1|1.15.7.60000|wow_classic_era",
      "us|1|11.1.5.59000|wow",
    ].join("\n");

    const parsed = parseBuildInfo(buildInfo);
    expect(parsed.get("wowf")).toEqual({ version: "1.16.2.58900", interfaceNumber: 16002 });
    expect(parsed.get("wow_classic_era")).toEqual({ version: "1.15.7.60000", interfaceNumber: 11507 });
    expect(parsed.get("wow")).toEqual({ version: "11.1.5.59000", interfaceNumber: 110105 });

    const root = await tempDir();
    const addonsDir = join(root, "_forever_", "Interface", "AddOns");
    await mkdir(addonsDir, { recursive: true });
    await writeFile(join(root, ".build.info"), buildInfo);
    await writeFile(join(root, "_forever_", ".flavor.info"), "Product Flavor!STRING:0\nwowf\n");

    expect(await clientBuildForAddonsDir(addonsDir)).toEqual({
      version: "1.16.2.58900",
      interfaceNumber: 16002,
    });
  });

  test("pruneAddonCache keeps active and rollback releases while deleting older cached releases", async () => {
    const root = await tempDir();
    state = openState(join(root, "state", "state.db"));
    const manifestPath = join(root, "config", "wowget.toml");
    const addons = join(root, "AddOns");
    const cacheDir = join(root, "cache");

    let currentTag = "v1";
    const zips: Record<string, Uint8Array> = {
      v1: makeZip({ "Questie/Questie_Forever.toc": "## Interface: 16001\n## Version: v1\n", "Questie/core.lua": "1" }),
      v2: makeZip({ "Questie/Questie_Forever.toc": "## Interface: 16001\n## Version: v2\n", "Questie/core.lua": "2" }),
      v3: makeZip({ "Questie/Questie_Forever.toc": "## Interface: 16001\n## Version: v3\n", "Questie/core.lua": "3" }),
    };

    const { fetch } = fakeFetch({
      "https://api.github.com/repos/Questie/Questie/releases?per_page=30": () =>
        json([
          {
            id: Number(currentTag.slice(1)),
            tag_name: currentTag,
            draft: false,
            prerelease: false,
            published_at: "2026-01-01T00:00:00Z",
            assets: [
              {
                name: `Questie-${currentTag}.zip`,
                size: zips[currentTag]!.byteLength,
                browser_download_url: `https://dl.example.test/${currentTag}.zip`,
              },
            ],
          },
        ]),
      "https://dl.example.test/v1.zip": () => new Response(zips.v1),
      "https://dl.example.test/v2.zip": () => new Response(zips.v2),
      "https://dl.example.test/v3.zip": () => new Response(zips.v3),
    });

    const opts: ops.OpsOptions = { manifestPath, state, cacheDir, fetch, env: {} };
    await ops.init({ manifestPath, path: addons });
    await ops.add({ ...opts, source: "github:Questie/Questie" });

    currentTag = "v2";
    await ops.update(opts);

    currentTag = "v3";
    await ops.update(opts);

    const cached = (await readdir(join(cacheDir, "questie"))).sort();
    expect(cached).toEqual(["v2", "v3"]);

    // Manual call on an already pruned cache returns empty.
    expect(await pruneAddonCache(cacheDir, state, "Questie")).toEqual([]);
  });

  test("pruneAddonCache never leaves the cache directory", async () => {
    const root = await tempDir();
    state = openState(join(root, "state.db"));
    const cacheDir = join(root, "caches", "wowget");
    await mkdir(join(root, "caches", "OtherApp"), { recursive: true });
    await mkdir(join(cacheDir, "other-addon", "v1"), { recursive: true });
    for (const name of ["..", "."]) await pruneAddonCache(cacheDir, state, name);
    expect((await readdir(join(root, "caches"))).sort()).toEqual(["OtherApp", "wowget"]);
    expect(await readdir(join(cacheDir, "other-addon"))).toEqual(["v1"]);
  });

  test("ops.doctor reports interface drift, missing folders, leftover temp dirs, and stale cache, and --clean removes them", async () => {
    const root = await tempDir();
    state = openState(join(root, "state", "state.db"));
    const manifestPath = join(root, "config", "wowget.toml");
    const addons = join(root, "_forever_", "Interface", "AddOns");
    const cacheDir = join(root, "cache");
    await mkdir(addons, { recursive: true });
    await writeFile(
      join(root, ".build.info"),
      "Branch!STRING:0|Active!DEC:1|Version!STRING:0|Product!STRING:0\nus|1|1.16.2.58900|wowf\n",
    );

    const zip = makeZip({
      "Questie/Questie_Forever.toc": "## Interface: 16001\n## Version: 1.0.0\n",
      "Questie_Config/Questie_Config_Forever.toc": "## Interface: 16001\n## Version: 1.0.0\n",
    });
    const { fetch } = fakeFetch({
      "https://api.github.com/repos/Questie/Questie/releases?per_page=30": () =>
        json([
          {
            id: 10,
            tag_name: "v1.0.0",
            draft: false,
            prerelease: false,
            published_at: "2026-01-01T00:00:00Z",
            assets: [{ name: "Questie.zip", size: zip.byteLength, browser_download_url: "https://dl.example.test/q.zip" }],
          },
        ]),
      "https://dl.example.test/q.zip": () => new Response(zip),
    });

    const opts: ops.OpsOptions = { manifestPath, state, cacheDir, fetch, env: {} };
    await ops.init({ manifestPath, path: addons });
    await ops.add({ ...opts, source: "github:Questie/Questie" });

    // Simulate missing companion folder, leftover swap folder, and orphan cache dir.
    await rm(join(addons, "Questie_Config"), { recursive: true, force: true });
    const leftoverDir = join(addons, ".wowget-old-12345");
    await mkdir(leftoverDir, { recursive: true });
    const orphanCacheDir = join(cacheDir, "orphan", "gh-release-999");
    await mkdir(orphanCacheDir, { recursive: true });

    const check = await ops.doctor({ ...opts, clean: false });
    expect(check.targets[0]?.clientVersion).toBe("1.16.2.58900");
    expect(check.targets[0]?.clientInterface).toBe(16002);
    expect(check.issues.map((i) => i.kind).sort()).toEqual([
      "interface_drift",
      "leftover_temp_dir",
      "missing_folders",
      "stale_cache",
    ]);
    expect(check.cleaned).toEqual([]);

    const cleaned = await ops.doctor({ ...opts, clean: true });
    expect(cleaned.cleaned.sort()).toEqual([leftoverDir, orphanCacheDir].sort());
    expect(cleaned.issues.map((i) => i.kind).sort()).toEqual(["interface_drift", "missing_folders"]);
  });
});
