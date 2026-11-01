import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { HttpClient } from "../src/core/http.ts";
import { urlSource } from "../src/core/sources/url.ts";
import { fakeFetch } from "./helpers/fetch.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();
const URL_ = "https://example.com/files/MyAddon.zip";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const zip = (content: string) => zipSync({ "MyAddon/MyAddon.toc": new TextEncoder().encode(content) }, { mtime: new Date("2026-01-01T00:00:00Z") });
const zipV1 = zip("v1");
const zipV2 = zip("v2");

describe("url source", () => {
  test("200 saves the file under its hash, 304 reuses it, a new body gives a new release", async () => {
    let body = zipV1;
    const { fetch, requests } = fakeFetch({
      [URL_]: (req) =>
        req.headers.get("if-none-match") === `"${sha(body)}"`
          ? new Response(null, { status: 304 })
          : new Response(body, { headers: { etag: `"${sha(body)}"` } }),
    });
    const cacheDir = await tempDir();
    const http = new HttpClient({ fetch, env: {} });
    const source = urlSource({ raw: `url:${URL_}`, url: URL_ });
    const ctx = { addon: "MyAddon", flavor: "forever" as const, prerelease: false, http, cacheDir };

    const first = await source.resolve(ctx);
    const path = join(cacheDir, "myaddon", sha(zipV1), "MyAddon.zip");
    expect(first).toEqual({
      source: `url:${URL_}`,
      releaseId: sha(zipV1),
      version: sha(zipV1).slice(0, 12),
      filename: "MyAddon.zip",
      downloadUrl: URL_,
      flavorVerified: false,
      localPath: path,
    });
    expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(zipV1);

    expect(await source.resolve(ctx)).toEqual(first);
    expect(requests[1]!.headers.get("if-none-match")).toBe(`"${sha(zipV1)}"`);

    body = zipV2;
    expect((await source.resolve(ctx)).releaseId).toBe(sha(zipV2));
  });

  test("a cached file that disappeared is fetched again without validators", async () => {
    const { fetch, requests } = fakeFetch({ [URL_]: () => new Response(zipV1, { headers: { etag: '"e"' } }) });
    const cacheDir = await tempDir();
    const source = urlSource({ raw: `url:${URL_}`, url: URL_ });
    const ctx = { addon: "MyAddon", flavor: "forever" as const, prerelease: false, http: new HttpClient({ fetch, env: {} }), cacheDir };
    const first = await source.resolve(ctx);
    await rm(first.localPath!);
    expect(await source.resolve(ctx)).toEqual(first);
    expect(requests[1]!.headers.has("if-none-match")).toBe(false);
    expect(await Bun.file(first.localPath!).exists()).toBe(true);
  });

  test("a malformed escape in the URL keeps the raw filename", async () => {
    const url = "https://example.invalid/a%zz.zip";
    const { fetch } = fakeFetch({ [url]: () => new Response(zipV1) });
    const source = urlSource({ raw: `url:${url}`, url });
    const http = new HttpClient({ fetch, env: {} });
    const resolved = await source.resolve({ addon: "a", flavor: "forever", prerelease: false, http, cacheDir: await tempDir() });
    expect(resolved.filename).toBe("a%zz.zip");
  });

  test("a body that is not a zip is a zip error and is not cached", async () => {
    const { fetch } = fakeFetch({ [URL_]: () => new Response("<html>Sign in</html>", { headers: { etag: '"h"' } }) });
    const cacheDir = await tempDir();
    const http = new HttpClient({ fetch, env: {} });
    const source = urlSource({ raw: `url:${URL_}`, url: URL_ });
    const err = await source.resolve({ addon: "MyAddon", flavor: "forever", prerelease: false, http, cacheDir }).catch((e) => e);
    expect(err.code).toBe("zip");
    expect(err.message).toContain(URL_);
    expect(await readdir(cacheDir)).toEqual([]);
    expect(http.readRecord(`wowget:url-source:myaddon:${URL_}`)).toBeUndefined();
  });
});
