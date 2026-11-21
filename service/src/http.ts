import { WowgetError } from "./errors.ts";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpStatusError extends WowgetError {
  readonly status: number;
  readonly headers: Headers;
  readonly url: string;

  constructor(url: string, response: Response) {
    super("network", `GET ${url} failed: HTTP ${response.status}.`);
    this.name = "HttpStatusError";
    this.status = response.status;
    this.headers = response.headers;
    this.url = url;
  }
}

export interface GetJsonOptions {
  headers?: Record<string, string>;
  /** Shrinks a fresh response before it is cached; a revalidated (304) copy is already shrunk. */
  project?: (data: unknown) => unknown;
}

export interface Http {
  getJson<T = unknown>(url: string, options?: GetJsonOptions): Promise<T>;
}

/** One cached upstream response: the (projected) JSON text and the validators it came with. */
export interface CacheEntry {
  etag: string | null;
  lastModified: string | null;
  body: string;
  /** Epoch ms of the last time upstream confirmed this body. */
  fetchedAt: number;
}

export type CacheBundle = Record<string, CacheEntry>;

export interface CachedHttpOptions {
  fetch: FetchFn;
  /** Sent to api.github.com only. */
  githubToken?: string;
  /** Entries already known for this cache key, keyed by URL; updated in place. */
  bundle?: CacheBundle;
  /** Entries younger than this are used without asking upstream. */
  maxAgeMs: number;
  now?: () => number;
}

/**
 * GETs JSON through a bundle of cached responses. A fresh entry costs no request; a stale one
 * is revalidated with its ETag or Last-Modified, so an unchanged upstream answers 304.
 */
export class CachedHttp implements Http {
  readonly bundle: CacheBundle;
  /** Requests sent upstream, for measurements and logs. */
  requests = 0;
  /** True when the bundle changed and should be written back. */
  dirty = false;
  private readonly opts: CachedHttpOptions;
  private readonly pending = new Map<string, Promise<string>>();

  constructor(opts: CachedHttpOptions) {
    this.opts = opts;
    this.bundle = opts.bundle ?? {};
  }

  async getJson<T = unknown>(url: string, options?: GetJsonOptions): Promise<T> {
    let text = this.pending.get(url);
    if (!text) {
      text = this.load(url, options);
      this.pending.set(url, text);
      text.finally(() => this.pending.delete(url)).catch(() => {});
    }
    const body = await text;
    try {
      return JSON.parse(body) as T;
    } catch (err) {
      throw new WowgetError("network", `GET ${url} returned invalid JSON.`, { cause: err });
    }
  }

  private async load(url: string, options?: GetJsonOptions): Promise<string> {
    const now = (this.opts.now ?? Date.now)();
    const cached = this.bundle[url];
    if (cached && now - cached.fetchedAt < this.opts.maxAgeMs) return cached.body;

    const headers: Record<string, string> = { "User-Agent": "wowget-service", ...options?.headers };
    if (this.opts.githubToken && new URL(url).hostname === "api.github.com") {
      headers.Authorization = `Bearer ${this.opts.githubToken}`;
    }
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;

    let response: Response;
    this.requests++;
    try {
      response = await this.opts.fetch(url, { headers, redirect: "follow" });
    } catch (err) {
      throw new WowgetError("network", `GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    if (response.status === 304 && cached && (cached.etag || cached.lastModified)) {
      cached.fetchedAt = now;
      this.dirty = true;
      return cached.body;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HttpStatusError(url, response);
    }
    const raw = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      // Not cached, so the caller sees the parse error on every attempt, as without a cache.
      return raw;
    }
    const body = options?.project ? JSON.stringify(options.project(data)) : raw;
    this.bundle[url] = {
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      body,
      fetchedAt: now,
    };
    this.dirty = true;
    return body;
  }
}
