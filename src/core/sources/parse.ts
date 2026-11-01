import { WowgetError } from "../errors.ts";

export type SourceSpec =
  | { kind: "github"; raw: string; owner: string; repo: string }
  | { kind: "url"; raw: string; url: string };

const SUPPORTED = 'supported forms are "github:owner/repo" and "url:https://..."';

export function parseSource(raw: string): SourceSpec {
  const colon = raw.indexOf(":");
  const kind = colon === -1 ? "" : raw.slice(0, colon);
  const rest = colon === -1 ? "" : raw.slice(colon + 1);

  if (kind === "github") {
    const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/.exec(rest);
    if (!match || match[2] === "." || match[2] === "..") {
      throw new WowgetError("source", `Invalid GitHub source "${raw}"; expected "github:owner/repo".`);
    }
    return { kind: "github", raw, owner: match[1]!, repo: match[2]! };
  }

  if (kind === "url") {
    let url: URL;
    try {
      url = new URL(rest);
    } catch {
      throw new WowgetError("source", `Invalid URL source "${raw}"; expected "url:https://...".`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new WowgetError("source", `Invalid URL source "${raw}"; only http and https URLs are supported.`);
    }
    return { kind: "url", raw, url: url.href };
  }

  throw new WowgetError("source", `Unknown source "${raw}"; ${SUPPORTED}.`);
}

/** Decodes a URL path segment, keeping it as is when it has a malformed escape. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Name used on `add` when none is given: the repo name, or the URL's last path segment without ".zip". */
export function defaultAddonName(spec: SourceSpec): string {
  if (spec.kind === "github") return spec.repo;
  const url = new URL(spec.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments.length ? decodeSegment(segments[segments.length - 1]!) : "";
  const name = last.replace(/\.zip$/i, "");
  return name || url.hostname;
}
