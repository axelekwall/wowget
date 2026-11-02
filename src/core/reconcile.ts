import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { addonTocs, parseToc } from "./flavor.ts";
import type { RegistryEntry } from "./registry.ts";
import type { CatalogEntry } from "./search/wowi-catalog.ts";
import { defaultAddonName, parseSource } from "./sources/parse.ts";
import type { State } from "./state.ts";
import { isAddonFolder } from "./zip.ts";

export interface UnmanagedAddon {
  name: string;
  target: string;
  folders: string[];
  version: string | null;
  source: string | null;
  /** WoWInterface sources whose folder list includes this addon's folder; not adopted automatically. */
  suggestions?: string[];
}

/** Lists that name addons by their folders, consulted when a folder's TOC names no source. */
export interface ReconcileHints {
  registry?: RegistryEntry[];
  catalog?: CatalogEntry[];
}

interface FolderMeta {
  folder: string;
  version: string | null;
  source: string | null;
  deps: string[];
  /** Set when the source came from the registry rather than the TOC. */
  registryName?: string;
}

const MAX_SUGGESTIONS = 3;

/** Folder name (lower-case) to the registry entry listing it, leaving out folders that several entries list. */
function registryFolders(entries: RegistryEntry[]): Map<string, RegistryEntry> {
  const owners = new Map<string, RegistryEntry | null>();
  for (const entry of entries) {
    for (const folder of entry.folders) {
      const key = folder.toLowerCase();
      const current = owners.get(key);
      owners.set(key, current === undefined || current === entry ? entry : null);
    }
  }
  return new Map([...owners].filter((kv): kv is [string, RegistryEntry] => kv[1] !== null));
}

/** Up to MAX_SUGGESTIONS catalogue sources for a group: exact folder-set matches first, then by downloads. */
function catalogSuggestions(catalog: CatalogEntry[], root: string, folders: string[]): string[] {
  const rootKey = root.toLowerCase();
  const wanted = new Set(folders.map((f) => f.toLowerCase()));
  const exact = (e: CatalogEntry) =>
    e.folders.length === wanted.size && e.folders.every((f) => wanted.has(f.toLowerCase())) ? 0 : 1;
  return catalog
    .filter((e) => e.folders.some((f) => f.toLowerCase() === rootKey))
    .sort((a, b) => exact(a) - exact(b) || b.downloadsMonthly - a.downloadsMonthly)
    .slice(0, MAX_SUGGESTIONS)
    .map((e) => `wowi:${e.id}`);
}

