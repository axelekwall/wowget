import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { WowgetError } from "./errors.ts";
import type { OnEvent } from "./events.ts";
import { folderSupportsFlavor, type Flavor } from "./flavor.ts";
import { cacheDir as defaultCacheDir } from "./paths.ts";
import type { Resolved } from "./sources/types.ts";
import type { InstallRecord, State } from "./state.ts";
import { extractAddons, readZip } from "./zip.ts";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface InstallOptions {
  addon: string;
  resolved: Resolved;
  targetDir: string;
  flavor: Flavor;
  state: State;
  force?: boolean;
  /** Defaults to paths.cacheDir(). */
  cacheDir?: string;
  /** When known, a cached zip is reused only if it has this hash, and a download must match it. */
  sha256?: string;
  fetch?: FetchFn;
  onEvent?: OnEvent;
}

export interface InstallResult {
  addon: string;
  releaseId: string;
  version: string;
  folders: string[];
  /** Folders of the previous install that are not part of this one and were deleted. */
  removedFolders: string[];
  zipPath: string;
  sha256: string;
  record: InstallRecord;
}

export interface UninstallOptions {
  addon: string;
  targetDir: string;
  state: State;
}

export interface UninstallResult {
  addon: string;
  /** Folders that were deleted from disk. */
  removedFolders: string[];
  /** Whether there was an active install. */
  wasInstalled: boolean;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Makes a single path segment out of an arbitrary id or filename. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[/\\:\0]/g, "_");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}

/** Where a release's zip lives in the cache: `<cacheDir>/<addon>/<releaseId>/<filename>`. */
export function cachedZipPath(cacheDir: string, addon: string, releaseId: string, filename: string): string {
  return join(cacheDir, safeSegment(addon.toLowerCase()), safeSegment(releaseId), safeSegment(basename(filename)));
}

