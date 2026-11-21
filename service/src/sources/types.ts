import type { Flavor } from "../flavor.ts";
import type { Http } from "../http.ts";

export interface Resolved {
  source: string;
  /** GitHub: tag_name. WoWInterface: the file version. */
  releaseId: string;
  /** GitHub: the release.json version, else tag_name, without a leading "v". */
  version: string;
  filename: string;
  downloadUrl: string;
  publishedAt?: string;
  /** True when the source metadata named the flavor. */
  flavorVerified: boolean;
  /** Suggested addon name from the source metadata. */
  defaultName?: string;
  /** Something the user should know about this resolution, such as newer releases being skipped. */
  note?: string;
  /** MD5 of the file as published by the source. */
  md5?: string;
  /** SHA-256 hex of the file, from the GitHub asset digest. */
  sha256?: string;
  size?: number;
}

export interface ResolveContext {
  flavor: Flavor;
  prerelease: boolean;
  pin?: string;
  http: Http;
}

export interface Source {
  kind: "github" | "wowi";
  resolve(ctx: ResolveContext): Promise<Resolved>;
}
