import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Flavor } from "../src/core/flavor.ts";
import { HttpClient } from "../src/core/http.ts";
import { githubSource } from "../src/core/sources/github.ts";
import { parseSource } from "../src/core/sources/parse.ts";
import { fakeFetch, json } from "./helpers/fetch.ts";

const fixtures = join(import.meta.dir, "fixtures", "github");
const releases = await Bun.file(join(fixtures, "releases.json")).json();
const releaseJson = await Bun.file(join(fixtures, "release.json")).json();

const API = "https://api.github.com/repos/Questie/Questie/releases?per_page=30";
const DL = "https://github.com/Questie/Questie/releases/download";
const betaReleaseJson = {
  releases: [
    {
      version: "11.3.0-beta.2",
      filename: "Questie-v11.3.0-beta.zip",
      nolib: false,
      metadata: [{ flavor: "forever", interface: 16001 }],
    },
  ],
};

const source = githubSource({ raw: "github:Questie/Questie", owner: "Questie", repo: "Questie" });

function resolve(opts: { flavor?: Flavor; prerelease?: boolean; pin?: string } = {}, routes?: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(
    routes ?? {
      [API]: () => json(releases),
      [`${DL}/v11.2.0/release.json`]: () => json(releaseJson),
      [`${DL}/v11.3.0-beta/release.json`]: () => json(betaReleaseJson),
    },
  );
  const http = new HttpClient({ fetch: fake.fetch, env: {} });
  const result = source.resolve({
    addon: "Questie",
    flavor: opts.flavor ?? "forever",
    prerelease: opts.prerelease ?? false,
    pin: opts.pin,
    http,
    cacheDir: "/nonexistent",
  });
  return { result, requests: fake.requests };
}

