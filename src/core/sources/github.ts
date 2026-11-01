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

/** Names a release asset may contain for a flavor when there is no release.json. */
function flavorHints(flavor: Flavor): string[] {
  return flavor === "forever" ? ["forever", "camelot"] : [flavor];
}

function pickRelease(releases: GithubRelease[], ctx: ResolveContext, repo: string): GithubRelease {
  const published = releases.filter((r) => !r.draft);
  if (ctx.pin !== undefined) {
    const pinned = published.find((r) => r.tag_name === ctx.pin);
    if (!pinned) {
      throw new WowgetError("source", `${repo}: no release tagged "${ctx.pin}" among the ${releases.length} most recent.`);
    }
    return pinned;
  }
  const release = published.find((r) => ctx.prerelease || !r.prerelease);
  if (!release) {
    const what = ctx.prerelease ? "releases" : "stable releases (use --prerelease to allow pre-releases)";
    throw new WowgetError("source", `${repo} has no published ${what}.`);
  }
  return release;
}

function chooseFromReleaseJson(entries: ReleaseJsonEntry[], flavor: Flavor): ReleaseJsonEntry | undefined {
  const matching = entries.filter((e) => e.metadata?.some((m) => m.flavor === flavor));
  return matching.find((e) => e.nolib === false) ?? matching.find((e) => !e.nolib) ?? matching[0];
}

function chooseByName(zips: GithubAsset[], flavor: Flavor, releaseUrl: string): GithubAsset {
  if (zips.length === 1) return zips[0]!;
  if (zips.length === 0) throw new WowgetError("source", `Release ${releaseUrl} has no .zip asset.`);
  const hints = flavorHints(flavor);
  const hinted = zips.filter((a) => hints.some((h) => a.name.toLowerCase().includes(h)));
  if (hinted.length === 1) return hinted[0]!;
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

  return {
    kind: "github",
    async resolve(ctx: ResolveContext): Promise<Resolved> {
      let releases: GithubRelease[];
      try {
        releases = await getJson<GithubRelease[]>(ctx, `${API}/repos/${repo}/releases?per_page=30`, API_HEADERS);
      } catch (err) {
        if (err instanceof HttpStatusError && err.status === 404) {
          throw new WowgetError("source", `GitHub repository ${repo} was not found.`, { cause: err });
        }
        throw err;
      }
      if (!Array.isArray(releases)) throw new WowgetError("source", `Unexpected releases response for ${repo}.`);

      const release = pickRelease(releases, ctx, repo);
      const releaseUrl = release.html_url ?? `https://github.com/${repo}/releases/tag/${release.tag_name}`;
      const assets = release.assets ?? [];

      let asset: GithubAsset | undefined;
      let flavorVerified = false;
      let version = release.tag_name;
      const releaseJson = assets.find((a) => a.name === "release.json");
      if (releaseJson) {
        const data = await getJson<{ version?: unknown; releases?: ReleaseJsonEntry[] }>(ctx, releaseJson.browser_download_url);
        const entry = chooseFromReleaseJson(Array.isArray(data?.releases) ? data.releases : [], ctx.flavor);
        if (entry) {
          asset = assets.find((a) => a.name === entry.filename);
          if (!asset) {
            throw new WowgetError("source", `Release ${releaseUrl} lists ${entry.filename} in release.json but has no such asset.`);
          }
          flavorVerified = true;
          // Tags can be odd ("bundle/v12.3.1+v1.0.9"); the packager's version reads better.
          const named = typeof entry.version === "string" && entry.version ? entry.version : data.version;
          if (typeof named === "string" && named) version = named;
        }
      }
      // Without a release.json entry for the flavor, fall back to the zips and let the installer
      // check the TOC files.
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
    },
  };
}
