import { WowgetError } from "./errors.ts";
import type { CacheRecord, ConditionalResult, Http, HttpRequestOptions, Validators } from "./sources/types.ts";
import type { State } from "./state.ts";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type Env = Record<string, string | undefined>;

/** Bodies of this size or larger are not stored in the cache. */
export const CACHE_MAX_BYTES = 5 * 1024 * 1024;

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

export interface HttpClientOptions {
  /** Without a state the ETag cache and records live in memory for the client's lifetime. */
  state?: State;
  fetch?: FetchFn;
  /** Read for GITHUB_TOKEN. */
  env?: Env;
}

export class HttpClient implements Http {
  private readonly state?: State;
  private readonly fetchFn: FetchFn;
  private readonly env: Env;
  private readonly memory = new Map<string, CacheRecord>();

  constructor(options: HttpClientOptions = {}) {
    this.state = options.state;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.env = options.env ?? process.env;
  }

  readRecord(key: string): CacheRecord | undefined {
    if (!this.state) return this.memory.get(key);
    const entry = this.state.getCache(key);
    return entry ? { etag: entry.etag, lastModified: entry.lastModified, body: entry.body } : undefined;
  }

  writeRecord(key: string, record: CacheRecord): void {
    if (this.state) this.state.putCache(key, record);
    else this.memory.set(key, record);
  }

  async getBytes(url: string, options?: HttpRequestOptions): Promise<Uint8Array> {
    const cached = this.readRecord(url);
    const result = await this.getConditional(url, cached ?? {}, options);
    if (result.notModified && cached) return cached.body;
    const body = result.body!;
    if (body.length < CACHE_MAX_BYTES && (result.etag || result.lastModified)) {
      this.writeRecord(url, { etag: result.etag, lastModified: result.lastModified, body });
    }
    return body;
  }

  async getJson<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T> {
    const body = await this.getBytes(url, options);
    try {
      return JSON.parse(new TextDecoder().decode(body)) as T;
    } catch (err) {
      throw new WowgetError("network", `GET ${url} returned invalid JSON.`, { cause: err });
    }
  }

  async getConditional(url: string, validators: Validators, options?: HttpRequestOptions): Promise<ConditionalResult> {
    const headers: Record<string, string> = { "User-Agent": "wowget", ...options?.headers };
    const token = this.env.GITHUB_TOKEN;
    if (token && new URL(url).hostname === "api.github.com") headers.Authorization = `Bearer ${token}`;
    if (validators.etag) headers["If-None-Match"] = validators.etag;
    if (validators.lastModified) headers["If-Modified-Since"] = validators.lastModified;

    let response: Response;
    try {
      response = await this.fetchFn(url, { headers, redirect: "follow" });
    } catch (err) {
      throw new WowgetError("network", `GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    const sentValidator = Boolean(validators.etag || validators.lastModified);
    if (response.status === 304 && sentValidator) return { notModified: true, etag, lastModified };
    if (!response.ok) throw new HttpStatusError(url, response);
    return { notModified: false, body: new Uint8Array(await response.arrayBuffer()), etag, lastModified };
  }
}
