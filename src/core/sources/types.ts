import type { Flavor } from "../flavor.ts";

export interface Resolved {
  /** The manifest source string. */
  source: string;
  /** GitHub: tag_name. URL: sha256 of the file. */
  releaseId: string;
  /** GitHub: tag_name without a leading "v". URL: first 12 hex of sha256. */
  version: string;
  filename: string;
  downloadUrl: string;
  publishedAt?: string;
  /** True when the source metadata named the flavor. */
  flavorVerified: boolean;
  /** A file already on disk (for the URL source, the copy in the cache). */
  localPath?: string;
}

export interface HttpRequestOptions {
  headers?: Record<string, string>;
}

export interface Http {
  getJson<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T>;
  getBytes(url: string, options?: HttpRequestOptions): Promise<Uint8Array>;
}

export interface ResolveContext {
  /** Manifest name of the addon; used for cache paths. */
  addon: string;
  flavor: Flavor;
  prerelease: boolean;
  pin?: string;
  http: Http;
  cacheDir: string;
}

export interface Source {
  kind: "github" | "url";
  resolve(ctx: ResolveContext): Promise<Resolved>;
}
