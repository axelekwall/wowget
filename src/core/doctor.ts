import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { addonTocs, folderSupportsFlavor, interfaceMatchesFlavor, parseToc, tocSuffixes, tocSuffixFor, type Flavor } from "./flavor.ts";
import { addonCacheDir, removeBestEffort } from "./installer.ts";
import { addonTargets, type Manifest, type NamedTarget } from "./manifest.ts";
import type { State } from "./state.ts";

export type DoctorIssueKind =
  | "missing_target_dir"
  | "missing_folders"
  | "missing_cached_zip"
  | "flavor_mismatch"
  | "interface_drift"
  | "leftover_temp_dir"
  | "stale_cache";

export interface DoctorIssue {
  kind: DoctorIssueKind;
  target?: string;
  addon?: string;
  path?: string;
  message: string;
}

export interface DoctorTargetReport {
  name: string;
  flavor: Flavor;
  path: string;
  exists: boolean;
  clientVersion?: string;
  clientInterface?: number;
}

const FOLDER_PRODUCTS: Record<string, string> = {
  _forever_: "wowf",
  _classic_era_: "wow_classic_era",
  _classic_: "wow_classic",
  _retail_: "wow",
};

/** Converts a client build version ("1.15.7.60000", "1.16.1.58123", "11.1.5.59000") to an Interface number. */
export function versionToInterface(version: string): number | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(version.trim());
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if ((major === 1 && minor === 16) || (major === 16 && minor === 0)) return 16000 + patch;
  return major * 10000 + minor * 100 + patch;
}

/** Parses a Battle.net `.build.info` file into a map of product code to active version and interface number. */
export function parseBuildInfo(text: string): Map<string, { version: string; interfaceNumber?: number }> {
  const out = new Map<string, { version: string; interfaceNumber?: number }>();
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return out;
  const headers = lines[0]!.split("|").map((h) => h.split("!")[0]!.trim().toLowerCase());
  const activeIdx = headers.indexOf("active");
  const versionIdx = headers.indexOf("version");
  const productIdx = headers.indexOf("product");
  if (versionIdx < 0 || productIdx < 0) return out;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split("|");
    if (activeIdx >= 0 && cols[activeIdx]?.trim() !== "1") continue;
    const product = cols[productIdx]?.trim();
    const version = cols[versionIdx]?.trim();
    if (!product || !version) continue;
    out.set(product, { version, interfaceNumber: versionToInterface(version) });
  }
  return out;
}

async function detectProduct(versionDir: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(versionDir, ".flavor.info"), "utf8");
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines[1]) return lines[1];
  } catch {
    // Fall back to the version folder name.
  }
  return FOLDER_PRODUCTS[basename(versionDir)];
}

/** Reads `.build.info` above `<versionDir>/Interface/AddOns` when present. */
export async function clientBuildForAddonsDir(
  addonsDir: string,
): Promise<{ version: string; interfaceNumber?: number } | undefined> {
  const versionDir = resolve(addonsDir, "..", "..");
  const gameDir = resolve(versionDir, "..");
  const product = await detectProduct(versionDir);
  if (!product) return undefined;
  try {
    const text = await readFile(join(gameDir, ".build.info"), "utf8");
    return parseBuildInfo(text).get(product);
  } catch {
    return undefined;
  }
}

