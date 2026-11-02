import { WowgetError } from "../errors.ts";
import { HttpStatusError } from "../http.ts";
import { addonNameProblem } from "../manifest.ts";
import type { ResolveContext, Resolved, Source } from "./types.ts";

interface WowiFileDetails {
  UID?: number | string;
  UIName?: string;
  UIFileName?: string;
  UIVersion?: string;
  UIDate?: number | string;
  UIDownload?: string;
  UIMD5?: string;
}

const API = "https://api.mmoui.com/v3/game/WOW/filedetails";

function cleanAddonName(fileName: string | undefined, version: string, fallback: string): string {
  if (!fileName) return fallback;
  let stem = fileName.replace(/\.zip$/i, "");
  for (const suffix of [`-${version}`, `_${version}`, ` ${version}`, `-v${version}`, `_v${version}`]) {
    if (stem.toLowerCase().endsWith(suffix.toLowerCase()) && stem.length > suffix.length) {
      stem = stem.slice(0, -suffix.length);
      break;
    }
  }
  return stem || fallback;
}

export function wowiSource(spec: { raw: string; id: string }): Source {
  return {
    kind: "wowi",
    async resolve(ctx: ResolveContext): Promise<Resolved> {
      const url = `${API}/${spec.id}.json`;
      let data: unknown;
      try {
        data = await ctx.http.getJson< unknown >(url);
      } catch (err) {
        if (err instanceof HttpStatusError && err.status === 404) {
          throw new WowgetError("source", `WoWInterface addon ${spec.id} was not found.`, { cause: err });
        }
        throw err;
      }
      if (!Array.isArray(data) || data.length === 0 || typeof data[0] !== "object" || data[0] === null) {
        throw new WowgetError("source", `Unexpected response from WoWInterface for addon ${spec.id}.`);
      }
      const entry = data[0] as WowiFileDetails;
      const version = typeof entry.UIVersion === "string" && entry.UIVersion ? entry.UIVersion : undefined;
      const downloadUrl = typeof entry.UIDownload === "string" && entry.UIDownload ? entry.UIDownload : undefined;
      if (!version || !downloadUrl) {
        throw new WowgetError("source", `WoWInterface addon ${spec.id} has no downloadable release.`);
      }
      const releaseId = version;
      if (ctx.pin !== undefined && ctx.pin !== releaseId) {
        throw new WowgetError(
          "source",
          `WoWInterface addon ${spec.id} is at version "${releaseId}", but is pinned to "${ctx.pin}" (WoWInterface only serves the latest file).`,
        );
      }
      const filename =
        typeof entry.UIFileName === "string" && entry.UIFileName ? entry.UIFileName : `wowi-${spec.id}-${version}.zip`;
      const dateNum = Number(entry.UIDate);
      const publishedAt = Number.isFinite(dateNum) && dateNum > 0 ? new Date(dateNum).toISOString() : undefined;
      // The file and display names are author-supplied; fall back to the id when neither is usable.
      const idName = `wowi-${spec.id}`;
      const displayName = typeof entry.UIName === "string" && !addonNameProblem(entry.UIName) ? entry.UIName : idName;
      const fileName = cleanAddonName(entry.UIFileName, version, displayName);

      return {
        source: spec.raw,
        releaseId,
        version: version.replace(/^v/, ""),
        filename,
        downloadUrl,
        publishedAt,
        flavorVerified: false,
        defaultName: addonNameProblem(fileName) ? displayName : fileName,
        ...(typeof entry.UIMD5 === "string" && /^[0-9a-f]{32}$/i.test(entry.UIMD5) ? { md5: entry.UIMD5 } : {}),
      };
    },
  };
}
