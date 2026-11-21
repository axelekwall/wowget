import { Hono, type Context, type MiddlewareHandler } from "hono";
import * as v from "valibot";
import { apiError } from "./api-error.ts";
import type { Env } from "./env.ts";
import { isFlavor, type Flavor } from "./flavor.ts";
import { registry, registryEtag, registryJson } from "./generated/registry.ts";
import type { FetchFn } from "./http.ts";
import { ipHash } from "./ratelimit.ts";
import { documentEntries } from "./registry.ts";
import { MAX_ITEMS, resolveItems, ResolveRequestSchema } from "./resolve.ts";
import { queryWords } from "./search/index.ts";
import { MAX_QUERY_WORDS, search } from "./search/service.ts";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUERY_LENGTH = 200;
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;

export interface AppOptions {
  /** Upstream fetch; tests pass a fake. */
  fetch?: FetchFn;
  now?: () => number;
}

async function allowed(c: Context<{ Bindings: Env }>, limiter: RateLimit): Promise<boolean> {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const key = await ipHash(ip, c.env.IP_HASH_SALT);
  return (await limiter.limit({ key })).success;
}

const tooMany = (c: Context<{ Bindings: Env }>) =>
  apiError(c, 429, "rate_limited", "Too many requests; try again in a minute.", { "Retry-After": "60" });

function limited(binding: (env: Env) => RateLimit): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (!(await allowed(c, binding(c.env)))) return tooMany(c);
    await next();
  };
}

function sameEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag);
}

export function createApp(options: AppOptions = {}) {
  const upstreamFetch: FetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const entries = documentEntries(registry);
  const bySource = new Map(entries.map((e) => [e.source.toLowerCase(), e]));
  const app = new Hono<{ Bindings: Env }>();

  app.get("/v1/version", async (c) => {
    const row = await c.env.DB.prepare("SELECT body FROM app_version WHERE id = 1").first<{ body: string }>();
    if (!row) return apiError(c, 404, "not_found", "No release has been published to the service yet.");
    return c.body(row.body, 200, { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "max-age=300" });
  });

  app.get("/v1/registry", (c) => {
    if (sameEtag(c.req.header("if-none-match"), registryEtag)) return c.body(null, 304, { ETag: registryEtag });
    return c.body(registryJson, 200, { "Content-Type": "application/json; charset=UTF-8", ETag: registryEtag });
  });

  app.post(
    "/v1/resolve",
    limited((env) => env.RESOLVE_LIMITER),
    async (c) => {
      const length = Number(c.req.header("content-length") ?? 0);
      if (length > MAX_BODY_BYTES) return apiError(c, 413, "too_large", `The request body is larger than ${MAX_BODY_BYTES} bytes.`);
      const text = await c.req.text();
      if (text.length > MAX_BODY_BYTES) return apiError(c, 413, "too_large", `The request body is larger than ${MAX_BODY_BYTES} bytes.`);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return apiError(c, 400, "bad_request", "The request body is not valid JSON.");
      }
      const parsed = v.safeParse(ResolveRequestSchema, body);
      if (!parsed.success) return apiError(c, 400, "bad_request", 'Expected { "items": [ ... ] }.');
      const { items } = parsed.output;
      if (items.length > MAX_ITEMS) return apiError(c, 413, "too_large", `At most ${MAX_ITEMS} items per request.`);

      const { results, upstreamRequests } = await resolveItems(items, {
        db: c.env.DB,
        fetch: upstreamFetch,
        githubToken: c.env.GITHUB_TOKEN || undefined,
        registry: bySource,
        now: options.now,
      });
      console.log(JSON.stringify({ event: "resolve", items: items.length, upstreamRequests }));
      return c.json({ results });
    },
  );

  app.get(
    "/v1/search",
    limited((env) => env.SEARCH_LIMITER),
    async (c) => {
      const query = (c.req.query("q") ?? "").trim();
      if (!/[\p{L}\p{N}]/u.test(query)) return apiError(c, 400, "bad_request", "q needs at least one letter or digit.");
      if (query.length > MAX_QUERY_LENGTH) return apiError(c, 400, "bad_request", `q is longer than ${MAX_QUERY_LENGTH} characters.`);
      if (new Set(queryWords(query)).size > MAX_QUERY_WORDS) {
        return apiError(c, 400, "bad_request", `q has more than ${MAX_QUERY_WORDS} distinct words.`);
      }

      let flavors: Flavor[] | undefined;
      const flavorParam = c.req.query("flavors");
      if (flavorParam) {
        const list = flavorParam.split(",").map((f) => f.trim()).filter(Boolean);
        const unknown = list.find((f) => !isFlavor(f));
        if (unknown !== undefined) return apiError(c, 400, "bad_request", `Unknown flavor "${unknown}".`);
        flavors = [...new Set(list)] as Flavor[];
      }

      const githubParam = c.req.query("github") ?? "0";
      if (githubParam !== "0" && githubParam !== "1") return apiError(c, 400, "bad_request", "github must be 0 or 1.");
      if (githubParam === "1" && !(await allowed(c, c.env.GITHUB_SEARCH_LIMITER))) return tooMany(c);

      const limitParam = c.req.query("limit");
      const limit = limitParam === undefined ? SEARCH_DEFAULT_LIMIT : Number(limitParam);
      if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
        return apiError(c, 400, "bad_request", `limit must be a whole number from 1 to ${SEARCH_MAX_LIMIT}.`);
      }

      const result = await search(
        { db: c.env.DB, fetch: upstreamFetch, githubToken: c.env.GITHUB_TOKEN || undefined, registry: entries, now: options.now },
        { query, flavors, github: githubParam === "1", limit },
      );
      return c.json(result);
    },
  );

  app.notFound((c) => apiError(c, 404, "not_found", "No such endpoint."));
  app.onError((err, c) => {
    console.error("request failed", err);
    return apiError(c, 500, "internal", "The service failed to handle the request.");
  });

  return app;
}

export default createApp();
