import * as v from "valibot";
import { loadBundles, saveBundles } from "./cache.ts";
import { WowgetError } from "./errors.ts";
import { isFlavor, type Flavor } from "./flavor.ts";
import { CachedHttp, type FetchFn } from "./http.ts";
import type { RegistryEntry } from "./registry.ts";
import { githubSource } from "./sources/github.ts";
import { parseSource } from "./sources/parse.ts";
import type { Resolved, Source } from "./sources/types.ts";
import { wowiSource } from "./sources/wowi.ts";

export const MAX_ITEMS = 20;
export const RESOLVE_MAX_AGE_MS = 10 * 60 * 1000;

const ItemSchema = v.object({
  source: v.pipe(v.string(), v.maxLength(300)),
  flavor: v.string(),
  prerelease: v.optional(v.boolean(), false),
  pin: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(300))), null),
});

export const ResolveRequestSchema = v.object({ items: v.array(v.unknown()) });

export type ItemError = { code: "bad_request" | "source" | "flavor" | "upstream" | "internal"; message: string };

export type ResolveResult =
  | {
      ok: true;
      releaseId: string;
      version: string;
      filename: string;
      url: string;
      sha256: string | null;
      md5: string | null;
      size: number | null;
      publishedAt: string | null;
      flavorVerified: boolean;
      folders: string[] | null;
      defaultName: string | null;
      note: string | null;
    }
  | { ok: false; error: ItemError };

interface Job {
  index: number;
  source: Source;
  flavor: Flavor;
  prerelease: boolean;
  pin?: string;
  key: string;
}

export interface ResolveDeps {
  db: D1Database;
  fetch: FetchFn;
  githubToken?: string;
  /** Registry entries by lower-cased source, for `folders`. */
  registry: Map<string, RegistryEntry>;
  now?: () => number;
}

export interface ResolveOutcome {
  results: ResolveResult[];
  /** Requests sent to GitHub and WoWInterface while resolving. */
  upstreamRequests: number;
}

function itemError(err: unknown): ItemError {
  if (err instanceof WowgetError) {
    if (err.code === "source" || err.code === "flavor") return { code: err.code, message: err.message };
    return { code: "upstream", message: err.message };
  }
  console.error("resolve failed", err);
  return { code: "internal", message: "Resolving this item failed unexpectedly." };
}

function toResult(resolved: Resolved, registry: Map<string, RegistryEntry>): ResolveResult {
  return {
    ok: true,
    releaseId: resolved.releaseId,
    version: resolved.version,
    filename: resolved.filename,
    url: resolved.downloadUrl,
    sha256: resolved.sha256 ?? null,
    md5: resolved.md5 ?? null,
    size: resolved.size ?? null,
    publishedAt: resolved.publishedAt ?? null,
    flavorVerified: resolved.flavorVerified,
    folders: registry.get(resolved.source.toLowerCase())?.folders ?? null,
    defaultName: resolved.defaultName ?? null,
    note: resolved.note ?? null,
  };
}

/** Validates one request item into a job, or the reason it cannot be resolved. */
function prepare(raw: unknown, index: number): Job | ItemError {
  const parsed = v.safeParse(ItemSchema, raw);
  if (!parsed.success) {
    return { code: "bad_request", message: `Item ${index + 1}: ${parsed.issues[0]?.message ?? "invalid item"}.` };
  }
  const { source: raw_source, flavor, prerelease, pin } = parsed.output;
  if (!isFlavor(flavor)) return { code: "bad_request", message: `Unknown flavor "${flavor}".` };
  let source: Source;
  try {
    const spec = parseSource(raw_source);
    if (spec.kind === "url") return { code: "bad_request", message: "url: sources are resolved by the client." };
    source = spec.kind === "github" ? githubSource(spec) : wowiSource(spec);
  } catch (err) {
    return { code: "bad_request", message: err instanceof Error ? err.message : String(err) };
  }
  const key = JSON.stringify(["resolve", raw_source, prerelease, pin]);
  return { index, source, flavor, prerelease, pin: pin ?? undefined, key };
}

/**
 * Resolves each item against its cached upstream responses. Items sharing a (source,
 * prerelease, pin) key share one cache bundle, so several flavors of one addon cost the same
 * upstream requests as one.
 */
export async function resolveItems(items: unknown[], deps: ResolveDeps): Promise<ResolveOutcome> {
  const now = deps.now ?? Date.now;
  const results: ResolveResult[] = new Array(items.length);
  const jobs: Job[] = [];
  items.forEach((raw, index) => {
    const job = prepare(raw, index);
    if ("code" in job) results[index] = { ok: false, error: job };
    else jobs.push(job);
  });

  const keys = [...new Set(jobs.map((j) => j.key))];
  const bundles = await loadBundles(deps.db, keys);
  const clients = new Map(
    keys.map((key) => [
      key,
      new CachedHttp({
        fetch: deps.fetch,
        githubToken: deps.githubToken,
        bundle: bundles.get(key),
        maxAgeMs: RESOLVE_MAX_AGE_MS,
        now,
      }),
    ]),
  );

  await Promise.all(
    jobs.map(async (job) => {
      try {
        const resolved = await job.source.resolve({
          flavor: job.flavor,
          prerelease: job.prerelease,
          pin: job.pin,
          http: clients.get(job.key)!,
        });
        results[job.index] = toResult(resolved, deps.registry);
      } catch (err) {
        results[job.index] = { ok: false, error: itemError(err) };
      }
    }),
  );

  const dirty = [...clients].filter(([, http]) => http.dirty).map(([key, http]) => [key, http.bundle] as [string, typeof http.bundle]);
  try {
    await saveBundles(deps.db, dirty, now());
  } catch (err) {
    // The answers are already computed; a failed cache write only costs requests next time.
    console.error("saving the upstream cache failed", err);
  }
  const upstreamRequests = [...clients.values()].reduce((sum, http) => sum + http.requests, 0);
  return { results, upstreamRequests };
}
