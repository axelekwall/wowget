import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpClient } from "../src/core/http.ts";
import { readManifest } from "../src/core/manifest.ts";
import * as ops from "../src/core/ops.ts";
import { wowiSource } from "../src/core/sources/wowi.ts";
import { openState } from "../src/core/state.ts";
import { fakeFetch, json } from "./helpers/fetch.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();
const API = "https://api.mmoui.com/v3/game/WOW/filedetails/26270.json";
const DL = "https://cdn.wowinterface.com/downloads/getfile.php?id=26270";

const sampleDetails = [
  {
    UID: 26270,
    UIName: "Leatrix Plus",
    UIFileName: "Leatrix_Plus-1.15.107.zip",
    UIVersion: "1.15.107",
    UIDate: 1730000000000,
    UIDownload: DL,
  },
];

describe("wowi source", () => {
  test("resolves file details and strips the version suffix for defaultName", async () => {
    const fake = fakeFetch({ [API]: () => json(sampleDetails) });
    const http = new HttpClient({ fetch: fake.fetch, env: {} });
    const resolved = await wowiSource({ raw: "wowi:26270", id: "26270" }).resolve({
      addon: "wowi-26270",
      flavor: "forever",
      prerelease: false,
      http,
      cacheDir: "/nonexistent",
    });
    expect(resolved).toEqual({
      source: "wowi:26270",
      releaseId: "1.15.107",
      version: "1.15.107",
      filename: "Leatrix_Plus-1.15.107.zip",
      downloadUrl: DL,
      publishedAt: new Date(1730000000000).toISOString(),
      flavorVerified: false,
      defaultName: "Leatrix_Plus",
    });
  });

  test("honours a matching pin and rejects a mismatched one", async () => {
    const fake = fakeFetch({ [API]: () => json(sampleDetails) });
    const http = new HttpClient({ fetch: fake.fetch, env: {} });
    const src = wowiSource({ raw: "wowi:26270", id: "26270" });
    const ok = await src.resolve({ addon: "Leatrix_Plus", flavor: "forever", prerelease: false, pin: "1.15.107", http, cacheDir: "/nonexistent" });
    expect(ok.releaseId).toBe("1.15.107");

    const mismatch = await src
      .resolve({ addon: "Leatrix_Plus", flavor: "forever", prerelease: false, pin: "1.15.100", http, cacheDir: "/nonexistent" })
      .catch((e) => e);
    expect(mismatch.code).toBe("source");
    expect(mismatch.message).toContain('pinned to "1.15.100"');
  });

  test("falls back to the display name or the id when the file name is not a usable addon name", async () => {
    const resolveWith = async (details: Record<string, unknown>) => {
      const fake = fakeFetch({ [API]: () => json([{ ...sampleDetails[0], ...details }]) });
      const http = new HttpClient({ fetch: fake.fetch, env: {} });
      return wowiSource({ raw: "wowi:26270", id: "26270" }).resolve({ addon: "x", flavor: "forever", prerelease: false, http, cacheDir: "/nonexistent" });
    };
    expect((await resolveWith({ UIFileName: "...zip" })).defaultName).toBe("Leatrix Plus");
    expect((await resolveWith({ UIFileName: "...zip", UIName: ".." })).defaultName).toBe("wowi-26270");
  });

  test("a 404 is a source error naming the addon id", async () => {
    const fake = fakeFetch({});
    const http = new HttpClient({ fetch: fake.fetch, env: {} });
    const err = await wowiSource({ raw: "wowi:99999", id: "99999" })
      .resolve({ addon: "x", flavor: "forever", prerelease: false, http, cacheDir: "/nonexistent" })
      .catch((e) => e);
    expect(err.code).toBe("source");
    expect(err.message).toContain("99999 was not found");
  });

  test("ops.add with wowi:<id> uses the resolved defaultName when --name is omitted", async () => {
    const root = await tempDir();
    const state = openState(join(root, "state", "state.db"));
    try {
      const manifestPath = join(root, "wowget.toml");
      const addons = join(root, "AddOns");
      await ops.init({ manifestPath, path: addons });
      const text = (s: string) => new TextEncoder().encode(s);
      const fake = fakeFetch({
        [API]: () => json(sampleDetails),
        [DL]: () => new Response(zipSync({ "Leatrix_Plus/Leatrix_Plus_Forever.toc": text(""), "Leatrix_Plus/core.lua": text("ltp") })),
      });
      const added = await ops.add({
        manifestPath,
        state,
        cacheDir: join(root, "cache"),
        fetch: fake.fetch,
        env: {},
        source: "wowi:26270",
      });
      expect(added.name).toBe("Leatrix_Plus");
      expect((await readManifest(manifestPath)).addons).toEqual([
        { name: "Leatrix_Plus", source: "wowi:26270", prerelease: false },
      ]);
      expect(await readFile(join(addons, "Leatrix_Plus", "core.lua"), "utf8")).toBe("ltp");
      // The metadata endpoint is fetched only once during add.
      expect(fake.requests.filter((r) => r.url === API)).toHaveLength(1);
    } finally {
      state.close();
    }
  });

  test("a download must match the MD5 WoWInterface lists", async () => {
    const root = await tempDir();
    const state = openState(join(root, "state", "state.db"));
    try {
      const manifestPath = join(root, "wowget.toml");
      const addons = join(root, "AddOns");
      await ops.init({ manifestPath, path: addons });
      const text = (s: string) => new TextEncoder().encode(s);
      const zip = zipSync({ "Leatrix_Plus/Leatrix_Plus_Forever.toc": text(""), "Leatrix_Plus/core.lua": text("ltp") });
      const md5 = createHash("md5").update(zip).digest("hex");
      const addWith = (UIMD5: string) => {
        const fake = fakeFetch({ [API]: () => json([{ ...sampleDetails[0], UIMD5 }]), [DL]: () => new Response(zip) });
        return ops.add({ manifestPath, state, cacheDir: join(root, "cache"), fetch: fake.fetch, env: {}, source: "wowi:26270" });
      };

      const wrong = await addWith("0".repeat(32)).catch((e) => e);
      expect(wrong.code).toBe("network");
      expect(wrong.message).toContain("MD5");
      expect(await readdir(addons)).toEqual([]);
      expect((await readManifest(manifestPath)).addons).toEqual([]);

      expect((await addWith(md5)).name).toBe("Leatrix_Plus");
      expect(await readFile(join(addons, "Leatrix_Plus", "core.lua"), "utf8")).toBe("ltp");
    } finally {
      state.close();
    }
  });

  test("a web page served for a file awaiting approval is reported as that, not as a bad checksum", async () => {
    const root = await tempDir();
    const state = openState(join(root, "state", "state.db"));
    try {
      const manifestPath = join(root, "wowget.toml");
      const addons = join(root, "AddOns");
      await ops.init({ manifestPath, path: addons });
      const page = "<!DOCTYPE html>\n<html><head><title>World of Warcraft AddOns</title></head>"
        + "<body>This file has not yet been approved for download!!</body></html>";
      const fake = fakeFetch({
        [API]: () => json([{ ...sampleDetails[0], UIMD5: "0".repeat(32) }]),
        [DL]: () => new Response(page, { headers: { "content-type": "text/html; charset=ISO-8859-1" } }),
      });
      const cacheDir = join(root, "cache");
      const err = await ops
        .add({ manifestPath, state, cacheDir, fetch: fake.fetch, env: {}, source: "wowi:26270" })
        .catch((e) => e);
      expect(err.code).toBe("network");
      expect(err.message).toBe(
        "WoWInterface served a web page instead of Leatrix_Plus-1.15.107.zip; the new version is probably still awaiting approval there. Try again later.",
      );
      expect(await readdir(addons)).toEqual([]);
      expect(await readdir(cacheDir, { recursive: true })).not.toContain(expect.stringContaining(".zip"));
    } finally {
      state.close();
    }
  });
});
