import { lstat, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { detectInstalls, findVersionFolder, type DetectedInstall } from "./detect.ts";
import {
  findStaleCacheDirs,
  inspectTarget,
  pruneAddonCache,
  type DoctorHint,
  type DoctorIssue,
  type DoctorTargetReport,
} from "./doctor.ts";
import { WowgetError } from "./errors.ts";
import type { OnEvent } from "./events.ts";
import { FLAVORS, type Flavor } from "./flavor.ts";
import { HttpClient, type FetchFn } from "./http.ts";
import {
  install as installRelease,
  removeBestEffort,
  uninstall,
  type InstallOptions,
  type UninstallResult,
} from "./installer.ts";
import {
  addAddon,
  addonTargets,
  addTarget,
  appendAddonText,
  createManifest,
  findAddon,
  findTarget,
  isTargetName,
  isVersionFolderName,
  parseManifest,
  planRemoveAddon,
  planRemoveTarget,
  planSetAddonPin,
  planSetAddonTargets,
  planTargetFolders,
  readManifest,
  readManifestText,
  setAddonTargets,
  writePlanned,
  type AddonEntry,
  type Manifest,
  type NamedTarget,
  type ResolvedTarget,
} from "./manifest.ts";
import { cacheDir as defaultCacheDir, expandHome, gameDirCandidates } from "./paths.ts";
import { scanUnmanaged, type UnmanagedAddon } from "./reconcile.ts";
import { enabledEntries, findRegistryEntry, loadRegistry, normaliseName, type RegistryEntry } from "./registry.ts";
import { searchGithub } from "./search/github-search.ts";
import { rankRows, type Origin, type SearchRow } from "./search/index.ts";
import { registryRows } from "./search/registry.ts";
import { catalogRow, loadCatalog, readCachedCatalog } from "./search/wowi-catalog.ts";
import { sourceFor } from "./sources/index.ts";
import { defaultAddonName, parseSource } from "./sources/parse.ts";
import type { Http, Resolved } from "./sources/types.ts";
import type { InstallRecord, State } from "./state.ts";
import { MAX_ISSUE_URL_LENGTH, sourceKey, suggestIssueUrl } from "./suggest.ts";

export interface OpsOptions {
  manifestPath: string;
  state: State;
  /** Target names to act on; empty or absent means every target. */
  targets?: string[];
  /** Defaults to paths.cacheDir(). */
  cacheDir?: string;
  force?: boolean;
  fetch?: FetchFn;
  /** Read for GITHUB_TOKEN and WOWGET_GAME_DIR; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Searched in order for the version folder of `folder` targets. Defaults to paths.gameDirCandidates(). */
  gameDirs?: string[];
  onEvent?: OnEvent;
}

interface Loaded {
  manifest: Manifest;
  /** The targets the command acts on, in manifest order. */
  targets: ResolvedTarget[];
}

/** A `folder` target whose version folder is in none of the game directories. */
interface AbsentTarget {
  name: string;
  flavor: Flavor;
  folder: string;
  path?: undefined;
}

type GameDirOptions = Pick<OpsOptions, "env" | "gameDirs">;

function gameDirsFor(opts: GameDirOptions): string[] {
  return (opts.gameDirs ?? gameDirCandidates(process.platform, opts.env ?? process.env)).map((d) => resolve(expandHome(d)));
}

/** Locates each target's AddOns directory on this machine, in the order given. */
async function locateTargets(targets: NamedTarget[], gameDirs: string[]): Promise<(ResolvedTarget | AbsentTarget)[]> {
  const located: (ResolvedTarget | AbsentTarget)[] = [];
  for (const t of targets) {
    if (t.folder === undefined) {
      located.push({ name: t.name, flavor: t.flavor, path: t.path! });
      continue;
    }
    const path = await findVersionFolder(t.folder, gameDirs);
    located.push(path ? { name: t.name, flavor: t.flavor, path, folder: t.folder } : { name: t.name, flavor: t.flavor, folder: t.folder });
  }
  return located;
}

function absentReason(target: AbsentTarget, gameDirs: string[]): string {
  if (!gameDirs.length) return `no game directory to look for ${target.folder} in; set WOWGET_GAME_DIR`;
  return `no ${target.folder} folder in ${gameDirs.join(", ")}`;
}

interface Context extends Loaded {
  http: Http;
  cacheDir: string;
  opts: OpsOptions;
  /** Resolutions of this run, keyed by source, flavor, prerelease, pin and, for URL sources, addon. */
  resolutions: Map<string, Promise<Resolved>>;
}

/** One (addon, target) pair a command acts on. */
interface Row {
  entry: AddonEntry;
  target: ResolvedTarget;
}

function selectTargets(manifest: Manifest, manifestPath: string, filter: string[] | undefined): NamedTarget[] {
  if (!manifest.targets.length) {
    throw new WowgetError("manifest", `${manifestPath} has no targets; add one with "wowget target add".`);
  }
  if (!filter?.length) return manifest.targets;
  const names = manifest.targets.map((t) => t.name);
  const unknown = filter.filter((n) => !names.includes(n));
  if (unknown.length) {
    const list = unknown.map((n) => `"${n}"`).join(", ");
    throw new WowgetError("usage", `Unknown target ${list}; the manifest has: ${names.join(", ")}.`);
  }
  return manifest.targets.filter((t) => filter.includes(t.name));
}

/**
 * Reads the manifest and locates the selected targets. Without a filter, targets that are not on
 * this machine are skipped with an event; a filter naming one is an error.
 */
async function load(opts: Pick<OpsOptions, "manifestPath" | "targets" | "env" | "gameDirs" | "onEvent">): Promise<Loaded> {
  const manifest = await readManifest(opts.manifestPath);
  const gameDirs = gameDirsFor(opts);
  const located = await locateTargets(selectTargets(manifest, opts.manifestPath, opts.targets), gameDirs);
  const targets = located.filter((t): t is ResolvedTarget => t.path !== undefined);
  const absent = located.filter((t): t is AbsentTarget => t.path === undefined);
  if (absent.length && (opts.targets?.length || !targets.length)) {
    const first = absent[0]!;
    throw new WowgetError("not_found", `Target "${first.name}" is not on this machine: ${absentReason(first, gameDirs)}.`);
  }
  for (const t of absent) {
    opts.onEvent?.({ type: "target:absent", target: t.name, message: `skipping target "${t.name}": ${absentReason(t, gameDirs)}` });
  }
  return { manifest, targets };
}

/**
 * Uninstalls from a target. For a target not on this machine it only forgets the install, with an
 * event, since its folders cannot be reached.
 */
async function uninstallFrom(
  target: ResolvedTarget | AbsentTarget,
  addon: string,
  state: State,
  onEvent: OnEvent | undefined,
): Promise<UninstallResult> {
  if (target.path !== undefined) return uninstall({ target: target.name, addon, targetDir: target.path, state });
  const wasInstalled = state.getActiveInstall(target.name, addon) !== undefined;
  if (wasInstalled) {
    state.deactivateInstall(target.name, addon);
    onEvent?.({
      type: "target:absent",
      target: target.name,
      message: `target "${target.name}" is not on this machine; forgot ${addon} there without deleting its folders`,
    });
  }
  return { addon, removedFolders: [], wasInstalled };
}

async function context(opts: OpsOptions): Promise<Context> {
  return {
    ...(await load(opts)),
    http: new HttpClient({ state: opts.state, fetch: opts.fetch, env: opts.env }),
    cacheDir: opts.cacheDir ?? defaultCacheDir(),
    opts,
    resolutions: new Map(),
  };
}

function byName(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The (addon, target) pairs for `entries` on the selected targets, by addon name then target name. */
function rowsFor(loaded: Loaded, entries: AddonEntry[]): Row[] {
  const rows: Row[] = [];
  for (const entry of [...entries].sort((a, b) => byName(a.name, b.name))) {
    const on = addonTargets(loaded.manifest, entry);
    const targets = loaded.targets.filter((t) => on.includes(t.name)).sort((a, b) => byName(a.name, b.name));
    for (const target of targets) rows.push({ entry, target });
  }
  return rows;
}

function resolveRow(ctx: Context, { entry, target }: Row): Promise<Resolved> {
  const spec = parseSource(entry.source);
  // The URL source keeps its cache record per addon, so addons sharing a URL each resolve.
  const addon = spec.kind === "url" ? entry.name.toLowerCase() : null;
  const key = JSON.stringify([entry.source, target.flavor, entry.prerelease, entry.pin ?? null, addon]);
  let pending = ctx.resolutions.get(key);
  if (!pending) {
    pending = sourceFor(spec).resolve({
      addon: entry.name,
      flavor: target.flavor,
      prerelease: entry.prerelease,
      pin: entry.pin,
      http: ctx.http,
      cacheDir: ctx.cacheDir,
      onEvent: ctx.opts.onEvent,
    });
    ctx.resolutions.set(key, pending);
  }
  return pending;
}

const RESOLVE_CONCURRENCY = 6;

/** Warms `ctx.resolutions` with bounded concurrency so sequential row loops do not wait in series. */
async function preResolve(ctx: Context, rows: Row[]): Promise<void> {
  const queue = [...rows];
  const workers = Array.from({ length: Math.min(RESOLVE_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const row = queue.shift()!;
      await resolveRow(ctx, row).catch(() => {});
    }
  });
  await Promise.all(workers);
}

function installRow(ctx: Context, { entry, target }: Row, resolved: Resolved, extra?: Pick<InstallOptions, "keepOld">) {
  return installRelease({
    ...extra,
    target: target.name,
    addon: entry.name,
    resolved,
    targetDir: target.path,
    flavor: target.flavor,
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
/**
 * The active install when the entry is pinned and that release is installed with all its folders.
 * Such rows are current without asking the source, which for URL and WoWInterface sources can only
 * serve the latest file and would otherwise report the pin as an error once the source moves on.
 */
async function installedAtPin(state: State, row: Row): Promise<InstallRecord | undefined> {
  const { entry, target } = row;
  if (entry.pin === undefined) return undefined;
  const active = state.getActiveInstall(target.name, entry.name);
  if (!active || active.source !== entry.source || active.releaseId !== entry.pin) return undefined;
  return (await missingFolders(target.path, active)).length ? undefined : active;
}

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

/** Creates the AddOns directory if needed; returns whether it was created. */
async function ensureDir(path: string): Promise<boolean> {
  const existing = await stat(path).catch(() => undefined);
  if (existing && !existing.isDirectory()) throw new WowgetError("io", `${path} exists and is not a directory.`);
  if (!existing) await mkdir(path, { recursive: true });
  return !existing;
}

/**
 * Folders of the install that are absent from the AddOns directory, plus those another addon took
 * over with --force.
 */
async function missingFolders(installPath: string, active: InstallRecord): Promise<string[]> {
  const missing: string[] = [];
  for (const folder of active.folders) {
    if (!(await pathExists(join(installPath, folder)))) missing.push(folder);
  }
  return [...missing, ...active.displacedFolders].sort();
}

/** The installer's leftover holding directory, as an optional result field. */
function leftover(result: { leftoverDir?: string }): { leftoverDir?: string } {
  return result.leftoverDir ? { leftoverDir: result.leftoverDir } : {};
}

/** Installs over an existing install, which is a repair when the release is unchanged. */
async function reinstall(ctx: Context, row: Row, resolved: Resolved, active: InstallRecord): Promise<UpdateEntry> {
  const result = await installRow(ctx, row, resolved);
  const ids = { name: row.entry.name, target: row.target.name };
  if (isCurrent(active, row.entry, resolved)) {
    return { ...ids, status: "repaired", version: result.version, folders: result.folders, ...leftover(result) };
  }
  return {
    ...ids,
    status: "updated",
    from: active.version ?? active.releaseId,
    to: result.version,
    folders: result.folders,
    ...leftover(result),
  };
}

function checkTargetName(name: string): void {
  if (!isTargetName(name)) {
    throw new WowgetError(
      "usage",
      `Target name "${name}" must start with a-z or 0-9 and contain only a-z, 0-9, "_" and "-".`,
    );
  }
}

function absolutePath(path: string, flag: string): string {
  if (path === "") throw new WowgetError("usage", `${flag} must not be empty.`);
  return resolve(expandHome(path));
}

// init

export interface InitOptions extends GameDirOptions {
  manifestPath: string;
  /** AddOns directory of the single target to add; created if missing. Without it the game directory is scanned. */
  path?: string;
  /** With `path`; defaults to "forever". */
  flavor?: Flavor;
  /** With `path`; defaults to the flavor name. */
  name?: string;
  /** Scanned for version folders when `path` is absent, instead of `gameDirs`. */
  gameDir?: string;
  /** Write `folder` targets, which every machine locates in its own game directory. */
  portable?: boolean;
}

/** A manifest target and where its AddOns directory is on this machine. */
export interface TargetInfo {
  name: string;
  flavor: Flavor;
  /** Set for `folder` targets. */
  folder?: string;
  /** The AddOns directory; null for a `folder` target that is not on this machine. */
  path: string | null;
}

export interface InitTarget extends TargetInfo {
  path: string;
  /** True when the AddOns directory did not exist and was created. */
  createdAddonsDir: boolean;
}

export interface InitResult {
  manifestPath: string;
  targets: InitTarget[];
}

/**
 * Creates the manifest. With `portable`, installs found in the default game directories (or
 * WOWGET_GAME_DIR) become `folder` targets, which every machine locates for itself; it does not
 * combine with `path` or `gameDir`, since later runs would not look in that directory.
 */
export async function init(opts: InitOptions): Promise<InitResult> {
  if (await Bun.file(opts.manifestPath).exists()) {
    throw new WowgetError("manifest_exists", `A manifest already exists at ${opts.manifestPath}.`);
  }

  if (opts.portable && (opts.path !== undefined || opts.gameDir !== undefined)) {
    throw new WowgetError("usage", "--portable does not apply together with --path or --game-dir; set WOWGET_GAME_DIR instead.");
  }
  let targets: NamedTarget[];
  let paths: string[];
  if (opts.path !== undefined) {
    if (opts.gameDir !== undefined) throw new WowgetError("usage", "--game-dir does not apply together with --path.");
    const path = absolutePath(opts.path, "--path");
    const flavor = opts.flavor ?? "forever";
    const name = opts.name ?? flavor;
    checkTargetName(name);
    targets = [{ name, path, flavor }];
    paths = [path];
  } else {
    if (opts.name !== undefined || opts.flavor !== undefined) {
      throw new WowgetError("usage", "--name and --flavor only apply together with --path.");
    }
    const candidates = opts.gameDir !== undefined ? [absolutePath(opts.gameDir, "--game-dir")] : gameDirsFor(opts);
    let found: DetectedInstall[] = [];
    for (const gameDir of candidates) {
      found = await detectInstalls(gameDir);
      if (found.length) break;
    }
    if (!found.length) {
      const tried = candidates.length
        ? `No World of Warcraft installs found in ${candidates.join(", ")}`
        : "No default game directory on this platform";
      throw new WowgetError("not_found", `${tried}; pass --game-dir, or --path to an AddOns directory.`);
    }
    // A folder target resolves to the first game directory holding that folder, which may not be
    // the one scanned here; the path is written instead so it cannot point elsewhere later.
    const located = await Promise.all(found.map((d) => findVersionFolder(basename(d.versionDir), candidates)));
    targets = found.map((d, i) =>
      opts.portable && located[i] === d.addonsDir
        ? { name: d.name, folder: basename(d.versionDir), flavor: d.flavor }
        : { name: d.name, path: d.addonsDir, flavor: d.flavor },
    );
    paths = found.map((d) => d.addonsDir);
  }

  const created: boolean[] = [];
  for (const path of paths) created.push(await ensureDir(path));
  const manifest = await createManifest(opts.manifestPath, targets);
  return {
    manifestPath: opts.manifestPath,
    targets: manifest.targets.map((t, i) => ({ ...targetInfo(t, paths[i]!), path: paths[i]!, createdAddonsDir: created[i]! })),
  };
}

function targetInfo(t: NamedTarget, path: string | undefined): TargetInfo {
  return { name: t.name, flavor: t.flavor, ...(t.folder !== undefined ? { folder: t.folder } : {}), path: path ?? null };
}

// target list, add, remove

export interface TargetListEntry extends TargetInfo {
  /** Whether the AddOns directory exists. */
  exists: boolean;
}

export interface TargetListResult {
  targets: TargetListEntry[];
}

export async function targetList(opts: Pick<OpsOptions, "manifestPath" | "env" | "gameDirs">): Promise<TargetListResult> {
  const manifest = await readManifest(opts.manifestPath);
  const located = await locateTargets(manifest.targets, gameDirsFor(opts));
  const targets: TargetListEntry[] = [];
  for (const [i, t] of manifest.targets.entries()) {
    const path = located[i]!.path;
    const exists =
      path !== undefined &&
      (await stat(path).then(
        (s) => s.isDirectory(),
        () => false,
      ));
    targets.push({ ...targetInfo(t, path), exists });
  }
  return { targets };
}

export interface TargetAddOptions extends GameDirOptions {
  manifestPath: string;
  name: string;
  /** Exactly one of `path` and `folder`. */
  path?: string;
  folder?: string;
  flavor: Flavor;
}

export interface TargetAddResult {
  target: TargetInfo;
  createdAddonsDir: boolean;
}

/** Whether two resolved paths name the same directory; macOS and Windows file systems ignore case by default. */
function samePath(a: string, b: string): boolean {
  return process.platform === "darwin" || process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Adds a target. A `folder` target that is not on this machine is added all the same, for the other machines. */
export async function targetAdd(opts: TargetAddOptions): Promise<TargetAddResult> {
  checkTargetName(opts.name);
  if ((opts.path === undefined) === (opts.folder === undefined)) {
    throw new WowgetError("usage", '"target add" needs either --path or --folder.');
  }
  const manifest = await readManifest(opts.manifestPath);
  if (findTarget(manifest, opts.name)) {
    throw new WowgetError("duplicate", `A target named "${opts.name}" is already in the manifest.`);
  }
  let target: { path: string } | { folder: string };
  let path: string | undefined;
  if (opts.folder !== undefined) {
    if (!isVersionFolderName(opts.folder)) {
      throw new WowgetError("usage", `--folder "${opts.folder}" must be a single folder name in the game directory, such as "_retail_".`);
    }
    const folder = opts.folder;
    // Game directories are on case-insensitive file systems on macOS and Windows.
    const clash = manifest.targets.find((t) => t.folder?.toLowerCase() === folder.toLowerCase());
    if (clash) throw new WowgetError("usage", `${folder} is already the folder of target "${clash.name}".`);
    target = { folder };
    path = await findVersionFolder(folder, gameDirsFor(opts));
  } else {
    path = absolutePath(opts.path!, "--path");
    target = { path };
  }
  if (path !== undefined) {
    const located = await locateTargets(manifest.targets, gameDirsFor(opts));
    const clash = located.find((t) => t.path !== undefined && samePath(resolve(expandHome(t.path)), path!));
    if (clash) throw new WowgetError("usage", `${path} is already the path of target "${clash.name}".`);
  }
  const createdAddonsDir = path !== undefined && (await ensureDir(path));
  const updated = await addTarget(opts.manifestPath, opts.name, { ...target, flavor: opts.flavor });
  return { target: targetInfo(findTarget(updated, opts.name)!, path), createdAddonsDir };
}

/**
 * Whether the `path` target `target` can become a `folder` target: its path must be
 * `<game dir>/<folder>/Interface/AddOns` for the game directory a folder target would locate on
 * this machine, so the conversion changes nothing here. `others` are checked for the same folder.
 */
async function portableCheck(
  target: NamedTarget,
  others: NamedTarget[],
  gameDirs: string[],
): Promise<{ folder: string } | { reason: string }> {
  if (target.path === undefined) return { reason: `already a folder target (${target.folder})` };
  const addonsDir = resolve(expandHome(target.path));
  const interfaceDir = dirname(addonsDir);
  const folder = basename(dirname(interfaceDir));
  if (basename(addonsDir) !== "AddOns" || basename(interfaceDir) !== "Interface" || !isVersionFolderName(folder)) {
    return { reason: `${target.path} is not <game dir>/<version folder>/Interface/AddOns` };
  }
  const located = await findVersionFolder(folder, gameDirs);
  if (located !== addonsDir) {
    const where = located ? `would locate ${located} instead` : `would not be found in ${gameDirs.join(", ") || "any game directory"}`;
    return { reason: `a folder target ${folder} ${where}` };
  }
  // Game directories are on case-insensitive file systems on macOS and Windows.
  const clash = others.find((t) => t.name !== target.name && t.folder?.toLowerCase() === folder.toLowerCase());
  if (clash) return { reason: `${folder} is already the folder of target "${clash.name}"` };
  return { folder };
}

export interface TargetPortableOptions extends GameDirOptions {
  manifestPath: string;
  /** Targets to convert; empty or absent means every `path` target. */
  names?: string[];
}

export interface TargetPortableResult {
  /** Targets now written as `folder`, with the AddOns directory they locate here (unchanged). */
  converted: TargetInfo[];
  /** Targets left as they were, with the reason. */
  skipped: { name: string; reason: string }[];
}

/**
 * Rewrites `path` targets as `folder` targets where that locates the same AddOns directory on this
 * machine, so the manifest can be shared with machines that have the game somewhere else.
 */
export async function targetPortable(opts: TargetPortableOptions): Promise<TargetPortableResult> {
  const { text, manifest } = await readManifestText(opts.manifestPath);
  const named = opts.names?.length ? opts.names : undefined;
  if (named) {
    const unknown = named.filter((n) => !findTarget(manifest, n));
    if (unknown.length) {
      const valid = manifest.targets.map((t) => t.name).join(", ") || "none";
      throw new WowgetError("usage", `Unknown target ${unknown.map((n) => `"${n}"`).join(", ")}; the manifest has ${valid}.`);
    }
  }
  const gameDirs = gameDirsFor(opts);
  const selected = manifest.targets.filter((t) => (named ? named.includes(t.name) : t.path !== undefined));
  // Checked in manifest order against the result so far, so two targets cannot take one folder.
  let after = manifest.targets;
  const folders = new Map<string, string>();
  const converted: TargetInfo[] = [];
  const skipped: TargetPortableResult["skipped"] = [];
  for (const t of selected) {
    const check = await portableCheck(t, after, gameDirs);
    if ("reason" in check) {
      skipped.push({ name: t.name, reason: check.reason });
      continue;
    }
    folders.set(t.name, check.folder);
    after = after.map((a) => (a.name === t.name ? { name: a.name, folder: check.folder, flavor: a.flavor } : a));
    converted.push({ name: t.name, flavor: t.flavor, folder: check.folder, path: resolve(expandHome(t.path!)) });
  }
  if (folders.size) {
    await writePlanned(opts.manifestPath, text, planTargetFolders(text, folders, opts.manifestPath));
  }
  return { converted, skipped };
}

export interface RemoveEntry {
  name: string;
  target: string;
  wasInstalled: boolean;
  removedFolders: string[];
  /** The removed folders, which could not be deleted. */
  leftoverDir?: string;
}

function removeEntry(name: string, target: string, result: UninstallResult): RemoveEntry {
  return { name, target, wasInstalled: result.wasInstalled, removedFolders: result.removedFolders, ...leftover(result) };
}

/** Names what was already uninstalled in an error that stops a removal before the manifest is written. */
function stoppedAfter(err: unknown, done: RemoveEntry[]): unknown {
  const uninstalled = done.filter((r) => r.wasInstalled).map((r) => `${r.name} from ${r.target}`);
  if (!uninstalled.length) return err;
  const code = err instanceof WowgetError ? err.code : "io";
  return new WowgetError(
    code,
    `${message(err)} Already uninstalled: ${uninstalled.join(", ")}; the manifest was not changed.`,
    { cause: err },
  );
}

export interface TargetRemoveOptions extends Pick<OpsOptions, "manifestPath" | "state" | "env" | "gameDirs" | "onEvent"> {
  name: string;
}

export interface TargetRemoveResult {
  name: string;
  /** Addons whose manifest entries were removed because this was their last target. */
  removedAddons: string[];
  /** What was uninstalled from the target. */
  addons: RemoveEntry[];
}

/**
 * Uninstalls everything wowget installed on the target, then removes it from the manifest. The
 * manifest edit is computed and checked first, so an edit that cannot be made uninstalls nothing.
 */
export async function targetRemove(opts: TargetRemoveOptions): Promise<TargetRemoveResult> {
  const { text, manifest } = await readManifestText(opts.manifestPath);
  const target = findTarget(manifest, opts.name);
  if (!target) throw new WowgetError("not_found", `No target named "${opts.name}" in the manifest.`);
  const plan = planRemoveTarget(text, target.name, opts.manifestPath);
  const [located] = await locateTargets([target], gameDirsFor(opts));
  const addons: RemoveEntry[] = [];
  try {
    for (const active of opts.state.listActiveInstalls(target.name)) {
      const name = findAddon(manifest, active.addon)?.name ?? active.addon;
      const result = await uninstallFrom(located!, name, opts.state, opts.onEvent);
      addons.push(removeEntry(name, target.name, result));
    }
    await writePlanned(opts.manifestPath, text, plan.text);
  } catch (err) {
    throw stoppedAfter(err, addons);
  }
  return { name: target.name, removedAddons: plan.removedAddons, addons };
}

// add

export interface AddOptions extends OpsOptions {
  /** A source string, or an addon name looked up in the registry. */
  source: string;
  name?: string;
  prerelease?: boolean;
  pin?: string;
}

export interface AddEntry {
  name: string;
  target: string;
  releaseId: string;
  version: string;
  folders: string[];
  /** Previous copies of replaced folders that could not be deleted. */
  leftoverDir?: string;
  note?: string;
}

export interface AddResult {
  name: string;
  source: string;
  /** The name given on `add` when the source came from the registry. */
  registryName?: string;
  /** The `targets` list written to the manifest; absent when the addon is on every target. */
  targets?: string[];
  addons: AddEntry[];
}

/** Prefixes the error message with the target name, keeping the code. */
function onTarget(target: string, err: unknown): unknown {
  if (!(err instanceof WowgetError)) return err;
  return new WowgetError(err.code, `${target}: ${err.message}`, { cause: err });
}

/** A target `add` installed on, with what is needed to undo it. */
interface AddDone {
  target: ResolvedTarget;
  entry: AddEntry;
  /** The addon's active install on the target before this one, if any. */
  previous?: InstallRecord;
  /** Previous copies of the folders the install replaced. */
  oldDir?: string;
}

/** Removes what `add` installed on one target and puts back the folders it replaced. */
async function undoAdd(state: State, name: string, done: AddDone): Promise<void> {
  const { target, oldDir } = done;
  await uninstall({ target: target.name, addon: name, targetDir: target.path, state });
  if (oldDir) {
    const unrestored: string[] = [];
    for (const folder of await readdir(oldDir)) {
      await rename(join(oldDir, folder), join(target.path, folder)).catch(() => unrestored.push(folder));
    }
    if (unrestored.length) throw new WowgetError("io", `restoring ${unrestored.join(", ")} failed`);
    await removeBestEffort(oldDir);
  }
  if (done.previous) state.reactivateInstall(done.previous.id);
}

/** The registry entry for an `add` argument without a source kind; a source error when there is none. */
async function registryEntryFor(ctx: Context, name: string): Promise<RegistryEntry> {
  const registry = await loadRegistry(ctx.http, ctx.opts.env);
  if (registry.stale) ctx.opts.onEvent?.({ type: "registry:stale", message: registry.stale });
  const entry = findRegistryEntry(registry.entries, name);
  if (!entry) {
    const hint = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(name)
      ? `Did you mean "github:${name}"?`
      : `Try "wowget search ${name}", or give a source such as github:owner/repo.`;
    throw new WowgetError("source", `"${name}" is not in the addon registry. ${hint}`);
  }
  if (entry.disabled !== undefined) {
    throw new WowgetError(
      "source",
      `${entry.name} is disabled in the addon registry: ${entry.disabled}. Give its source (${entry.source}) to add it anyway.`,
    );
  }
  return entry;
}

export async function add(opts: AddOptions): Promise<AddResult> {
  if (opts.source.trim() === "") throw new WowgetError("usage", "add needs a source or an addon name.");
  const ctx = await context(opts);
  if (!opts.source.includes(":")) {
    const entry = await registryEntryFor(ctx, opts.source);
    // An addon already in the manifest with this source keeps its name, as with "add <source>".
    const known = ctx.manifest.addons.some((a) => a.source === entry.source);
    const result = await add({ ...opts, source: entry.source, name: opts.name ?? (known ? undefined : entry.name) });
    return { ...result, registryName: opts.source };
  }
  const spec = parseSource(opts.source);
  if (opts.prerelease && spec.kind !== "github") {
    throw new WowgetError("usage", "--prerelease only applies to GitHub sources.");
  }
  const existingBySource = opts.name === undefined ? ctx.manifest.addons.find((a) => a.source === opts.source) : undefined;
  let inferredName = opts.name ?? existingBySource?.name;
  if (inferredName === undefined && spec.kind === "wowi") {
    const probe = await resolveRow(ctx, {
      entry: { name: defaultAddonName(spec), source: opts.source, prerelease: false, pin: opts.pin },
      target: ctx.targets[0]!,
    });
    inferredName = probe.defaultName;
  }
  const existing = findAddon(ctx.manifest, inferredName ?? defaultAddonName(spec));
  const name = existing?.name ?? inferredName ?? defaultAddonName(spec);

  let entry: AddonEntry;
  let installTargets: ResolvedTarget[];
  let commitManifest: () => Promise<unknown>;

  if (existing) {
    const existingOn = addonTargets(ctx.manifest, existing);
    const addedTargets = opts.targets?.length ? ctx.targets.filter((t) => !existingOn.includes(t.name)) : [];
    if (!addedTargets.length) {
      throw new WowgetError("duplicate", `An addon named "${name}" is already in the manifest.`);
    }
    if (existing.source !== opts.source) {
      throw new WowgetError(
        "duplicate",
        `An addon named "${name}" is already in the manifest with source "${existing.source}".`,
      );
    }
    if (opts.prerelease !== undefined && opts.prerelease !== existing.prerelease) {
      throw new WowgetError("usage", `Cannot change --prerelease on existing addon "${name}".`);
    }
    if (opts.pin !== undefined && opts.pin !== existing.pin) {
      throw new WowgetError("usage", `Cannot change --pin on existing addon "${name}".`);
    }
    const combined = ctx.manifest.targets
      .map((t) => t.name)
      .filter((n) => existingOn.includes(n) || addedTargets.some((t) => t.name === n));
    const nextTargets = combined.length < ctx.manifest.targets.length ? combined : undefined;
    const text = await readFile(opts.manifestPath, "utf8");
    const planned = planSetAddonTargets(text, existing.name, nextTargets, opts.manifestPath);
    entry = { ...existing, ...(nextTargets ? { targets: nextTargets } : {}) };
    if (!nextTargets) delete entry.targets;
    installTargets = addedTargets;
    commitManifest = () => writePlanned(opts.manifestPath, text, planned);
  } else {
    entry = { name, source: opts.source, prerelease: opts.prerelease ?? false };
    if (opts.pin !== undefined) entry.pin = opts.pin;
    // Without a filter the addon is on every target, also those skipped because they are not on this machine.
    if (opts.targets?.length && ctx.targets.length < ctx.manifest.targets.length) entry.targets = ctx.targets.map((t) => t.name);
    // Catch an entry the manifest would reject before downloading anything.
    try {
      parseManifest(appendAddonText(await readFile(opts.manifestPath, "utf8"), entry));
    } catch (err) {
      if (!(err instanceof WowgetError && err.code === "manifest")) throw err;
      throw new WowgetError("usage", `Cannot add "${name}": ${err.message}`, { cause: err });
    }
    installTargets = ctx.targets;
    commitManifest = () => addAddon(opts.manifestPath, entry);
  }

  // A missing target would only fail after the others were installed.
  for (const target of installTargets) {
    if (!(await stat(target.path).then((s) => s.isDirectory(), () => false))) {
      throw new WowgetError("io", `Target "${target.name}": ${target.path} does not exist or is not a directory.`);
    }
  }

  const rows = [...installTargets].sort((a, b) => byName(a.name, b.name)).map((target) => ({ entry, target }));
  // Replaced folders are kept until the manifest is written, so a failure can put them back.
  const done: AddDone[] = [];
  try {
    for (const row of rows) {
      try {
        const previous = opts.state.getActiveInstall(row.target.name, name);
        const resolved = await resolveRow(ctx, row);
        const installed = await installRow(ctx, row, resolved, { keepOld: true });
        done.push({
          target: row.target,
          previous,
          oldDir: installed.oldDir,
          entry: {
            name,
            target: row.target.name,
            releaseId: installed.releaseId,
            version: installed.version,
            folders: installed.folders,
            ...(resolved.note ? { note: resolved.note } : {}),
          },
        });
      } catch (err) {
        throw rows.length > 1 ? onTarget(row.target.name, err) : err;
      }
    }
    await commitManifest();
  } catch (err) {
    const failed: string[] = [];
    for (const d of [...done].reverse()) {
      try {
        await undoAdd(opts.state, name, d);
      } catch (rollbackErr) {
        const kept = d.oldDir ? `; the replaced folders are in ${d.oldDir}` : "";
        failed.push(`${d.target.name}: ${message(rollbackErr)}${kept}`);
      }
    }
    if (failed.length) {
      const code = err instanceof WowgetError ? err.code : "io";
      throw new WowgetError(code, `${message(err)} Undoing the install of ${name} also failed (${failed.join("; ")}).`, {
        cause: err,
      });
    }
    throw err;
  }
  for (const d of done) {
    if (d.oldDir && !(await removeBestEffort(d.oldDir))) d.entry.leftoverDir = d.oldDir;
  }
  await pruneAddonCache(ctx.cacheDir, opts.state, name);
  const result: AddResult = { name, source: opts.source, addons: done.map((d) => d.entry) };
  if (entry.targets) result.targets = entry.targets;
  return result;
}

// remove

export interface RemoveOptions extends Pick<OpsOptions, "manifestPath" | "state" | "targets" | "env" | "gameDirs" | "onEvent"> {
  name: string;
}

export interface RemoveResult {
  name: string;
  /** True when the manifest entry was removed; false when only targets were dropped from it. */
  removedEntry: boolean;
  /** The addon's targets after the removal, when the entry stays. */
  remainingTargets?: string[];
  addons: RemoveEntry[];
}

/**
 * Without a target filter, uninstalls the addon everywhere and removes its entry. With one,
 * uninstalls it from those targets and drops them from its `targets` list, removing the entry
 * when none are left.
 */
export async function remove(opts: RemoveOptions): Promise<RemoveResult> {
  const { text, manifest } = await readManifestText(opts.manifestPath);
  const selected = selectTargets(manifest, opts.manifestPath, opts.targets);
  const entry = findAddon(manifest, opts.name);
  if (!entry) throw new WowgetError("not_found", `No addon named "${opts.name}" in the manifest.`);
  const filtered = Boolean(opts.targets?.length);
  const on = addonTargets(manifest, entry);
  const notOn = selected.filter((t) => !on.includes(t.name)).map((t) => t.name);
  if (filtered && notOn.length) {
    throw new WowgetError("usage", `${entry.name} is not on target ${notOn.join(", ")}; it is on ${on.join(", ")}.`);
  }

  // The manifest edit is computed and checked first, so an edit that cannot be made uninstalls nothing.
  const dropped = new Set(selected.map((t) => t.name));
  const remaining = filtered ? on.filter((t) => !dropped.has(t)) : [];
  const next = remaining.length
    ? planSetAddonTargets(text, entry.name, remaining, opts.manifestPath)
    : planRemoveAddon(text, entry.name, opts.manifestPath);

  const addons: RemoveEntry[] = [];
  // Without a filter every target is checked, so installs left behind by a hand edit go too.
  const targets = await locateTargets(
    [...(filtered ? selected : manifest.targets)].sort((a, b) => byName(a.name, b.name)),
    gameDirsFor(opts),
  );
  try {
    for (const target of targets) {
      const result = await uninstallFrom(target, entry.name, opts.state, opts.onEvent);
      if (filtered || on.includes(target.name) || result.wasInstalled) addons.push(removeEntry(entry.name, target.name, result));
    }
    await writePlanned(opts.manifestPath, text, next);
  } catch (err) {
    throw stoppedAfter(err, addons);
  }
  if (!remaining.length) return { name: entry.name, removedEntry: true, addons };
  return { name: entry.name, removedEntry: false, remainingTargets: remaining, addons };
}

// list

export type ListStatus = "ok" | "missing" | "not installed";

export interface ListEntry {
  name: string;
  target: string;
  source: string;
  version: string | null;
  releaseId: string | null;
  status: ListStatus;
  /** Recorded folders that are absent on disk or were taken over by another addon. */
  missingFolders: string[];
}

export interface ListResult {
  /** The targets listed. */
  targets: ResolvedTarget[];
  addons: ListEntry[];
}

export async function list(opts: Pick<OpsOptions, "manifestPath" | "state" | "targets" | "env" | "gameDirs" | "onEvent">): Promise<ListResult> {
  const loaded = await load(opts);
  const addons: ListEntry[] = [];
  for (const { entry, target } of rowsFor(loaded, loaded.manifest.addons)) {
    const ids = { name: entry.name, target: target.name, source: entry.source };
    const active = opts.state.getActiveInstall(target.name, entry.name);
    if (!active) {
      addons.push({ ...ids, version: null, releaseId: null, status: "not installed", missingFolders: [] });
      continue;
    }
    const missing = await missingFolders(target.path, active);
    addons.push({
      ...ids,
      version: active.version ?? active.releaseId,
      releaseId: active.releaseId,
      status: missing.length ? "missing" : "ok",
      missingFolders: missing,
    });
  }
  return { targets: loaded.targets, addons };
}

// outdated

/** `note`: something the source did that the user should know, such as skipping newer releases. */
type OnRow<T> = { name: string; target: string; note?: string } & T;

export type OutdatedEntry = OnRow<
  | { status: "current"; version: string }
  | { status: "outdated"; installed: string; latest: string }
  | { status: "not installed"; latest: string }
  /** Recorded folders are absent on disk; `update` reinstalls. */
  | { status: "missing"; installed: string; latest: string; missingFolders: string[] }
  | { status: "error"; error: string }
>;

export interface OutdatedResult {
  addons: OutdatedEntry[];
}

export async function outdated(opts: OpsOptions): Promise<OutdatedResult> {
  const ctx = await context(opts);
  const rows = rowsFor(ctx, ctx.manifest.addons);
  const atPin = new Map<Row, InstallRecord>();
  for (const row of rows) {
    const active = await installedAtPin(opts.state, row);
    if (active) atPin.set(row, active);
  }
  await preResolve(ctx, rows.filter((r) => !atPin.has(r)));
  const addons: OutdatedEntry[] = [];
  for (const row of rows) {
    const { entry, target } = row;
    const ids = { name: entry.name, target: target.name };
    let note: { note?: string } = {};
    const pinned = atPin.get(row);
    if (pinned) {
      addons.push({ ...ids, status: "current", version: pinned.version ?? pinned.releaseId });
      continue;
    }
    try {
      const resolved = await resolveRow(ctx, row);
      if (resolved.note) note = { note: resolved.note };
      const active = opts.state.getActiveInstall(target.name, entry.name);
      if (!active) {
        addons.push({ ...ids, ...note, status: "not installed", latest: resolved.version });
        continue;
      }
      const installed = active.version ?? active.releaseId;
      const missing = await missingFolders(target.path, active);
      if (missing.length) addons.push({ ...ids, ...note, status: "missing", installed, latest: resolved.version, missingFolders: missing });
      else if (isCurrent(active, entry, resolved)) addons.push({ ...ids, ...note, status: "current", version: resolved.version });
      else addons.push({ ...ids, ...note, status: "outdated", installed, latest: resolved.version });
    } catch (err) {
      addons.push({ ...ids, ...note, status: "error", error: message(err) });
    }
  }
  return { addons };
}

// update and install

/** `leftoverDir`: previous copies of replaced folders that could not be deleted. */
export type UpdateEntry = OnRow<
  | { status: "current"; version: string }
  | { status: "updated"; from: string; to: string; folders: string[]; leftoverDir?: string }
  | { status: "installed"; version: string; folders: string[]; leftoverDir?: string }
  /** The same release was reinstalled because recorded folders were missing. */
  | { status: "repaired"; version: string; folders: string[]; leftoverDir?: string }
  | { status: "skipped"; version: string }
  | { status: "error"; error: string }
>;

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
  if (names.length) {
    for (const entry of entries) {
      if (rowsFor(ctx, [entry]).length) continue;
      const on = addonTargets(ctx.manifest, entry).join(", ");
      throw new WowgetError("usage", `${entry.name} is not on target ${ctx.targets.map((t) => t.name).join(", ")}; it is on ${on}.`);
    }
  }

  const rows = rowsFor(ctx, [...new Set(entries)]);
  const atPin = new Map<Row, InstallRecord>();
  for (const row of rows) {
    const active = await installedAtPin(opts.state, row);
    if (active) atPin.set(row, active);
  }
  await preResolve(ctx, rows.filter((r) => !atPin.has(r)));
  const addons: UpdateEntry[] = [];
  for (const row of rows) {
    const { entry, target } = row;
    const ids = { name: entry.name, target: target.name };
    let note: { note?: string } = {};
    const pinned = atPin.get(row);
    if (pinned) {
      addons.push({ ...ids, status: "current", version: pinned.version ?? pinned.releaseId });
      continue;
    }
    try {
      const resolved = await resolveRow(ctx, row);
      if (resolved.note) note = { note: resolved.note };
      const active = opts.state.getActiveInstall(target.name, entry.name);
      if (active) {
        const intact = !(await missingFolders(target.path, active)).length;
        if (intact && isCurrent(active, entry, resolved)) addons.push({ ...ids, ...note, status: "current", version: resolved.version });
        else {
          addons.push({ ...(await reinstall(ctx, row, resolved, active)), ...note });
          await pruneAddonCache(ctx.cacheDir, opts.state, entry.name);
        }
        continue;
      }
      const result = await installRow(ctx, row, resolved);
      await pruneAddonCache(ctx.cacheDir, opts.state, entry.name);
      addons.push({ ...ids, ...note, status: "installed", version: result.version, folders: result.folders, ...leftover(result) });
    } catch (err) {
      addons.push({ ...ids, ...note, status: "error", error: message(err) });
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
  const rows = rowsFor(ctx, ctx.manifest.addons);
  const intact = new Map<Row, InstallRecord>();
  for (const row of rows) {
    const active = opts.state.getActiveInstall(row.target.name, row.entry.name);
    if (active && !(await missingFolders(row.target.path, active)).length) intact.set(row, active);
  }
  await preResolve(
    ctx,
    rows.filter((r) => !intact.has(r)),
  );
  const addons: UpdateEntry[] = [];
  for (const row of rows) {
    const { entry, target } = row;
    const ids = { name: entry.name, target: target.name };
    let note: { note?: string } = {};
    const skipped = intact.get(row);
    if (skipped) {
      addons.push({ ...ids, status: "skipped", version: skipped.version ?? skipped.releaseId });
      continue;
    }
    const active = opts.state.getActiveInstall(target.name, entry.name);
    try {
      const resolved = await resolveRow(ctx, row);
      if (resolved.note) note = { note: resolved.note };
      if (active) {
        addons.push({ ...(await reinstall(ctx, row, resolved, active)), ...note });
        await pruneAddonCache(ctx.cacheDir, opts.state, entry.name);
        continue;
      }
      const result = await installRow(ctx, row, resolved);
      await pruneAddonCache(ctx.cacheDir, opts.state, entry.name);
      addons.push({ ...ids, ...note, status: "installed", version: result.version, folders: result.folders, ...leftover(result) });
    } catch (err) {
      addons.push({ ...ids, ...note, status: "error", error: message(err) });
    }
  }
  return { addons };
}

// pin, unpin, rollback

export interface PinOptions extends OpsOptions {
  name: string;
  /** Release id to pin to; when omitted, pins to the active install's releaseId. */
  pin?: string;
}

export interface PinResult {
  name: string;
  pin: string;
  /** Targets updated when an explicit releaseId was resolved and installed. */
  addons: AddEntry[];
}

export async function pin(opts: PinOptions): Promise<PinResult> {
  if (opts.pin === "") throw new WowgetError("usage", "Pin must not be empty.");
  const { text, manifest } = await readManifestText(opts.manifestPath);
  const entry = findAddon(manifest, opts.name);
  if (!entry) throw new WowgetError("not_found", `No addon named "${opts.name}" in the manifest.`);
  const targets = selectTargets(manifest, opts.manifestPath, undefined).filter((t) =>
    addonTargets(manifest, entry).includes(t.name),
  );

  if (opts.pin === undefined) {
    const actives = targets
      .map((t) => opts.state.getActiveInstall(t.name, entry.name))
      .filter((r): r is InstallRecord => r !== undefined);
    if (!actives.length) {
      throw new WowgetError(
        "not_found",
        `${entry.name} is not installed; pass a release id to "wowget pin ${entry.name} <release>".`,
      );
    }
    const releaseIds = [...new Set(actives.map((a) => a.releaseId))];
    if (releaseIds.length > 1) {
      const detail = actives.map((a) => `${a.target}=${a.releaseId}`).join(", ");
      throw new WowgetError(
        "conflict",
        `${entry.name} has different releases installed across targets (${detail}); pass an explicit release id to "wowget pin".`,
      );
    }
    const chosen = releaseIds[0]!;
    const planned = planSetAddonPin(text, entry.name, chosen, opts.manifestPath);
    await writePlanned(opts.manifestPath, text, planned);
    return { name: entry.name, pin: chosen, addons: [] };
  }

  const planned = planSetAddonPin(text, entry.name, opts.pin, opts.manifestPath);
  const ctx = await context({ ...opts, targets: undefined });
  const pinnedEntry: AddonEntry = { ...entry, pin: opts.pin };
  const allRows = rowsFor(ctx, [pinnedEntry]);
  const rows: Row[] = [];
  for (const row of allRows) {
    const active = opts.state.getActiveInstall(row.target.name, entry.name);
    if (active && active.releaseId === opts.pin && !(await missingFolders(row.target.path, active)).length) continue;
    rows.push(row);
  }
  for (const { target } of rows) {
    if (!(await stat(target.path).then((s) => s.isDirectory(), () => false))) {
      throw new WowgetError("io", `Target "${target.name}": ${target.path} does not exist or is not a directory.`);
    }
  }

  const done: AddDone[] = [];
  try {
    for (const row of rows) {
      try {
        const previous = opts.state.getActiveInstall(row.target.name, entry.name);
        const installed = await installRow(ctx, row, await resolveRow(ctx, row), { keepOld: true });
        done.push({
          target: row.target,
          previous,
          oldDir: installed.oldDir,
          entry: {
            name: entry.name,
            target: row.target.name,
            releaseId: installed.releaseId,
            version: installed.version,
            folders: installed.folders,
          },
        });
      } catch (err) {
        throw rows.length > 1 ? onTarget(row.target.name, err) : err;
      }
    }
    await writePlanned(opts.manifestPath, text, planned);
  } catch (err) {
    const failed: string[] = [];
    for (const d of [...done].reverse()) {
      try {
        await undoAdd(opts.state, entry.name, d);
      } catch (rollbackErr) {
        const kept = d.oldDir ? `; the replaced folders are in ${d.oldDir}` : "";
        failed.push(`${d.target.name}: ${message(rollbackErr)}${kept}`);
      }
    }
    if (failed.length) {
      const code = err instanceof WowgetError ? err.code : "io";
      throw new WowgetError(
        code,
        `${message(err)} Undoing the install of ${entry.name} also failed (${failed.join("; ")}).`,
        { cause: err },
      );
    }
    throw err;
  }
  for (const d of done) {
    if (d.oldDir && !(await removeBestEffort(d.oldDir))) d.entry.leftoverDir = d.oldDir;
  }
  return { name: entry.name, pin: opts.pin, addons: done.map((d) => d.entry) };
}

export interface UnpinOptions extends Pick<OpsOptions, "manifestPath"> {
  name: string;
}

export interface UnpinResult {
  name: string;
  previousPin?: string;
}

export async function unpin(opts: UnpinOptions): Promise<UnpinResult> {
  const { text, manifest } = await readManifestText(opts.manifestPath);
  const entry = findAddon(manifest, opts.name);
  if (!entry) throw new WowgetError("not_found", `No addon named "${opts.name}" in the manifest.`);
  const planned = planSetAddonPin(text, entry.name, undefined, opts.manifestPath);
  await writePlanned(opts.manifestPath, text, planned);
  return { name: entry.name, ...(entry.pin !== undefined ? { previousPin: entry.pin } : {}) };
}

export interface RollbackOptions extends OpsOptions {
  name: string;
}

export interface RollbackEntry {
  name: string;
  target: string;
  from: string | null;
  to: string;
  releaseId: string;
  folders: string[];
  leftoverDir?: string;
}

export interface RollbackResult {
  name: string;
  addons: RollbackEntry[];
  /** The release the manifest now pins, so `update` keeps the rollback. */
  pinned?: string;
  /**
   * Why no pin was written: the rollback covered only some of the addon's targets ("partial") or
   * left them on different releases ("mixed"). The next `update` reinstalls the newer release then.
   */
  notPinned?: "partial" | "mixed";
}

export async function rollback(opts: RollbackOptions): Promise<RollbackResult> {
  const loaded = await load(opts);
  const entry = findAddon(loaded.manifest, opts.name);
  if (!entry) throw new WowgetError("not_found", `No addon named "${opts.name}" in the manifest.`);
  const rows = rowsFor(loaded, [entry]);
  if (!rows.length) {
    const on = addonTargets(loaded.manifest, entry).join(", ");
    throw new WowgetError(
      "usage",
      `${entry.name} is not on target ${loaded.targets.map((t) => t.name).join(", ")}; it is on ${on}.`,
    );
  }

  const plans: { row: Row; active?: InstallRecord; previous: InstallRecord }[] = [];
  const { text: manifestText } = await readManifestText(opts.manifestPath);
  for (const row of rows) {
    if (!(await stat(row.target.path).then((s) => s.isDirectory(), () => false))) {
      throw new WowgetError("io", `Target "${row.target.name}": ${row.target.path} does not exist or is not a directory.`);
    }
    const active = opts.state.getActiveInstall(row.target.name, entry.name);
    const previous = opts.state.getPreviousInstall(row.target.name, entry.name);
    if (!previous) {
      throw new WowgetError("not_found", `${row.target.name}: no previous install recorded for ${entry.name}.`);
    }
    if (!(await Bun.file(previous.zipPath).exists())) {
      throw new WowgetError(
        "not_found",
        `${row.target.name}: cached zip for ${entry.name} ${previous.version ?? previous.releaseId} (${previous.zipPath}) is missing.`,
      );
    }
    plans.push({ row, active, previous });
  }

  // Without a pin the next update would reinstall the newer release. The pin applies to every
  // target, so it is only written when the rollback covers them all and lands on one release.
  const releaseIds = new Set(plans.map((p) => p.previous.releaseId));
  const coversAll = rows.length === addonTargets(loaded.manifest, entry).length;
  const pinTo = coversAll && releaseIds.size === 1 ? [...releaseIds][0]! : undefined;
  const plannedManifest = pinTo !== undefined ? planSetAddonPin(manifestText, entry.name, pinTo, opts.manifestPath) : undefined;
  const notPinned = pinTo !== undefined ? undefined : !coversAll ? "partial" : "mixed";

  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const done: (AddDone & { rollbackEntry: RollbackEntry })[] = [];
  try {
    for (const { row, active, previous } of plans) {
      try {
        const resolved: Resolved = {
          source: previous.source,
          releaseId: previous.releaseId,
          version: previous.version ?? previous.releaseId,
          filename: previous.filename,
          downloadUrl: `file://${previous.zipPath}`,
          flavorVerified: false,
          localPath: previous.zipPath,
        };
        const installed = await installRelease({
          target: row.target.name,
          addon: entry.name,
          resolved,
          targetDir: row.target.path,
          flavor: row.target.flavor,
          state: opts.state,
          force: opts.force,
          cacheDir,
          sha256: previous.sha256,
          onEvent: opts.onEvent,
          keepOld: true,
        });
        const item: AddEntry = {
          name: entry.name,
          target: row.target.name,
          releaseId: installed.releaseId,
          version: installed.version,
          folders: installed.folders,
        };
        done.push({
          target: row.target,
          previous: active,
          oldDir: installed.oldDir,
          entry: item,
          rollbackEntry: {
            name: entry.name,
            target: row.target.name,
            from: active ? (active.version ?? active.releaseId) : null,
            to: installed.version,
            releaseId: installed.releaseId,
            folders: installed.folders,
          },
        });
      } catch (err) {
        throw plans.length > 1 ? onTarget(row.target.name, err) : err;
      }
    }
    if (plannedManifest !== undefined) await writePlanned(opts.manifestPath, manifestText, plannedManifest);
  } catch (err) {
    const failed: string[] = [];
    for (const d of [...done].reverse()) {
      try {
        await undoAdd(opts.state, entry.name, d);
      } catch (rollbackErr) {
        const kept = d.oldDir ? `; the replaced folders are in ${d.oldDir}` : "";
        failed.push(`${d.target.name}: ${message(rollbackErr)}${kept}`);
      }
    }
    if (failed.length) {
      const code = err instanceof WowgetError ? err.code : "io";
      throw new WowgetError(
        code,
        `${message(err)} Undoing the rollback of ${entry.name} also failed (${failed.join("; ")}).`,
        { cause: err },
      );
    }
    throw err;
  }
  for (const d of done) {
    if (d.oldDir && !(await removeBestEffort(d.oldDir))) d.rollbackEntry.leftoverDir = d.oldDir;
  }
  return {
    name: entry.name,
    addons: done.map((d) => d.rollbackEntry),
    ...(pinTo !== undefined ? { pinned: pinTo } : { notPinned: notPinned! }),
  };
}

// reconcile

export interface ReconcileOptions extends OpsOptions {
  adopt?: boolean;
}

export type ReconcileStatus = "unmanaged" | "adopted" | "unmatched" | "error";

export interface ReconcileEntry extends UnmanagedAddon {
  status: ReconcileStatus;
  error?: string;
  leftoverDir?: string;
}

export interface ReconcileResult {
  addons: ReconcileEntry[];
}

export async function reconcile(opts: ReconcileOptions): Promise<ReconcileResult> {
  const ctx = await context(opts);
  const targets = [...ctx.targets].sort((a, b) => byName(a.name, b.name));
  const registry = await loadRegistry(ctx.http, opts.env);
  if (registry.stale) opts.onEvent?.({ type: "registry:stale", message: registry.stale });
  // The cached catalogue only: reconcile does not download it.
  const hints = { registry: enabledEntries(registry.entries), catalog: await readCachedCatalog(ctx.cacheDir) };
  const discovered: { target: ResolvedTarget; group: UnmanagedAddon }[] = [];
  for (const target of targets) {
    for (const group of await scanUnmanaged(target.path, target.name, opts.state, hints)) {
      discovered.push({ target, group });
    }
  }
  if (!opts.adopt) {
    return {
      addons: discovered.map(({ group }) => ({
        ...group,
        status: group.source ? "unmanaged" : "unmatched",
      })),
    };
  }

  const addons: ReconcileEntry[] = [];
  for (const { target, group } of discovered) {
    if (!group.source) {
      addons.push({ ...group, status: "unmatched" });
      continue;
    }
    try {
      const manifest = await readManifest(opts.manifestPath);
      const bySource = manifest.addons.find((a) => a.source === group.source);
      const byNameMatch = findAddon(manifest, group.name);
      if (byNameMatch && byNameMatch.source !== group.source) {
        throw new WowgetError(
          "conflict",
          `Manifest already has "${byNameMatch.name}" with source "${byNameMatch.source}".`,
        );
      }
      const existing = bySource ?? byNameMatch;
      const addonName = existing?.name ?? group.name;
      const tempEntry: AddonEntry = existing ?? { name: addonName, source: group.source, prerelease: false };
      const row: Row = { entry: tempEntry, target };
      const resolved = await resolveRow(ctx, row);
      const installed = await installRelease({
        target: target.name,
        addon: addonName,
        resolved,
        targetDir: target.path,
        flavor: target.flavor,
        state: opts.state,
        force: opts.force,
        adoptFolders: group.folders,
        cacheDir: ctx.cacheDir,
        fetch: opts.fetch,
        onEvent: opts.onEvent,
      });
      if (!existing) {
        await addAddon(opts.manifestPath, {
          name: addonName,
          source: group.source,
          prerelease: false,
          ...(manifest.targets.length > 1 ? { targets: [target.name] } : {}),
        });
      } else {
        const on = addonTargets(manifest, existing);
        if (!on.includes(target.name)) {
          const combined = manifest.targets.map((t) => t.name).filter((n) => on.includes(n) || n === target.name);
          const nextTargets = combined.length < manifest.targets.length ? combined : undefined;
          await setAddonTargets(opts.manifestPath, existing.name, nextTargets);
        }
      }
      addons.push({
        name: addonName,
        target: target.name,
        folders: installed.folders,
        version: installed.version,
        source: group.source,
        status: "adopted",
        ...leftover(installed),
      });
    } catch (err) {
      addons.push({ ...group, status: "error", error: message(err) });
    }
  }
  return { addons };
}

// doctor

export interface DoctorOptions extends Pick<OpsOptions, "manifestPath" | "state" | "targets" | "cacheDir" | "env" | "gameDirs" | "onEvent"> {
  clean?: boolean;
}

export interface DoctorResult {
  targets: DoctorTargetReport[];
  issues: DoctorIssue[];
  /** Suggestions that are not problems; they do not make doctor fail. */
  hints: DoctorHint[];
  cleaned: string[];
}

export async function doctor(opts: DoctorOptions): Promise<DoctorResult> {
  const loaded = await load(opts);
  const clean = opts.clean ?? false;
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const targets: DoctorTargetReport[] = [];
  const issues: DoctorIssue[] = [];
  const cleaned: string[] = [];

  const hints: DoctorHint[] = [];
  const gameDirs = gameDirsFor(opts);

  for (const target of loaded.targets) {
    const res = await inspectTarget(target, loaded.manifest, opts.state, clean);
    targets.push(res.report);
    issues.push(...res.issues);
    cleaned.push(...res.cleaned);

    const named = findTarget(loaded.manifest, target.name)!;
    if (named.path === undefined) continue;
    const check = await portableCheck(named, loaded.manifest.targets, gameDirs);
    if ("folder" in check) {
      hints.push({
        kind: "portable_target",
        target: target.name,
        folder: check.folder,
        message: `${target.name}: can be written as folder ${check.folder}, so the manifest also works on machines with the game elsewhere; run "wowget target portable ${target.name}".`,
      });
    }
  }

  for (const dir of await findStaleCacheDirs(cacheDir, opts.state)) {
    if (clean && (await removeBestEffort(dir))) {
      cleaned.push(dir);
    } else {
      issues.push({
        kind: "stale_cache",
        path: dir,
        message: `cache: unreferenced release directory ${dir}.`,
      });
    }
  }

  return { targets, issues, hints, cleaned };
}

// search

export interface SearchOptions
  extends Pick<OpsOptions, "manifestPath" | "state" | "targets" | "cacheDir" | "fetch" | "env" | "onEvent"> {
  query: string;
  flavor?: Flavor;
  allFlavors?: boolean;
  github?: boolean;
  /** Defaults to 20. */
  limit?: number;
  refresh?: boolean;
}

export interface SearchResultEntry {
  name: string;
  source: string;
  origin: Origin;
  /** Flavors the addon supports ("yes") or may support ("unknown"); the filter's flavors come first. */
  flavors: Partial<Record<Flavor, "yes" | "unknown">>;
  description: string | null;
  downloadsMonthly: number | null;
  stars: number | null;
  updatedAt: string | null;
  url: string | null;
  inManifest: boolean;
}

export interface SearchResult {
  results: SearchResultEntry[];
  /** The flavors results were filtered on; null when there was no filter. */
  flavors: Flavor[] | null;
  /** Sources that failed or are stale. */
  warnings: string[];
}

/** The flavors to filter on: --flavor, else the selected targets', else none. */
function searchFlavors(opts: SearchOptions, manifest: Manifest | undefined): Flavor[] | undefined {
  // Unknown -t names are an error even when --flavor or --all-flavors makes them irrelevant.
  const targets = manifest && opts.targets?.length ? selectTargets(manifest, opts.manifestPath, opts.targets) : undefined;
  if (opts.allFlavors) {
    if (opts.flavor) throw new WowgetError("usage", "--flavor and --all-flavors cannot be combined.");
    return undefined;
  }
  if (opts.flavor) return [opts.flavor];
  if (!manifest || !manifest.targets.length) return undefined;
  return [...new Set((targets ?? manifest.targets).map((t) => t.flavor))];
}

function resultEntry(row: SearchRow, filter: Flavor[] | undefined, manifest: Manifest | undefined): SearchResultEntry {
  const flavors: SearchResultEntry["flavors"] = {};
  for (const f of [...(filter ?? []), ...FLAVORS]) {
    const support = row.flavors[f];
    if (support === "yes" || support === "unknown") flavors[f] = support;
  }
  return {
    name: row.name,
    source: row.source,
    origin: row.origin,
    flavors,
    description: row.description ?? null,
    downloadsMonthly: row.downloadsMonthly ?? null,
    stars: row.stars ?? null,
    updatedAt: row.updatedAt ?? null,
    url: row.url ?? null,
    inManifest: manifest?.addons.some((a) => a.source.toLowerCase() === row.source.toLowerCase()) ?? false,
  };
}

export async function search(opts: SearchOptions): Promise<SearchResult> {
  const query = opts.query.trim();
  if (!normaliseName(query)) throw new WowgetError("usage", "search needs a query with at least one letter or digit.");
  const limit = opts.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1) throw new WowgetError("usage", "--limit must be a positive whole number.");

  let manifest: Manifest | undefined;
  try {
    manifest = await readManifest(opts.manifestPath);
  } catch (err) {
    // Search works without a manifest, unless targets were asked for.
    if (!(err instanceof WowgetError && err.code === "not_found") || opts.targets?.length) throw err;
  }
  const flavors = searchFlavors(opts, manifest);
  const http = new HttpClient({ state: opts.state, fetch: opts.fetch, env: opts.env });
  const warnings: string[] = [];

  const [registry, catalog, github] = await Promise.all([
    loadRegistry(http, opts.env),
    loadCatalog({ http, cacheDir: opts.cacheDir ?? defaultCacheDir(), refresh: opts.refresh, onEvent: opts.onEvent }),
    opts.github
      ? searchGithub(http, query).catch((err) => {
          warnings.push(`GitHub search failed: ${message(err)}`);
          return [];
        })
      : Promise.resolve([]),
  ]);
  if (registry.stale) warnings.unshift(registry.stale);
  if (catalog.warning) warnings.push(catalog.warning);

  const rows = [...registryRows(registry.entries), ...catalog.entries.map(catalogRow), ...github];
  const ranked = rankRows(rows, query, { flavors, limit });
  return { results: ranked.map((row) => resultEntry(row, flavors, manifest)), flavors: flavors ?? null, warnings };
}

// suggest

export interface SuggestOptions extends Pick<OpsOptions, "manifestPath" | "state" | "fetch" | "env" | "onEvent"> {
  /** Manifest names to consider; empty or absent means every addon. */
  names?: string[];
}

export type SuggestStatus = "suggested" | "listed" | "url";

export interface SuggestEntry {
  name: string;
  source: string;
  status: SuggestStatus;
  /** The registry entry with the same source, for "listed". */
  registryName?: string;
}

export interface SuggestResult {
  addons: SuggestEntry[];
  /** The prefilled issue URL; null when nothing is suggested. */
  url: string | null;
  warnings: string[];
}

export async function suggest(opts: SuggestOptions): Promise<SuggestResult> {
  const manifest = await readManifest(opts.manifestPath);
  let addons = manifest.addons;
  if (opts.names?.length) {
    const unknown = opts.names.filter((n) => !findAddon(manifest, n));
    if (unknown.length) {
      throw new WowgetError("usage", `${unknown.map((n) => `"${n}"`).join(", ")} ${unknown.length > 1 ? "are" : "is"} not in the manifest.`);
    }
    addons = opts.names.map((n) => findAddon(manifest, n)!);
  }

  const http = new HttpClient({ state: opts.state, fetch: opts.fetch, env: opts.env });
  const registry = await loadRegistry(http, opts.env);
  const listed = new Map(registry.entries.map((e) => [sourceKey(e.source), e.name]));
  const entries: SuggestEntry[] = [...addons]
    .sort((a, b) => byName(a.name, b.name))
    .map((a) => {
      const registryName = listed.get(sourceKey(a.source));
      if (registryName !== undefined) return { name: a.name, source: a.source, status: "listed", registryName };
      if (a.source.startsWith("url:")) return { name: a.name, source: a.source, status: "url" };
      return { name: a.name, source: a.source, status: "suggested" };
    });

  const suggested = entries.filter((e) => e.status === "suggested");
  const url = suggested.length ? suggestIssueUrl(suggested) : null;
  if (url && url.length > MAX_ISSUE_URL_LENGTH) {
    throw new WowgetError(
      "usage",
      `${suggested.length} addons make the issue URL too long for GitHub; name some of them: wowget suggest <name>...`,
    );
  }
  return { addons: entries, url, warnings: registry.stale ? [registry.stale] : [] };
}
