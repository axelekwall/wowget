import { lstat, mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WowgetError } from "./errors.ts";
import type { OnEvent } from "./events.ts";
import type { Flavor } from "./flavor.ts";
import { HttpClient, type FetchFn } from "./http.ts";
import { install as installRelease, uninstall } from "./installer.ts";
import {
  addAddon,
  appendAddonText,
  createManifest,
  findAddon,
  parseManifest,
  readManifest,
  removeAddon,
  type AddonEntry,
  type InstallConfig,
  type Manifest,
} from "./manifest.ts";
import { cacheDir as defaultCacheDir, expandHome, GAME_DIR } from "./paths.ts";
import { sourceFor } from "./sources/index.ts";
import { defaultAddonName, parseSource } from "./sources/parse.ts";
import type { Http, Resolved } from "./sources/types.ts";
import type { InstallRecord, State } from "./state.ts";

export interface OpsOptions {
  manifestPath: string;
  state: State;
  /** Defaults to paths.cacheDir(). */
  cacheDir?: string;
  force?: boolean;
  fetch?: FetchFn;
  /** Read for GITHUB_TOKEN; defaults to process.env. */
  env?: Record<string, string | undefined>;
  onEvent?: OnEvent;
}

interface Context {
  manifest: Manifest;
  http: Http;
  cacheDir: string;
  opts: OpsOptions;
}

async function context(opts: OpsOptions): Promise<Context> {
  return {
    manifest: await readManifest(opts.manifestPath),
    http: new HttpClient({ state: opts.state, fetch: opts.fetch, env: opts.env }),
    cacheDir: opts.cacheDir ?? defaultCacheDir(),
    opts,
  };
}

function resolveEntry(ctx: Context, entry: AddonEntry): Promise<Resolved> {
  return sourceFor(parseSource(entry.source)).resolve({
    addon: entry.name,
    flavor: ctx.manifest.install.flavor,
    prerelease: entry.prerelease,
    pin: entry.pin,
    http: ctx.http,
    cacheDir: ctx.cacheDir,
    onEvent: ctx.opts.onEvent,
  });
}

function installEntry(ctx: Context, entry: AddonEntry, resolved: Resolved) {
  return installRelease({
    addon: entry.name,
    resolved,
    targetDir: ctx.manifest.install.path,
    flavor: ctx.manifest.install.flavor,
    state: ctx.opts.state,
    force: ctx.opts.force,
    cacheDir: ctx.cacheDir,
    // The URL source's release id is the file's hash, so the cached copy can be checked against it.
    sha256: parseSource(entry.source).kind === "url" ? resolved.releaseId : undefined,
    fetch: ctx.opts.fetch,
    onEvent: ctx.opts.onEvent,
  });
}

/** An install is current when it came from the same source string and release. */
function isCurrent(active: InstallRecord | undefined, entry: AddonEntry, resolved: Resolved): boolean {
  return active !== undefined && active.source === entry.source && active.releaseId === resolved.releaseId;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** Folders of the install that are absent from the AddOns directory. */
async function missingFolders(installPath: string, active: InstallRecord): Promise<string[]> {
  const missing: string[] = [];
  for (const folder of active.folders) {
    if (!(await pathExists(join(installPath, folder)))) missing.push(folder);
  }
  return missing;
}

/** Installs over an existing install, which is a repair when the release is unchanged. */
async function reinstall(ctx: Context, entry: AddonEntry, resolved: Resolved, active: InstallRecord): Promise<UpdateEntry> {
  const result = await installEntry(ctx, entry, resolved);
  if (isCurrent(active, entry, resolved)) {
    return { name: entry.name, status: "repaired", version: result.version, folders: result.folders };
  }
  return { name: entry.name, status: "updated", from: active.version ?? active.releaseId, to: result.version, folders: result.folders };
}

// init

export interface InitOptions {
  manifestPath: string;
  /** AddOns directory; created if missing. */
  path?: string;
  flavor?: Flavor;
  /** Defaults to paths.GAME_DIR. */
  gameDir?: string;
}

export interface InitResult {
  manifestPath: string;
  install: InstallConfig;
  /** True when the AddOns directory did not exist and was created. */
  createdAddonsDir: boolean;
}

export async function init(opts: InitOptions): Promise<InitResult> {
  const flavor = opts.flavor ?? "forever";
  if (await Bun.file(opts.manifestPath).exists()) {
    throw new WowgetError("manifest_exists", `A manifest already exists at ${opts.manifestPath}.`);
  }

  if (opts.path === "") throw new WowgetError("usage", "--path must not be empty.");
  let path: string;
  if (opts.path !== undefined) {
    path = resolve(expandHome(opts.path));
  } else {
    if (flavor !== "forever") {
      throw new WowgetError("usage", `No default install path for flavor "${flavor}"; pass --path.`);
    }
    const versionDir = join(opts.gameDir ?? GAME_DIR, "_forever_");
    const found = await stat(versionDir).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!found) {
      throw new WowgetError("not_found", `No World of Warcraft install found at ${versionDir}; pass --path to the AddOns directory.`);
    }
    path = join(versionDir, "Interface", "AddOns");
  }

  const existing = await stat(path).catch(() => undefined);
  if (existing && !existing.isDirectory()) throw new WowgetError("io", `${path} exists and is not a directory.`);
  if (!existing) await mkdir(path, { recursive: true });

  const manifest = await createManifest(opts.manifestPath, { path, flavor });
  return { manifestPath: opts.manifestPath, install: manifest.install, createdAddonsDir: !existing };
}

