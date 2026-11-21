import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { registry, registryEtag } from "../src/generated/registry.ts";
import { createApp } from "../src/index.ts";
import { ipHash } from "../src/ratelimit.ts";
import releaseJson from "./fixtures/release.json";
import releases from "./fixtures/releases.json";
import { fakeFetch, json } from "./helpers/fetch.ts";

const API = "https://api.github.com/repos/Questie/Questie/releases?per_page=30";
const DL = "https://github.com/Questie/Questie/releases/download";
const WOWI = "https://api.mmoui.com/v3/game/WOW/filedetails/7032.json";

function questieRoutes(etag = '"r1"') {
  return {
    [API]: (req: { headers: Headers }) =>
      req.headers.get("if-none-match") === etag ? new Response(null, { status: 304 }) : json(releases, { etag }),
    [`${DL}/v11.2.0/release.json`]: () => json(releaseJson),
    [WOWI]: () =>
      json([
        {
          UID: 7032,
          UIName: "TomTom",
          UIFileName: "TomTom-v4.2.zip",
          UIVersion: "v4.2",
          UIDownload: "https://cdn.wowinterface.com/downloads/getfile.php?id=7032",
          UIMD5: "0123456789abcdef0123456789abcdef",
        },
      ]),
  };
}

function post(app: ReturnType<typeof createApp>, body: unknown, testEnv: Cloudflare.Env = env) {
  return app.request(
    "/v1/resolve",
    { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } },
    testEnv,
  );
}

describe("POST /v1/resolve", () => {
  test("returns one result per item in order, with folders from the registry", async () => {
    let now = Date.parse("2026-11-21T10:00:00Z");
    const fake = fakeFetch(questieRoutes());
    const app = createApp({ fetch: fake.fetch, now: () => now });
    const res = await post(app, {
      items: [
        { source: "github:Questie/Questie", flavor: "forever" },
        { source: "github:Questie/Questie", flavor: "classic", prerelease: false, pin: null },
        { source: "wowi:7032", flavor: "classic" },
        { source: "url:https://example.com/a.zip", flavor: "classic" },
        { source: "github:Questie/Questie", flavor: "titan" },
        { source: 5 },
      ],
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: Record<string, unknown>[] };
    expect(results[0]).toEqual({
      ok: true,
      releaseId: "v11.2.0",
      version: "11.2.0",
      filename: "Questie-v11.2.0.zip",
      url: `${DL}/v11.2.0/Questie-v11.2.0.zip`,
      sha256: null,
      md5: null,
      size: null,
      publishedAt: "2026-10-20T12:00:00Z",
      flavorVerified: true,
      folders: registry.addons.find((a) => a.source === "github:Questie/Questie")!.folders,
      defaultName: null,
      note: null,
    });
    expect(results[1]).toMatchObject({ ok: true, filename: "Questie-v11.2.0-classic.zip" });
    expect(results[2]).toMatchObject({ ok: true, version: "4.2", md5: "0123456789abcdef0123456789abcdef", defaultName: "TomTom" });
    expect(results.slice(3).map((r) => (r.error as { code: string }).code)).toEqual(["bad_request", "bad_request", "bad_request"]);
    // Two flavors of one source share the release list and release.json.
    expect(fake.requests.map((r) => r.url).sort()).toEqual([`${DL}/v11.2.0/release.json`, API, WOWI].sort());

    // Within ten minutes nothing goes upstream; after that the release list is revalidated with its ETag.
    now += 5 * 60 * 1000;
    await post(app, { items: [{ source: "github:Questie/Questie", flavor: "forever" }] });
    expect(fake.requests).toHaveLength(3);
    now += 6 * 60 * 1000;
    const again = await post(app, { items: [{ source: "github:Questie/Questie", flavor: "forever" }] });
    expect(((await again.json()) as { results: { ok: boolean }[] }).results[0]!.ok).toBe(true);
    const revalidated = fake.requests.filter((r) => r.url === API);
    expect(revalidated).toHaveLength(2);
    expect(revalidated[1]!.headers.get("if-none-match")).toBe('"r1"');
  });

  test("errors are reported per item, with upstream failures as upstream", async () => {
    const fake = fakeFetch({ [API]: () => new Response("boom", { status: 502 }) });
    const res = await post(createApp({ fetch: fake.fetch }), {
      items: [
        { source: "github:Questie/Questie", flavor: "forever" },
        { source: "github:Nobody/Nothing", flavor: "forever" },
        { source: "github:Questie/Questie", flavor: "forever", pin: "" },
        { source: "github:Questie/Questie", flavor: "forever", pin: "../../../../users/x" },
      ],
    });
    const { results } = (await res.json()) as { results: { ok: boolean; error?: { code: string; message: string } }[] };
    expect(results.map((r) => r.error?.code)).toEqual(["upstream", "source", "bad_request", "bad_request"]);
    expect(fake.requests.some((r) => r.url.includes("users"))).toBe(false);
    expect(results[1]!.error!.message).toContain("Nobody/Nothing was not found");
  });

  test("the GitHub token is sent only to the GitHub API", async () => {
    const fake = fakeFetch(questieRoutes());
    await post(createApp({ fetch: fake.fetch }), { items: [{ source: "github:Questie/Questie", flavor: "forever", prerelease: true }] }, {
      ...env,
      GITHUB_TOKEN: "t0ken",
    });
    expect(fake.requests.find((r) => r.url === API)!.headers.get("authorization")).toBe("Bearer t0ken");
    expect(fake.requests.filter((r) => r.url !== API).every((r) => !r.headers.has("authorization"))).toBe(true);
  });

  test("rejects malformed requests and more than 20 items", async () => {
    const app = createApp({ fetch: fakeFetch({}).fetch });
    const bad = await post(app, "{");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: "bad_request", message: "The request body is not valid JSON." } });
    expect((await post(app, { nope: [] })).status).toBe(400);
    const many = await post(app, { items: Array.from({ length: 21 }, () => ({ source: "wowi:1", flavor: "classic" })) });
    expect(many.status).toBe(413);
    expect(((await many.json()) as { error: { code: string } }).error.code).toBe("too_large");
  });

  test("answers 429 with Retry-After when the rate limit is reached", async () => {
    const keys: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) };
    const res = await createApp({ fetch: fakeFetch({}).fetch }).request(
      "/v1/resolve",
      { method: "POST", body: '{"items":[]}', headers: { "cf-connecting-ip": "203.0.113.9" } },
      { ...env, RESOLVE_LIMITER: limiter },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(keys).toEqual([await ipHash("203.0.113.9", undefined)]);
    expect(keys[0]).not.toContain("203.0.113.9");
  });
});