const GITHUB_SLUG = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/;
const GITHUB_URL = /(?:https?:\/\/|git@)?github\.com[:/]([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)/i;

function parseGithubRef(raw: string, allowBareSlug: boolean): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const urlMatch = GITHUB_URL.exec(trimmed);
  if (urlMatch) {
    const repo = urlMatch[2]!.replace(/\.git$/i, "");
    const candidate = `github:${urlMatch[1]!}/${repo}`;
    try {
      parseSource(candidate);
      return candidate;
    } catch {
      return null;
    }
  }
  if (allowBareSlug) {
    const slugMatch = GITHUB_SLUG.exec(trimmed);
    if (slugMatch) {
      const repo = slugMatch[2]!.replace(/\.git$/i, "");
      const candidate = `github:${slugMatch[1]!}/${repo}`;
      try {
        parseSource(candidate);
        return candidate;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function fieldValue(fields: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(fields)) {
    if (k.toLowerCase() === lower && v.trim() !== "") return v.trim();
  }
  return undefined;
}

/** Detects a supported wowget source (`github:...` or `wowi:...`) from TOC metadata fields. */
export function detectSourceFromFields(fields: Record<string, string>): string | null {
  for (const key of ["X-GitHub", "X-GitHub-Repo", "X-Repository"]) {
    const val = fieldValue(fields, key);
    if (val) {
      const gh = parseGithubRef(val, true);
      if (gh) return gh;
    }
  }
  for (const key of ["X-Website", "X-Curse-Repository-ID"]) {
    const val = fieldValue(fields, key);
    if (val) {
      const gh = parseGithubRef(val, false);
      if (gh) return gh;
    }
  }
  const wowi = fieldValue(fields, "X-WoWI-ID");
  if (wowi && /^[1-9][0-9]*$/.test(wowi)) return `wowi:${wowi}`;
  return null;
}

function parseDeps(fields: Record<string, string>): string[] {
  const out: string[] = [];
  for (const key of ["Dependencies", "RequiredDeps"]) {
    const val = fieldValue(fields, key);
    if (!val) continue;
    for (const part of val.split(/[,\s]+/)) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

async function readFolderMeta(targetDir: string, folder: string): Promise<FolderMeta> {
  const dir = join(targetDir, folder);
  const tocs = await addonTocs(dir);
  let version: string | null = null;
  let source: string | null = null;
  const deps = new Set<string>();
  for (const file of tocs) {
    const toc = parseToc(await readFile(join(dir, file), "utf8"));
    if (!version && toc.version) version = toc.version;
    if (!source) source = detectSourceFromFields(toc.fields);
    for (const d of parseDeps(toc.fields)) deps.add(d);
  }
  return { folder, version, source, deps: [...deps] };
}

/**
 * Scans `targetDir` for addon folders not owned by any active install on `targetName`, grouping
 * companion folders with their parent addon.
 */
export async function scanUnmanaged(
  targetDir: string,
  targetName: string,
  state: State,
  hints: ReconcileHints = {},
): Promise<UnmanagedAddon[]> {
  let entries;
  try {
    entries = await readdir(targetDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = entries
    .filter((e) => e.isDirectory() && e.name !== "__MACOSX" && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const metas: FolderMeta[] = [];
  for (const folder of candidates) {
    if (state.folderOwners(targetName, folder).length > 0) continue;
    if (!(await isAddonFolder(join(targetDir, folder)))) continue;
    metas.push(await readFolderMeta(targetDir, folder));
  }
  if (!metas.length) return [];

  const byRegistryFolder = registryFolders(hints.registry ?? []);
  for (const meta of metas) {
    if (meta.source) continue;
    const entry = byRegistryFolder.get(meta.folder.toLowerCase());
    if (entry) {
      meta.source = entry.source;
      meta.registryName = entry.name;
    }
  }

  const byLower = new Map(metas.map((m) => [m.folder.toLowerCase(), m]));

  // Find the parent folder of a companion folder by explicit dependency or name prefix.
  const parentOf = (meta: FolderMeta): FolderMeta | undefined => {
    for (const dep of meta.deps) {
      const target = byLower.get(dep.toLowerCase());
      if (target && target !== meta && (!meta.source || !target.source || meta.source === target.source)) {
        return target;
      }
    }
    let best: FolderMeta | undefined;
    const lower = meta.folder.toLowerCase();
    for (const other of metas) {
      if (other === meta) continue;
      const prefix = other.folder.toLowerCase();
      if ((lower.startsWith(`${prefix}_`) || lower.startsWith(`${prefix}-`)) && (!best || prefix.length > best.folder.length)) {
        if (!meta.source || !other.source || meta.source === other.source) best = other;
      }
    }
    return best;
  };

  const rootOf = (meta: FolderMeta): FolderMeta => {
    const seen = new Set<FolderMeta>([meta]);
    let cur = meta;
    while (true) {
      const next = parentOf(cur);
      if (!next || seen.has(next)) return cur;
      seen.add(next);
      cur = next;
    }
  };

  const groups = new Map<FolderMeta, FolderMeta[]>();
  for (const meta of metas) {
    const root = rootOf(meta);
    const list = groups.get(root) ?? [];
    list.push(meta);
    groups.set(root, list);
  }

  // Merge groups that resolved to the same detected source.
  const bySource = new Map<string, FolderMeta[]>();
  const unmerged: [FolderMeta, FolderMeta[]][] = [];
  for (const [root, members] of groups) {
    const source = root.source ?? members.find((m) => m.source)?.source ?? null;
    if (source) {
      const existing = bySource.get(source);
      if (existing) {
        existing.push(...members);
        continue;
      }
      bySource.set(source, [...members]);
    }
    unmerged.push([root, members]);
  }

  const out: UnmanagedAddon[] = [];
  const emittedSources = new Set<string>();
  for (const [root, rawMembers] of unmerged) {
    const source = root.source ?? rawMembers.find((m) => m.source)?.source ?? null;
    if (source && emittedSources.has(source)) continue;
    if (source) emittedSources.add(source);
    const members = source ? bySource.get(source)! : rawMembers;
    const folders = members.map((m) => m.folder).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const version = root.version ?? members.find((m) => m.version)?.version ?? null;
    let name = root.folder;
    const registryName = members.find((m) => m.registryName && m.source === source)?.registryName;
    if (registryName) name = registryName;
    else if (source) {
      const preferred = defaultAddonName(parseSource(source));
      const match = members.find((m) => m.folder.toLowerCase() === preferred.toLowerCase());
      if (match) name = match.folder;
    }
    const addon: UnmanagedAddon = { name, target: targetName, folders, version, source };
    if (!source && hints.catalog?.length) {
      const suggestions = catalogSuggestions(hints.catalog, root.folder, folders);
      if (suggestions.length) addon.suggestions = suggestions;
    }
    out.push(addon);
  }
  return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}