// add

export interface AddOptions extends OpsOptions {
  source: string;
  name?: string;
  prerelease?: boolean;
  pin?: string;
}

export interface AddResult {
  name: string;
  source: string;
  releaseId: string;
  version: string;
  folders: string[];
}

export async function add(opts: AddOptions): Promise<AddResult> {
  const ctx = await context(opts);
  const spec = parseSource(opts.source);
  if (opts.prerelease && spec.kind !== "github") {
    throw new WowgetError("usage", "--prerelease only applies to GitHub sources.");
  }
  const name = opts.name ?? defaultAddonName(spec);
  if (findAddon(ctx.manifest, name)) {
    throw new WowgetError("duplicate", `An addon named "${name}" is already in the manifest.`);
  }
  const entry: AddonEntry = { name, source: opts.source, prerelease: opts.prerelease ?? false };
  if (opts.pin !== undefined) entry.pin = opts.pin;
  // Catch an entry the manifest would reject before downloading anything.
  try {
    parseManifest(appendAddonText(await readFile(opts.manifestPath, "utf8"), entry));
  } catch (err) {
    if (!(err instanceof WowgetError && err.code === "manifest")) throw err;
    throw new WowgetError("usage", `Cannot add "${name}": ${err.message}`, { cause: err });
  }

  const resolved = await resolveEntry(ctx, entry);
  const installed = await installEntry(ctx, entry, resolved);
  try {
    await addAddon(opts.manifestPath, entry);
  } catch (err) {
    try {
      await uninstall({ addon: name, targetDir: ctx.manifest.install.path, state: opts.state });
    } catch (rollbackErr) {
      const code = err instanceof WowgetError ? err.code : "io";
      throw new WowgetError(code, `${message(err)} Uninstalling ${name} again also failed: ${message(rollbackErr)}`, {
        cause: err,
      });
    }
    throw err;
  }
  return { name, source: opts.source, releaseId: installed.releaseId, version: installed.version, folders: installed.folders };
}

// remove

export interface RemoveOptions extends Pick<OpsOptions, "manifestPath" | "state"> {
  name: string;
}

export interface RemoveResult {
  name: string;
  wasInstalled: boolean;
  removedFolders: string[];
}

export async function remove(opts: RemoveOptions): Promise<RemoveResult> {
  const manifest = await readManifest(opts.manifestPath);
  const entry = findAddon(manifest, opts.name);
  if (!entry) throw new WowgetError("not_found", `No addon named "${opts.name}" in the manifest.`);
  const result = await uninstall({ addon: entry.name, targetDir: manifest.install.path, state: opts.state });
  await removeAddon(opts.manifestPath, entry.name);
  return { name: entry.name, wasInstalled: result.wasInstalled, removedFolders: result.removedFolders };
}

// list

export type ListStatus = "ok" | "missing" | "not installed";

export interface ListEntry {
  name: string;
  source: string;
  version: string | null;
  releaseId: string | null;
  status: ListStatus;
  /** Recorded folders that are absent on disk. */
  missingFolders: string[];
}

export interface ListResult {
  installPath: string;
  flavor: Flavor;
  addons: ListEntry[];
}

export async function list(opts: Pick<OpsOptions, "manifestPath" | "state">): Promise<ListResult> {
  const manifest = await readManifest(opts.manifestPath);
  const addons: ListEntry[] = [];
  for (const entry of manifest.addons) {
    const active = opts.state.getActiveInstall(entry.name);
    if (!active) {
      addons.push({ name: entry.name, source: entry.source, version: null, releaseId: null, status: "not installed", missingFolders: [] });
      continue;
    }
    const missing = await missingFolders(manifest.install.path, active);
    addons.push({
      name: entry.name,
      source: entry.source,
      version: active.version ?? active.releaseId,
      releaseId: active.releaseId,
      status: missing.length ? "missing" : "ok",
      missingFolders: missing,
    });
  }
  return { installPath: manifest.install.path, flavor: manifest.install.flavor, addons };
}

