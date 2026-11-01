import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { WowgetError } from "../errors.ts";
import { cachedZipPath } from "../installer.ts";
import { decodeSegment } from "./parse.ts";
import type { ResolveContext, Resolved, Source } from "./types.ts";

interface Pointer {
  sha256: string;
  filename: string;
}

function filenameFor(url: string, addon: string): string {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  const last = segments.length ? decodeSegment(segments[segments.length - 1]!) : "";
  return last || `${addon}.zip`;
}

function readPointer(body: Uint8Array): Pointer | undefined {
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as Partial<Pointer>;
    return typeof value.sha256 === "string" && typeof value.filename === "string"
      ? { sha256: value.sha256, filename: value.filename }
      : undefined;
  } catch {
    return undefined;
  }
}

export function urlSource(spec: { raw: string; url: string }): Source {
  return {
    kind: "url",
    async resolve(ctx: ResolveContext): Promise<Resolved> {
      // The zip itself stays in the download cache; the http cache only remembers the validators
      // and which cached file they belong to.
      const recordKey = `wowget:url-source:${ctx.addon.toLowerCase()}:${spec.url}`;
      const record = ctx.http.readRecord(recordKey);
      const previous = record ? readPointer(record.body) : undefined;
      const previousPath = previous && cachedZipPath(ctx.cacheDir, ctx.addon, previous.sha256, previous.filename);
      const usable = previousPath !== undefined && (await Bun.file(previousPath).exists());

      const result = await ctx.http.getConditional(spec.url, usable ? record! : {});
      let pointer: Pointer;
      let localPath: string;
      if (result.notModified) {
        pointer = previous!;
        localPath = previousPath!;
      } else {
        const body = result.body!;
        pointer = { sha256: createHash("sha256").update(body).digest("hex"), filename: filenameFor(spec.url, ctx.addon) };
        ctx.onEvent?.({ type: "download:start", addon: ctx.addon, url: spec.url, filename: pointer.filename });
        localPath = cachedZipPath(ctx.cacheDir, ctx.addon, pointer.sha256, pointer.filename);
        await mkdir(dirname(localPath), { recursive: true });
        const part = `${localPath}.part-${randomBytes(4).toString("hex")}`;
        try {
          await Bun.write(part, body);
          await rename(part, localPath);
        } finally {
          await rm(part, { force: true });
        }
        ctx.http.writeRecord(recordKey, {
          etag: result.etag,
          lastModified: result.lastModified,
          body: new TextEncoder().encode(JSON.stringify(pointer)),
        });
        ctx.onEvent?.({ type: "download:done", addon: ctx.addon, bytes: body.length, sha256: pointer.sha256, cached: false });
      }

      if (ctx.pin !== undefined && ctx.pin !== pointer.sha256) {
        throw new WowgetError(
          "source",
          `${spec.url} now serves a file with sha256 ${pointer.sha256}, but the addon is pinned to ${ctx.pin}.`,
        );
      }

      return {
        source: spec.raw,
        releaseId: pointer.sha256,
        version: pointer.sha256.slice(0, 12),
        filename: pointer.filename,
        downloadUrl: spec.url,
        flavorVerified: false,
        localPath,
      };
    },
  };
}