describe("GET /v1/search", () => {
  const app = createApp({ fetch: fakeFetch({}).fetch });
  const get = (query: string) => app.request(`/v1/search${query}`, {}, env);

  test("searches the registry and validates its parameters", async () => {
    const res = await get("?q=questie&flavors=classic&limit=5");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: { name: string; origin: string }[]; warnings: string[] };
    expect(body.rows[0]).toMatchObject({ name: "Questie", origin: "registry" });
    expect(body.warnings).toEqual([]);

    const limiter = { limit: async () => ({ success: false }) };
    const githubLimited = await app.request("/v1/search?q=bags&github=1", {}, { ...env, GITHUB_SEARCH_LIMITER: limiter });
    expect(githubLimited.status).toBe(429);
    const withoutGithub = await app.request("/v1/search?q=bags", {}, { ...env, GITHUB_SEARCH_LIMITER: limiter });
    expect(withoutGithub.status).toBe(200);

    const tooManyWords = `?q=${Array.from({ length: 17 }, (_, i) => `w${i}`).join("%20")}`;
    for (const query of ["", "?q=%20", "?q=x&flavors=titan", "?q=x&limit=51", "?q=x&limit=0", "?q=x&github=2", tooManyWords]) {
      const bad = await get(query);
      expect(bad.status, query).toBe(400);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    }
  });
});

describe("GET /v1/registry and /v1/version", () => {
  const app = createApp({ fetch: fakeFetch({}).fetch });

  test("the registry has an ETag and answers 304 to it", async () => {
    const res = await app.request("/v1/registry", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(registryEtag);
    const body = (await res.json()) as typeof registry;
    expect(body.version).toBe(registry.version);
    expect(body.addons.length).toBeGreaterThan(50);
    expect(body.addons[0]).toEqual(expect.objectContaining({ aliases: expect.any(Array), description: null, disabled: null }));

    const cached = await app.request("/v1/registry", { headers: { "if-none-match": `W/"x", ${registryEtag}` } }, env);
    expect(cached.status).toBe(304);
  });

  test("version is not_found until a release is stored, then served with max-age", async () => {
    const missing = await app.request("/v1/version", {}, env);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("not_found");

    const body = JSON.stringify({ app: { version: "1.2.0" } });
    await env.DB.prepare("INSERT INTO app_version (id, body, updated_at) VALUES (1, ?, ?)").bind(body, "2026-11-21T00:00:00Z").run();
    const res = await app.request("/v1/version", {}, env);
    expect(res.headers.get("cache-control")).toBe("max-age=300");
    expect(await res.json()).toEqual({ app: { version: "1.2.0" } });
  });

  test("unknown paths are not_found", async () => {
    const res = await app.request("/v2/nothing", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "No such endpoint." } });
  });
});
