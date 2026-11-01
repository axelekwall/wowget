import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CACHE_MAX_BYTES, HttpClient, HttpStatusError } from "../src/core/http.ts";
import { openState, type State } from "../src/core/state.ts";
import { fakeFetch, json } from "./helpers/fetch.ts";
import { useTempDirs } from "./helpers/tmp.ts";

let state: State | undefined;
afterEach(() => {
  state?.close();
  state = undefined;
});

const tempDir = useTempDirs();

async function tempState(): Promise<State> {
  state = openState(join(await tempDir(), "state.db"));
  return state;
}

describe("HttpClient", () => {
  test("stores a response with an ETag and answers a 304 from the cache", async () => {
    const url = "https://example.com/data.json";
    const { fetch, requests } = fakeFetch({
      [url]: (req) => (req.headers.get("if-none-match") === '"v1"' ? new Response(null, { status: 304 }) : json({ a: 1 }, { etag: '"v1"' })),
    });
    const http = new HttpClient({ state: await tempState(), fetch, env: {} });

    expect(await http.getJson(url)).toEqual({ a: 1 });
    expect(await http.getJson(url)).toEqual({ a: 1 });
    expect(requests[0]!.headers.has("if-none-match")).toBe(false);
    expect(requests[1]!.headers.get("if-none-match")).toBe('"v1"');
    expect(state!.getCache(url)?.etag).toBe('"v1"');
  });

  test("bodies of 5 MB or more bypass the cache", async () => {
    const url = "https://example.com/big.bin";
    const { fetch, requests } = fakeFetch({
      [url]: () => new Response(new Uint8Array(CACHE_MAX_BYTES), { headers: { etag: '"big"' } }),
    });
    const http = new HttpClient({ state: await tempState(), fetch, env: {} });
    expect((await http.getBytes(url)).length).toBe(CACHE_MAX_BYTES);
    await http.getBytes(url);
    expect(requests[1]!.headers.has("if-none-match")).toBe(false);
    expect(state!.getCache(url)).toBeUndefined();
  });

  test("sends GITHUB_TOKEN to api.github.com only", async () => {
    const api = "https://api.github.com/repos/a/b/releases";
    const asset = "https://github.com/a/b/releases/download/v1/release.json";
    const { fetch, requests } = fakeFetch({ [api]: () => json([]), [asset]: () => json({}) });
    const http = new HttpClient({ fetch, env: { GITHUB_TOKEN: "t0ken" } });
    await http.getJson(api);
    await http.getJson(asset);
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer t0ken");
    expect(requests[1]!.headers.has("authorization")).toBe(false);
  });

  test("a non-OK status is an HttpStatusError with the status", async () => {
    const { fetch } = fakeFetch({});
    const err = await new HttpClient({ fetch, env: {} }).getBytes("https://example.com/missing").catch((e) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("network");
  });
});
