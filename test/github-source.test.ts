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
  releases: [{ filename: "Questie-v11.3.0-beta.zip", nolib: false, metadata: [{ flavor: "forever", interface: 16001 }] }],
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