describe("github source", () => {
  test("release.json picks the non-nolib zip for the flavor and marks it verified", async () => {
    const { result, requests } = resolve();
    expect(await result).toEqual({
      source: "github:Questie/Questie",
      releaseId: "v11.2.0",
      version: "11.2.0",
      filename: "Questie-v11.2.0.zip",
      downloadUrl: `${DL}/v11.2.0/Questie-v11.2.0.zip`,
      publishedAt: "2026-10-20T12:00:00Z",
      flavorVerified: true,
    });
    expect(requests[0]!.headers.get("accept")).toBe("application/vnd.github+json");
    expect((await resolve({ flavor: "classic" }).result).filename).toBe("Questie-v11.2.0-classic.zip");
  });

  test("without release.json, several zips are chosen by flavor name or rejected", async () => {
    const forever = await resolve({ pin: "v11.1.0" }).result;
    expect(forever.filename).toBe("Questie-v11.1.0-camelot.zip");
    expect(forever.flavorVerified).toBe(false);
    expect((await resolve({ pin: "v11.1.0", flavor: "classic" }).result).filename).toBe("Questie-v11.1.0-classic.zip");

    const err = await resolve({ pin: "v11.1.0", flavor: "mainline" }).result.catch((e) => e);
    expect(err.code).toBe("source");
    expect(err.message).toContain("Questie-v11.1.0-classic.zip, Questie-v11.1.0-camelot.zip, Questie-v11.1.0-wrath.zip");
  });

  test("version comes from the release.json entry when it has one, else from the tag", async () => {
    expect((await resolve({ prerelease: true }).result).version).toBe("11.3.0-beta.2");
    expect((await resolve({ flavor: "classic" }).result).version).toBe("11.2.0");
    expect((await resolve({ pin: "v11.1.0" }).result).version).toBe("11.1.0");
  });

  test("pre-releases are skipped unless allowed, drafts always", async () => {
    expect((await resolve().result).releaseId).toBe("v11.2.0");
    const beta = await resolve({ prerelease: true }).result;
    expect(beta.releaseId).toBe("v11.3.0-beta");
    expect(beta.filename).toBe("Questie-v11.3.0-beta.zip");
  });

  test("pin selects by tag and fails for unknown or draft tags", async () => {
    expect((await resolve({ pin: "v11.1.0" }).result).releaseId).toBe("v11.1.0");
    expect(await resolve({ pin: "v9.0.0" }).result.catch((e) => e.message)).toContain('no release tagged "v9.0.0"');
    expect((await resolve({ pin: "v11.2.1" }).result.catch((e) => e)).code).toBe("source");
  });

  test("a pin outside the newest releases is fetched by tag", async () => {
    const tagUrl = "https://api.github.com/repos/Questie/Questie/releases/tags/v10.0.0";
    const old = {
      tag_name: "v10.0.0",
      draft: false,
      prerelease: false,
      assets: [{ name: "Questie-v10.0.0.zip", browser_download_url: `${DL}/v10.0.0/Questie-v10.0.0.zip` }],
    };
    const resolved = await resolve({ pin: "v10.0.0" }, { [API]: () => json(releases), [tagUrl]: () => json(old) }).result;
    expect(resolved).toMatchObject({ releaseId: "v10.0.0", filename: "Questie-v10.0.0.zip", flavorVerified: false });

    const draft = await resolve({ pin: "v10.0.0" }, { [API]: () => json(releases), [tagUrl]: () => json({ ...old, draft: true }) })
      .result.catch((e) => e);
    expect(draft.message).toContain('no release tagged "v10.0.0"');
  });

  test("a release.json filename matches an asset after normalising, else the zips are chosen by name", async () => {
    const release = (assetName: string) => ({
      tag_name: "v1.0.0",
      draft: false,
      prerelease: false,
      assets: [
        { name: assetName, browser_download_url: `${DL}/v1.0.0/${assetName}` },
        { name: "release.json", browser_download_url: `${DL}/v1.0.0/release.json` },
      ],
    });
    const meta = { releases: [{ filename: "Questie v1.0.0.zip", nolib: false, metadata: [{ flavor: "forever" }] }] };
    const routes = (assetName: string) => ({
      [API]: () => json([release(assetName)]),
      [`${DL}/v1.0.0/release.json`]: () => json(meta),
    });

    const normalised = await resolve({}, routes("Questie.v1.0.0.zip")).result;
    expect(normalised).toMatchObject({ filename: "Questie.v1.0.0.zip", flavorVerified: true });

    const fallback = await resolve({}, routes("Other-1.0.0.zip")).result;
    expect(fallback).toMatchObject({ filename: "Other-1.0.0.zip", flavorVerified: false });
  });

  test("pages past a first page of pre-releases, up to 150 releases", async () => {
    const pre = (i: number) => ({ tag_name: `v2.0.0-beta.${i}`, draft: false, prerelease: true, assets: [] });
    const firstPage = Array.from({ length: 30 }, (_, i) => pre(i));
    const stable = {
      tag_name: "v1.0.0",
      draft: false,
      prerelease: false,
      assets: [{ name: "Questie.zip", browser_download_url: `${DL}/v1.0.0/Questie.zip` }],
    };
    const page = (n: number) => `${API}&page=${n}`;
    const found = await resolve({}, { [API]: () => json(firstPage), [page(2)]: () => json([pre(30), stable]) }).result;
    expect(found.releaseId).toBe("v1.0.0");

    const allPre = { [API]: () => json(firstPage), ...Object.fromEntries([2, 3, 4, 5].map((n) => [page(n), () => json(firstPage)])) };
    const { result, requests } = resolve({}, allPre);
    expect((await result.catch((e) => e)).message).toContain("newest 150");
    expect(requests.length).toBe(5);
  });

  test("a rate-limited response says to set GITHUB_TOKEN", async () => {
    const limited = () =>
      new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1793491200" } });
    const err = await resolve({}, { [API]: limited }).result.catch((e) => e);
    expect(err.code).toBe("rate_limited");
    expect(err.message).toContain("GITHUB_TOKEN");
  });

  test("an unknown repository is a source error", async () => {
    const err = await resolve({}, {}).result.catch((e) => e);
    expect(err.code).toBe("source");
    expect(err.message).toContain("Questie/Questie was not found");
  });

  test.skipIf(process.env.WOWGET_LIVE_TESTS !== "1")("live: resolves Questie for forever from release.json", async () => {
    const spec = parseSource("github:Questie/Questie");
    if (spec.kind !== "github") throw new Error("unreachable");
    const resolved = await githubSource(spec).resolve({
      addon: "Questie",
      flavor: "forever",
      prerelease: false,
      http: new HttpClient(),
      cacheDir: "/nonexistent",
    });
    expect(resolved.flavorVerified).toBe(true);
    expect(resolved.filename).toEndWith(".zip");
  });
});