function isReadableZip(bytes: Uint8Array): boolean {
  try {
    readZip(bytes);
    return true;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Returns the cache path for a release and its bytes, downloading or copying it there if needed.
 * Only readable zips are stored; a cached file that is not one is deleted and fetched again.
 */
export async function fetchToCache(opts: {
  addon: string;
  resolved: Resolved;
  cacheDir: string;
  sha256?: string;
  fetch?: FetchFn;
  onEvent?: OnEvent;
}): Promise<{ zipPath: string; bytes: Uint8Array; sha256: string }> {
  const { addon, resolved, onEvent } = opts;
  const zipPath = cachedZipPath(opts.cacheDir, addon, resolved.releaseId, resolved.filename);
  const dir = dirname(zipPath);
  const expected = opts.sha256?.toLowerCase();

  if (await exists(zipPath)) {
    const bytes = new Uint8Array(await readFile(zipPath));
    const hash = sha256Hex(bytes);
    const readable = isReadableZip(bytes);
    if ((!expected || hash === expected) && readable) {
      onEvent?.({ type: "download:done", addon, bytes: bytes.length, sha256: hash, cached: true });
      return { zipPath, bytes, sha256: hash };
    }
    if (!readable) await rm(zipPath, { force: true });
  }
  // The local file may be the cached copy that was just deleted; download it again then.
  const localPath = resolved.localPath && (await exists(resolved.localPath)) ? resolved.localPath : undefined;

  await mkdir(dir, { recursive: true });
  const part = `${zipPath}.part-${randomBytes(4).toString("hex")}`;
  let bytes: Uint8Array;
  try {
    if (localPath) {
      await copyFile(localPath, part);
      bytes = new Uint8Array(await readFile(part));
    } else {
      bytes = await download(addon, resolved, opts.fetch ?? globalThis.fetch, onEvent);
      await Bun.write(part, bytes);
    }
    const hash = sha256Hex(bytes);
    if (expected && hash !== expected) {
      throw new WowgetError("network", `Checksum mismatch for ${resolved.filename}: expected ${expected}, got ${hash}.`);
    }
    readZip(bytes);
    await rename(part, zipPath);
    onEvent?.({ type: "download:done", addon, bytes: bytes.length, sha256: hash, cached: false });
    return { zipPath, bytes, sha256: hash };
  } finally {
    await rm(part, { force: true });
  }
}

function downloadError(url: string, err: unknown): WowgetError {
  return new WowgetError("network", `Download of ${url} failed: ${err instanceof Error ? err.message : String(err)}`, {
    cause: err,
  });
}

async function download(addon: string, resolved: Resolved, fetchFn: FetchFn, onEvent?: OnEvent): Promise<Uint8Array> {
  const url = resolved.downloadUrl;
  onEvent?.({ type: "download:start", addon, url, filename: resolved.filename });
  let response: Response;
  try {
    response = await fetchFn(url, { redirect: "follow" });
  } catch (err) {
    throw downloadError(url, err);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new WowgetError("network", `Download of ${url} failed: HTTP ${response.status}.`);
  }
  const lengthHeader = Number(response.headers.get("content-length"));
  const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : undefined;
  if (!response.body) {
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      throw downloadError(url, err);
    }
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for await (const chunk of response.body) {
      chunks.push(chunk);
      received += chunk.length;
      onEvent?.({ type: "download:progress", addon, received, total });
    }
  } catch (err) {
    throw downloadError(url, err);
  }
  // With a content encoding the declared length is that of the encoded body.
  if (total !== undefined && !response.headers.has("content-encoding") && received < total) {
    throw new WowgetError("network", `Download of ${url} ended after ${received} of ${total} bytes.`);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function install(opts: InstallOptions): Promise<InstallResult> {
  const { addon, resolved, targetDir, flavor, state, onEvent } = opts;
  const force = opts.force ?? false;
  const addonKey = addon.toLowerCase();

  const target = await stat(targetDir).catch(() => undefined);
  if (!target?.isDirectory()) {
    throw new WowgetError("io", `Install path ${targetDir} does not exist or is not a directory.`);
  }

  const { zipPath, bytes, sha256 } = await fetchToCache({
    addon,
    resolved,
    cacheDir: opts.cacheDir ?? defaultCacheDir(),
    sha256: opts.sha256,
    fetch: opts.fetch,
    onEvent,
  });

  const previous = state.getActiveInstall(addon);
  const tmpDir = await mkdtemp(join(targetDir, ".wowget-tmp-"));
  try {
    onEvent?.({ type: "extract", addon });
    const extracted = await extractAddons(bytes, tmpDir);
    const folders = extracted.map((f) => f.name);

    onEvent?.({ type: "verify", addon, folders });
    if (!resolved.flavorVerified) {
      for (const folder of extracted) {
        const support = await folderSupportsFlavor(folder.path, flavor);
        if (support === "no") {
          throw new WowgetError("flavor", `${addon}: folder ${folder.name} has no TOC for flavor "${flavor}".`);
        }
        if (support === "unknown" && !force) {
          throw new WowgetError(
            "flavor",
            `${addon}: cannot tell whether folder ${folder.name} supports flavor "${flavor}"; use --force to install anyway.`,
          );
        }
      }
    }

    if (!force) {
      for (const name of folders) {
        if (!(await exists(join(targetDir, name)))) continue;
        const owners = state.folderOwners(name);
        if (owners.includes(addonKey)) continue;
        const owner = owners[0] ? `belongs to "${owners[0]}"` : "is not managed by wowget";
        throw new WowgetError(
          "conflict",
          `${addon}: folder ${name} already exists in ${targetDir} and ${owner}; use --force to replace it.`,
        );
      }
    }

    const newKeys = new Set(folders.map((f) => f.toLowerCase()));
    const stale = (previous?.folders ?? []).filter((f) => !newKeys.has(f.toLowerCase()) && isPlainName(f));

    onEvent?.({ type: "swap", addon, folders });
    const oldDir = await mkdtemp(join(targetDir, ".wowget-old-"));
    const movedOld: string[] = [];
    const placed: string[] = [];
    let record: InstallRecord;
    const removedFolders: string[] = [];
    try {
      for (const folder of extracted) {
        const dest = join(targetDir, folder.name);
        if (await exists(dest)) {
          await rename(dest, join(oldDir, folder.name));
          movedOld.push(folder.name);
        }
        await rename(folder.path, dest);
        placed.push(folder.name);
      }
      for (const name of stale) {
        // Another addon may have taken the folder over with --force; leave it alone then.
        if (state.folderOwners(name).some((o) => o !== addonKey)) continue;
        if (!(await exists(join(targetDir, name)))) continue;
        await rename(join(targetDir, name), join(oldDir, name));
        movedOld.push(name);
        removedFolders.push(name);
      }
      record = state.recordInstall({
        addon,
        source: resolved.source,
        releaseId: resolved.releaseId,
        version: resolved.version,
        filename: resolved.filename,
        sha256,
        zipPath,
        folders,
      }, { releaseFromOthers: true });
    } catch (err) {
      const unrestored: string[] = [];
      for (const name of placed) await rm(join(targetDir, name), { recursive: true, force: true }).catch(() => {});
      for (const name of movedOld) {
        await rename(join(oldDir, name), join(targetDir, name)).catch(() => unrestored.push(name));
      }
      if (unrestored.length) {
        throw new WowgetError(
          "io",
          `${addon}: install failed (${err instanceof Error ? err.message : String(err)}) and restoring ${unrestored.join(", ")} also failed; the previous copies are in ${oldDir}.`,
          { cause: err },
        );
      }
      await rm(oldDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    await rm(oldDir, { recursive: true, force: true });

    onEvent?.({ type: "done", addon, releaseId: resolved.releaseId, folders });
    return {
      addon,
      releaseId: resolved.releaseId,
      version: resolved.version,
      folders,
      removedFolders,
      zipPath,
      sha256,
      record,
    };
  } finally {
    // Best effort, so that a cleanup failure does not hide the error that got here.
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function isPlainName(folder: string): boolean {
  return folder !== "" && folder !== "." && folder !== ".." && !/[/\\]/.test(folder);
}

export async function uninstall(opts: UninstallOptions): Promise<UninstallResult> {
  const { addon, targetDir, state } = opts;
  const addonKey = addon.toLowerCase();
  const active = state.getActiveInstall(addon);
  if (!active) return { addon, removedFolders: [], wasInstalled: false };

  const removedFolders: string[] = [];
  for (const folder of active.folders) {
    if (!isPlainName(folder)) continue;
    if (state.folderOwners(folder).some((o) => o !== addonKey)) continue;
    const path = join(targetDir, folder);
    if (!(await exists(path))) continue;
    await rm(path, { recursive: true, force: true });
    removedFolders.push(folder);
  }
  state.deactivateInstall(addon);
  return { addon, removedFolders, wasInstalled: true };
}