// outdated

export type OutdatedEntry =
  | { name: string; status: "current"; version: string }
  | { name: string; status: "outdated"; installed: string; latest: string }
  | { name: string; status: "not installed"; latest: string }
  /** Recorded folders are absent on disk; `update` reinstalls. */
  | { name: string; status: "missing"; installed: string; latest: string; missingFolders: string[] }
  | { name: string; status: "error"; error: string };

export interface OutdatedResult {
  addons: OutdatedEntry[];
}

export async function outdated(opts: OpsOptions): Promise<OutdatedResult> {
  const ctx = await context(opts);
  const addons: OutdatedEntry[] = [];
  for (const entry of ctx.manifest.addons) {
    const name = entry.name;
    try {
      const resolved = await resolveEntry(ctx, entry);
      const active = opts.state.getActiveInstall(name);
      if (!active) {
        addons.push({ name, status: "not installed", latest: resolved.version });
        continue;
      }
      const installed = active.version ?? active.releaseId;
      const missing = await missingFolders(ctx.manifest.install.path, active);
      if (missing.length) addons.push({ name, status: "missing", installed, latest: resolved.version, missingFolders: missing });
      else if (isCurrent(active, entry, resolved)) addons.push({ name, status: "current", version: resolved.version });
      else addons.push({ name, status: "outdated", installed, latest: resolved.version });
    } catch (err) {
      addons.push({ name, status: "error", error: message(err) });
    }
  }
  return { addons };
}

// update and install

export type UpdateEntry =
  | { name: string; status: "current"; version: string }
  | { name: string; status: "updated"; from: string; to: string; folders: string[] }
  | { name: string; status: "installed"; version: string; folders: string[] }
  /** The same release was reinstalled because recorded folders were missing. */
  | { name: string; status: "repaired"; version: string; folders: string[] }
  | { name: string; status: "skipped"; version: string }
  | { name: string; status: "error"; error: string };

export interface UpdateResult {
  addons: UpdateEntry[];
}

export interface UpdateOptions extends OpsOptions {
  /** Manifest names to update; empty or absent means all. */
  names?: string[];
}

export async function update(opts: UpdateOptions): Promise<UpdateResult> {
  const ctx = await context(opts);
  const names = opts.names ?? [];
  const entries = names.length
    ? names.map((n) => {
        const entry = findAddon(ctx.manifest, n);
        if (!entry) throw new WowgetError("not_found", `No addon named "${n}" in the manifest.`);
        return entry;
      })
    : ctx.manifest.addons;

  const addons: UpdateEntry[] = [];
  for (const entry of entries) {
    const name = entry.name;
    try {
      const resolved = await resolveEntry(ctx, entry);
      const active = opts.state.getActiveInstall(name);
      if (active) {
        const intact = !(await missingFolders(ctx.manifest.install.path, active)).length;
        if (intact && isCurrent(active, entry, resolved)) addons.push({ name, status: "current", version: resolved.version });
        else addons.push(await reinstall(ctx, entry, resolved, active));
        continue;
      }
      const result = await installEntry(ctx, entry, resolved);
      addons.push({ name, status: "installed", version: result.version, folders: result.folders });
    } catch (err) {
      addons.push({ name, status: "error", error: message(err) });
    }
  }
  return { addons };
}

/**
 * Installs every manifest addon without an active install and reinstalls those with missing
 * folders; the rest are skipped without network access.
 */
export async function install(opts: OpsOptions): Promise<UpdateResult> {
  const ctx = await context(opts);
  const addons: UpdateEntry[] = [];
  for (const entry of ctx.manifest.addons) {
    const name = entry.name;
    const active = opts.state.getActiveInstall(name);
    if (active && !(await missingFolders(ctx.manifest.install.path, active)).length) {
      addons.push({ name, status: "skipped", version: active.version ?? active.releaseId });
      continue;
    }
    try {
      const resolved = await resolveEntry(ctx, entry);
      if (active) {
        addons.push(await reinstall(ctx, entry, resolved, active));
        continue;
      }
      const result = await installEntry(ctx, entry, resolved);
      addons.push({ name, status: "installed", version: result.version, folders: result.folders });
    } catch (err) {
      addons.push({ name, status: "error", error: message(err) });
    }
  }
  return { addons };
}
