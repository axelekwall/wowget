import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { HttpClient } from "../src/core/http.ts";
import { urlSource } from "../src/core/sources/url.ts";
import { fakeFetch } from "./helpers/fetch.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();
const URL_ = "https://example.com/files/MyAddon.zip";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("url source", () => {
  test("200 saves the file under its hash, 304 reuses it, a new body gives a new release", async () => {
    let body = "zip-v1";
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
    const path = join(cacheDir, "myaddon", sha("zip-v1"), "MyAddon.zip");
    expect(first).toEqual({
      source: `url:${URL_}`,
      releaseId: sha("zip-v1"),
      version: sha("zip-v1").slice(0, 12),
      filename: "MyAddon.zip",
      downloadUrl: URL_,
      flavorVerified: false,
      localPath: path,
    });
    expect(await Bun.file(path).text()).toBe("zip-v1");

    expect(await source.resolve(ctx)).toEqual(first);
    expect(requests[1]!.headers.get("if-none-match")).toBe(`"${sha("zip-v1")}"`);

    body = "zip-v2";
    expect((await source.resolve(ctx)).releaseId).toBe(sha("zip-v2"));
  });

  test("a cached file that disappeared is fetched again without validators", async () => {
    const { fetch, requests } = fakeFetch({ [URL_]: () => new Response("zip", { headers: { etag: '"e"' } }) });
    const cacheDir = await tempDir();
    const source = urlSource({ raw: `url:${URL_}`, url: URL_ });
    const ctx = { addon: "MyAddon", flavor: "forever" as const, prerelease: false, http: new HttpClient({ fetch, env: {} }), cacheDir };
    const first = await source.resolve(ctx);
    await rm(first.localPath!);
    expect(await source.resolve(ctx)).toEqual(first);
    expect(requests[1]!.headers.has("if-none-match")).toBe(false);
    expect(await Bun.file(first.localPath!).exists()).toBe(true);
  });
});
