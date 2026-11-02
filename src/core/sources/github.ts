import { WowgetError } from "../errors.ts";
import type { Flavor } from "../flavor.ts";
import { HttpStatusError } from "../http.ts";
import type { ResolveContext, Resolved, Source } from "./types.ts";

interface GithubAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  html_url?: string;
  draft: boolean;
  prerelease: boolean;
  published_at?: string | null;
  assets: GithubAsset[];
}

interface ReleaseJsonEntry {
  filename: string;
  version?: string;
  nolib?: boolean;
  metadata?: { flavor?: string; interface?: number }[];
}

const API = "https://api.github.com";
const API_HEADERS = { Accept: "application/vnd.github+json" };

function isRateLimited(err: HttpStatusError): boolean {
  if (err.status !== 403 && err.status !== 429) return false;
  return err.headers.get("x-ratelimit-remaining") === "0" || err.headers.has("retry-after");
}

function rateLimitError(err: HttpStatusError): WowgetError {
  const reset = Number(err.headers.get("x-ratelimit-reset"));
  const when = Number.isFinite(reset) && reset > 0 ? ` It resets at ${new Date(reset * 1000).toISOString()}.` : "";
  return new WowgetError(
    "rate_limited",
    `GitHub API rate limit reached.${when} Set GITHUB_TOKEN to a personal access token to raise the limit.`,
    { cause: err },
  );
}

/** Names a release asset may contain for a flavor when there is no release.json, in priority order. */
function flavorHints(flavor: Flavor): string[] {
  switch (flavor) {
    case "forever":
      return ["forever", "camelot"];
    case "mainline":
      return ["mainline", "retail", "standard"];
    case "classic":
      return ["vanilla", "classic_era", "classic-era", "era", "classic"];
    case "bcc":
      return ["bcc", "tbc"];
    case "wrath":
      return ["wrath", "wotlkc", "wotlk"];
    case "cata":
      return ["cata", "cataclysm"];
    case "mists":
      return ["mists", "mop"];
  }
}

const PER_PAGE = 30;
const MAX_PAGES = 5;
const MAX_FLAVOR_CANDIDATES = 10;

function matchesChannel(release: GithubRelease, ctx: ResolveContext): boolean {
  return !release.draft && (ctx.prerelease || !release.prerelease);
}

/** GitHub rewrites some characters in uploaded asset names, for instance spaces to dots. */
function normaliseAssetName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ".");
}

function isNolibName(name: string): boolean {
  return /(?:^|[^a-z0-9])nolib(?:$|[^a-z0-9])/i.test(name);
}

function preferWithLibs(assets: GithubAsset[]): GithubAsset[] {
  const withLibs = assets.filter((a) => !isNolibName(a.name));
  return withLibs.length ? withLibs : assets;
}

function chooseFromReleaseJson(entries: ReleaseJsonEntry[], flavor: Flavor): ReleaseJsonEntry | undefined {
  const matching = entries.filter((e) => e.metadata?.some((m) => m.flavor === flavor));
  return matching.find((e) => e.nolib === false) ?? matching.find((e) => !e.nolib) ?? matching[0];
}

/** Flavor names the release.json entries list, sorted and without duplicates. */
function listedFlavors(entries: ReleaseJsonEntry[]): string[] {
  const flavors = entries.flatMap((e) => (Array.isArray(e?.metadata) ? e.metadata.map((m) => m?.flavor) : []));
  return [...new Set(flavors.filter((f): f is string => typeof f === "string" && f !== ""))].sort();
}

function chooseByName(zips: GithubAsset[], flavor: Flavor, releaseUrl: string): GithubAsset {
  if (zips.length === 1) return zips[0]!;
  if (zips.length === 0) throw new WowgetError("source", `Release ${releaseUrl} has no .zip asset.`);
  for (const hint of flavorHints(flavor)) {
    const hinted = preferWithLibs(zips.filter((a) => a.name.toLowerCase().includes(hint)));
    if (hinted.length === 1) return hinted[0]!;
  }
  const withLibs = preferWithLibs(zips);
  if (withLibs.length === 1 && zips.every((a) => a === withLibs[0] || isNolibName(a.name))) {
    return withLibs[0]!;
  }
  throw new WowgetError(
    "source",
    `Release ${releaseUrl} has several zips and none is clearly for flavor "${flavor}": ${zips.map((a) => a.name).join(", ")}.`,
  );
}