async function folderInterfacesForFlavor(dir: string, flavor: Flavor): Promise<number[]> {
  const name = basename(dir);
  const allowed = new Set(tocSuffixes(flavor).map((s) => s.toLowerCase()));
  const out = new Set<number>();
  for (const file of await addonTocs(dir)) {
    const suffix = tocSuffixFor(file, name);
    if (suffix === undefined || !allowed.has(suffix.toLowerCase())) continue;
    const toc = parseToc(await readFile(join(dir, file), "utf8"));
    for (const n of toc.interface) {
      if (interfaceMatchesFlavor(n, flavor) === "yes") out.add(n);
    }
    for (const [key, value] of Object.entries(toc.fields)) {
      const typed = /^interface-(.+)$/i.exec(key);
      if (!typed || !allowed.has(typed[1]!.toLowerCase())) continue;
      for (const part of value.split(",")) {
        const trimmed = part.trim();
        if (/^\d+$/.test(trimmed)) {
          const n = Number(trimmed);
          if (interfaceMatchesFlavor(n, flavor) === "yes") out.add(n);
        }
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Removes cached release directories for `addon` that are not in `state.keptZipPaths(addon)`. */
export async function pruneAddonCache(cacheDir: string, state: State, addon: string): Promise<string[]> {
  const keptDirs = new Set([...state.keptZipPaths(addon)].map((p) => resolve(dirname(p))));
  const addonDir = addonCacheDir(cacheDir, addon);
  let entries;
  try {
    entries = await readdir(addonDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(addonDir, entry.name);
    if (keptDirs.has(dir)) continue;
    if (await removeBestEffort(dir)) removed.push(dir);
  }
  const remaining = await readdir(addonDir).catch(() => ["x"]);
  if (remaining.length === 0) await removeBestEffort(addonDir);
  return removed;
}

/** Finds release directories in `cacheDir` that are not referenced by any active or rollback install. */
export async function findStaleCacheDirs(cacheDir: string, state: State): Promise<string[]> {
  const keptDirs = new Set([...state.keptZipPaths()].map((p) => resolve(dirname(p))));
  let addonEntries;
  try {
    addonEntries = await readdir(cacheDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const stale: string[] = [];
  for (const addonEntry of addonEntries) {
    // Dot entries are not addon caches (the search catalogue lives in ".catalog").
    if (!addonEntry.isDirectory() || addonEntry.name.startsWith(".")) continue;
    const addonDir = join(cacheDir, addonEntry.name);
    const releaseEntries = await readdir(addonDir, { withFileTypes: true }).catch(() => []);
    for (const rel of releaseEntries) {
      if (!rel.isDirectory()) continue;
      const full = resolve(addonDir, rel.name);
      if (!keptDirs.has(full)) stale.push(full);
    }
  }
  return stale.sort();
}

export async function inspectTarget(
  target: NamedTarget,
  manifest: Manifest,
  state: State,
  clean: boolean,
): Promise<{ report: DoctorTargetReport; issues: DoctorIssue[]; cleaned: string[] }> {
  const issues: DoctorIssue[] = [];
  const cleaned: string[] = [];
  const exists = await stat(target.path).then(
    (s) => s.isDirectory(),
    () => false,
  );
  const build = await clientBuildForAddonsDir(target.path);
  const report: DoctorTargetReport = {
    name: target.name,
    flavor: target.flavor,
    path: target.path,
    exists,
    ...(build?.version ? { clientVersion: build.version } : {}),
    ...(build?.interfaceNumber !== undefined ? { clientInterface: build.interfaceNumber } : {}),
  };

  if (!exists) {
    issues.push({
      kind: "missing_target_dir",
      target: target.name,
      path: target.path,
      message: `${target.name}: AddOns directory ${target.path} does not exist.`,
    });
    return { report, issues, cleaned };
  }

  const dirEntries = await readdir(target.path, { withFileTypes: true }).catch(() => []);
  for (const e of dirEntries) {
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith(".wowget-old-") && !e.name.startsWith(".wowget-tmp-")) continue;
    const full = join(target.path, e.name);
    if (clean && (await removeBestEffort(full))) {
      cleaned.push(full);
    } else {
      issues.push({
        kind: "leftover_temp_dir",
        target: target.name,
        path: full,
        message: `${target.name}: leftover temporary directory ${full}.`,
      });
    }
  }

  for (const entry of manifest.addons) {
    if (!addonTargets(manifest, entry).includes(target.name)) continue;
    const active = state.getActiveInstall(target.name, entry.name);
    if (!active) continue;

    if (!(await Bun.file(active.zipPath).exists())) {
      issues.push({
        kind: "missing_cached_zip",
        target: target.name,
        addon: entry.name,
        path: active.zipPath,
        message: `${target.name} (${entry.name}): cached zip ${active.zipPath} is missing.`,
      });
    }

    const missing: string[] = [...active.displacedFolders];
    for (const folder of active.folders) {
      const folderDir = join(target.path, folder);
      const present = await stat(folderDir).then(
        (s) => s.isDirectory(),
        () => false,
      );
      if (!present) {
        missing.push(folder);
        continue;
      }
      const support = await folderSupportsFlavor(folderDir, target.flavor);
      if (support === "no") {
        issues.push({
          kind: "flavor_mismatch",
          target: target.name,
          addon: entry.name,
          path: folderDir,
          message: `${target.name} (${entry.name}): folder ${folder} has no TOC for flavor "${target.flavor}".`,
        });
      } else if (build?.interfaceNumber !== undefined) {
        const ifaces = await folderInterfacesForFlavor(folderDir, target.flavor);
        if (ifaces.length > 0 && !ifaces.includes(build.interfaceNumber)) {
          issues.push({
            kind: "interface_drift",
            target: target.name,
            addon: entry.name,
            path: folderDir,
            message: `${target.name} (${entry.name}): folder ${folder} lists Interface ${ifaces.join(", ")}, but client is ${build.interfaceNumber} (${build.version}).`,
          });
        }
      }
    }

    if (missing.length) {
      issues.push({
        kind: "missing_folders",
        target: target.name,
        addon: entry.name,
        message: `${target.name} (${entry.name}): missing folders ${missing.sort().join(", ")}.`,
      });
    }
  }

  return { report, issues, cleaned };
}
