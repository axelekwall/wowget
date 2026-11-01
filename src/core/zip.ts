import { unzipSync } from "fflate";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { WowgetError } from "./errors.ts";
import { tocSuffixFor } from "./flavor.ts";

export interface AddonFolder {
  name: string;
  path: string;
}

/** Splits a zip entry name into safe path segments, or throws on absolute paths and "..". */
function entrySegments(name: string): string[] {
  const normalised = name.replace(/\\/g, "/");
  if (normalised.startsWith("/") || /^[A-Za-z]:/.test(normalised)) {
    throw new WowgetError("zip", `Refusing zip entry with an absolute path: ${name}`);
  }
  const segments = normalised.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) {
    throw new WowgetError("zip", `Refusing zip entry that escapes the target directory: ${name}`);
  }
  return segments;
}

/** Decompresses every entry of `bytes`, throwing a "zip" error when that fails. */
export function readZip(bytes: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes);
  } catch (err) {
    throw new WowgetError("zip", `Could not read zip: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

/** Extracts `bytes` into `destDir`. All entries are checked before anything is written. */
export async function extractZip(bytes: Uint8Array, destDir: string): Promise<void> {
  const entries = readZip(bytes);
  const plan = Object.entries(entries).map(([name, data]) => ({
    segments: entrySegments(name),
    isDir: name.endsWith("/") || name.endsWith("\\"),
    data,
  }));
  for (const { segments, isDir, data } of plan) {
    if (segments.length === 0) continue;
    const target = join(destDir, ...segments);
    if (isDir) {
      await mkdir(target, { recursive: true });
    } else {
      await mkdir(join(destDir, ...segments.slice(0, -1)), { recursive: true });
      await writeFile(target, data);
    }
  }
}

export async function isAddonFolder(dir: string): Promise<boolean> {
  const name = basename(dir);
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.some((e) => e.isFile() && tocSuffixFor(e.name, name) !== undefined);
}

async function subdirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && e.name !== "__MACOSX" && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/**
 * Finds addon folders under an extracted zip: those at the top level, or, when the top level is a
 * single directory that is not an addon folder, those one level below it.
 */
export async function findAddonFolders(root: string): Promise<AddonFolder[]> {
  const collect = async (dir: string) => {
    const found: AddonFolder[] = [];
    for (const name of await subdirectories(dir)) {
      if (await isAddonFolder(join(dir, name))) found.push({ name, path: join(dir, name) });
    }
    return found;
  };

  let folders = await collect(root);
  if (folders.length === 0) {
    const top = await subdirectories(root);
    if (top.length === 1) folders = await collect(join(root, top[0]!));
  }
  if (folders.length === 0) {
    throw new WowgetError("zip", "The zip contains no addon folder (a directory with a matching .toc file).");
  }
  return folders;
}

export async function extractAddons(bytes: Uint8Array, destDir: string): Promise<AddonFolder[]> {
  await extractZip(bytes, destDir);
  return findAddonFolders(destDir);
}