export function githubSource(spec: { raw: string; owner: string; repo: string }): Source {
  const repo = `${spec.owner}/${spec.repo}`;

  async function getJson<T>(ctx: ResolveContext, url: string, headers?: Record<string, string>): Promise<T> {
    try {
      return await ctx.http.getJson<T>(url, { headers });
    } catch (err) {
      if (err instanceof HttpStatusError && isRateLimited(err)) throw rateLimitError(err);
      throw err;
    }
  }

  /** Returns undefined when the file is not valid JSON. */
  async function readReleaseJson(
    ctx: ResolveContext,
    url: string,
  ): Promise<{ version?: unknown; releases?: ReleaseJsonEntry[] } | undefined> {
    try {
      return await getJson(ctx, url);
    } catch (err) {
      if (err instanceof WowgetError && err.cause instanceof SyntaxError) return undefined;
      throw err;
    }
  }

  async function listReleases(ctx: ResolveContext, page: number): Promise<GithubRelease[]> {
    const url = `${API}/repos/${repo}/releases?per_page=${PER_PAGE}${page > 1 ? `&page=${page}` : ""}`;
    let releases: GithubRelease[];
    try {
      releases = await getJson<GithubRelease[]>(ctx, url, API_HEADERS);
    } catch (err) {
      if (err instanceof HttpStatusError && err.status === 404) {
        throw new WowgetError("source", `GitHub repository ${repo} was not found.`, { cause: err });
      }
      throw err;
    }
    if (!Array.isArray(releases)) throw new WowgetError("source", `Unexpected releases response for ${repo}.`);
    return releases;
  }

  async function resolveRelease(ctx: ResolveContext, release: GithubRelease): Promise<Resolved> {
    const releaseUrl = release.html_url ?? `https://github.com/${repo}/releases/tag/${release.tag_name}`;
    const assets = release.assets ?? [];

    let asset: GithubAsset | undefined;
    let flavorVerified = false;
    let version = release.tag_name;
    const releaseJson = assets.find((a) => a.name === "release.json");
    if (releaseJson) {
      const data = await readReleaseJson(ctx, releaseJson.browser_download_url);
      const entries = Array.isArray(data?.releases) ? data.releases : [];
      const entry = chooseFromReleaseJson(entries, ctx.flavor);
      const listed = listedFlavors(entries);
      if (!entry && listed.length) {
        throw new WowgetError(
          "flavor",
          `${repo} ${release.tag_name} has no build for flavor "${ctx.flavor}" (release.json lists: ${listed.join(", ")}).`,
        );
      }
      if (entry && data) {
        const wanted = typeof entry.filename === "string" ? normaliseAssetName(entry.filename) : undefined;
        asset =
          assets.find((a) => a.name === entry.filename) ?? assets.find((a) => normaliseAssetName(a.name) === wanted);
        flavorVerified = asset !== undefined;
        // Tags can be odd ("bundle/v12.3.1+v1.0.9"); the packager's version reads better.
        const named = typeof entry.version === "string" && entry.version ? entry.version : data.version;
        if (typeof named === "string" && named) version = named;
      }
    }
    // Without a usable release.json, or when the entry's filename matches no asset, fall back to
    // the zips and let the installer check the TOC files.
    asset ??= chooseByName(
      assets.filter((a) => a.name.toLowerCase().endsWith(".zip")),
      ctx.flavor,
      releaseUrl,
    );

    return {
      source: spec.raw,
      releaseId: release.tag_name,
      version: version.replace(/^v/, ""),
      filename: asset.name,
      downloadUrl: asset.browser_download_url,
      publishedAt: release.published_at ?? undefined,
      flavorVerified,
    };
  }

  /**
   * Scans newest releases until one has a usable build for `ctx.flavor`, up to MAX_FLAVOR_CANDIDATES
   * channel-matching releases across MAX_PAGES. If none matches, throws the newest release's error.
   */
  async function resolveNewest(ctx: ResolveContext): Promise<Resolved> {
    let page = 1;
    let checked = 0;
    let firstError: WowgetError | undefined;
    let firstTag: string | undefined;
    for (; page <= MAX_PAGES; page++) {
      const releases = await listReleases(ctx, page);
      for (const release of releases) {
        if (!matchesChannel(release, ctx)) continue;
        try {
          const resolved = await resolveRelease(ctx, release);
          if (!firstError) return resolved;
          const skipped = checked === 1 ? `the newer release ${firstTag}` : `${checked} newer releases, the newest ${firstTag}`;
          return { ...resolved, note: `using ${release.tag_name} because ${skipped} could not be used: ${firstError.message}` };
        } catch (err) {
          if (err instanceof WowgetError && (err.code === "flavor" || err.code === "source")) {
            if (!firstError) {
              firstError = err;
              firstTag = release.tag_name;
            }
            checked++;
            if (checked >= MAX_FLAVOR_CANDIDATES) throw firstError;
            continue;
          }
          throw err;
        }
      }
      if (releases.length < PER_PAGE) break;
    }
    if (firstError) throw firstError;
    const limit = page > MAX_PAGES ? ` among its newest ${PER_PAGE * MAX_PAGES} (only those are checked)` : "";
    const hint = ctx.prerelease ? "" : " (use --prerelease to allow pre-releases)";
    throw new WowgetError("source", `${repo} has no published ${ctx.prerelease ? "" : "stable "}releases${limit}${hint}.`);
  }

  /** Looks in the newest releases first, then asks for the tag directly, since it may be older. */
  async function pinnedRelease(ctx: ResolveContext, pin: string): Promise<GithubRelease> {
    const listed = (await listReleases(ctx, 1)).find((r) => !r.draft && r.tag_name === pin);
    if (listed) return listed;
    let release: GithubRelease;
    try {
      // Tags may contain "/" ("bundle/v1.0"), which the endpoint expects literally.
      const tag = pin.split("/").map(encodeURIComponent).join("/");
      release = await getJson<GithubRelease>(ctx, `${API}/repos/${repo}/releases/tags/${tag}`, API_HEADERS);
    } catch (err) {
      if (err instanceof HttpStatusError && err.status === 404) {
        throw new WowgetError("source", `${repo}: no release tagged "${pin}".`, { cause: err });
      }
      throw err;
    }
    if (!release || typeof release !== "object" || release.tag_name !== pin || release.draft) {
      throw new WowgetError("source", `${repo}: no release tagged "${pin}".`);
    }
    return release;
  }

  return {
    kind: "github",
    async resolve(ctx: ResolveContext): Promise<Resolved> {
      if (ctx.pin !== undefined) return resolveRelease(ctx, await pinnedRelease(ctx, ctx.pin));
      return resolveNewest(ctx);
    },
  };
}
