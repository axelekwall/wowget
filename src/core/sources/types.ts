import type { OnEvent } from "../events.ts";
import type { Flavor } from "../flavor.ts";

export interface Resolved {
  /** The manifest source string. */
  source: string;
  /** GitHub: tag_name. URL: sha256 of the file. */
  releaseId: string;
  /** GitHub: the release.json version, else tag_name, without a leading "v". URL: first 12 hex of sha256. */
  version: string;
  filename: string;
  downloadUrl: string;
  publishedAt?: string;
  /** True when the source metadata named the flavor. */
  flavorVerified: boolean;
  /** A file already on disk (for the URL source, the copy in the cache). */
  localPath?: string;
  /** Suggested addon name from the source metadata when none was given on `add`. */
  defaultName?: string;
  /** Something the user should know about this resolution, such as newer releases being skipped. */
  note?: string;
}

export interface HttpRequestOptions {
  headers?: Record<string, string>;
}

export interface Validators {
  etag?: string | null;
  lastModified?: string | null;
}

export interface ConditionalResult {
  /** True on a 304 answer to the validators that were sent; `body` is then absent. */
  notModified: boolean;
  body?: Uint8Array;
  etag: string | null;
  lastModified: string | null;
}

export interface CacheRecord {
  etag: string | null;
  lastModified: string | null;
  body: Uint8Array;
}

export interface Http {
  /** GET through the ETag cache, parsed as JSON. */
  getJson<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T>;
  /** GET through the ETag cache. */
  getBytes(url: string, options?: HttpRequestOptions): Promise<Uint8Array>;
  /** Conditional GET with caller-held validators; the body is never cached. */
  getConditional(url: string, validators: Validators, options?: HttpRequestOptions): Promise<ConditionalResult>;
  /** Small records in the same cache table, for callers that keep large bodies elsewhere. */
  readRecord(key: string): CacheRecord | undefined;
  writeRecord(key: string, record: CacheRecord): void;
}

export interface ResolveContext {
  /** Manifest name of the addon; used for cache paths. */
  addon: string;
  flavor: Flavor;
  prerelease: boolean;
  pin?: string;
  http: Http;
  cacheDir: string;
  /** For sources that download during resolve (URL). */
  onEvent?: OnEvent;
}

export interface Source {
  kind: "github" | "wowi" | "url";
  resolve(ctx: ResolveContext): Promise<Resolved>;
}
