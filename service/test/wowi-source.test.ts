import { describe, expect, test } from "vitest";
import { CachedHttp } from "../src/http.ts";
import { RESOLVE_MAX_AGE_MS } from "../src/resolve.ts";
import { wowiSource } from "../src/sources/wowi.ts";
import { fakeFetch, json } from "./helpers/fetch.ts";

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

function httpFor(routes: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(routes);
  return { http: new CachedHttp({ fetch: fake.fetch, maxAgeMs: RESOLVE_MAX_AGE_MS }), requests: fake.requests };
}

const src = wowiSource({ raw: "wowi:26270", id: "26270" });

describe("wowi source", () => {
  test("resolves file details and strips the version suffix for defaultName", async () => {
    const { http } = httpFor({ [API]: () => json(sampleDetails) });
    const resolved = await src.resolve({ flavor: "forever", prerelease: false, http });
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
    const { http } = httpFor({ [API]: () => json(sampleDetails) });
    const ok = await src.resolve({ flavor: "forever", prerelease: false, pin: "1.15.107", http });
    expect(ok.releaseId).toBe("1.15.107");

    const mismatch = await src.resolve({ flavor: "forever", prerelease: false, pin: "1.15.100", http }).catch((e) => e);
    expect(mismatch.code).toBe("source");
    expect(mismatch.message).toContain('pinned to "1.15.100"');
  });

  test("falls back to the display name or the id when the file name is not a usable addon name", async () => {
    const resolveWith = async (details: Record<string, unknown>) => {
      const { http } = httpFor({ [API]: () => json([{ ...sampleDetails[0], ...details }]) });
      return src.resolve({ flavor: "forever", prerelease: false, http });
    };
    expect((await resolveWith({ UIFileName: "...zip" })).defaultName).toBe("Leatrix Plus");
    expect((await resolveWith({ UIFileName: "...zip", UIName: ".." })).defaultName).toBe("wowi-26270");
  });

  test("returns the MD5 only when it is well formed", async () => {
    const md5 = "0123456789abcdef0123456789abcdef";
    const withMd5 = httpFor({ [API]: () => json([{ ...sampleDetails[0], UIMD5: md5 }]) });
    expect((await src.resolve({ flavor: "classic", prerelease: false, http: withMd5.http })).md5).toBe(md5);
    const bad = httpFor({ [API]: () => json([{ ...sampleDetails[0], UIMD5: "nope" }]) });
    expect((await src.resolve({ flavor: "classic", prerelease: false, http: bad.http })).md5).toBeUndefined();
  });

  test("a 404 is a source error naming the addon id", async () => {
    const { http } = httpFor({});
    const err = await wowiSource({ raw: "wowi:99999", id: "99999" })
      .resolve({ flavor: "forever", prerelease: false, http })
      .catch((e) => e);
    expect(err.code).toBe("source");
    expect(err.message).toContain("99999 was not found");
  });

  test("a response without a version or download is a source error", async () => {
    const { http } = httpFor({ [API]: () => json([{ UID: 26270, UIName: "Leatrix Plus" }]) });
    const err = await src.resolve({ flavor: "forever", prerelease: false, http }).catch((e) => e);
    expect(err.code).toBe("source");
    expect(err.message).toContain("no downloadable release");
  });
});
