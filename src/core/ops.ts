import { lstat, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { detectInstalls, type DetectedInstall } from "./detect.ts";
import { WowgetError } from "./errors.ts";
import type { OnEvent } from "./events.ts";
import type { Flavor } from "./flavor.ts";
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
  parseManifest,
  planRemoveAddon,
  planRemoveTarget,
  planSetAddonTargets,
  readManifest,
  readManifestText,
  writePlanned,
  type AddonEntry,
  type Manifest,
  type NamedTarget,
} from "./manifest.ts";
import { cacheDir as defaultCacheDir, expandHome, gameDirCandidates } from "./paths.ts";
import { sourceFor } from "./sources/index.ts";
import { defaultAddonName, parseSource } from "./sources/parse.ts";
import type { Http, Resolved } from "./sources/types.ts";
import type { InstallRecord, State } from "./state.ts";

export interface OpsOptions {
  manifestPath: string;
  state: State;
  /** Target names to act on; empty or absent means every target. */
  targets?: string[];
  /** Defaults to paths.cacheDir(). */
  cacheDir?: string;
  force?: boolean;
  fetch?: FetchFn;
  /** Read for GITHUB_TOKEN; defaults to process.env. */
  env?: Record<string, string | undefined>;
  onEvent?: OnEvent;
}

interface Loaded {
  manifest: Manifest;
  /** The targets the command acts on, in manifest order. */
  targets: NamedTarget[];
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
  target: NamedTarget;
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

async function load(opts: Pick<OpsOptions, "manifestPath" | "targets">): Promise<Loaded> {
  const manifest = await readManifest(opts.manifestPath);
  return { manifest, targets: selectTargets(manifest, opts.manifestPath, opts.targets) };
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

export interface InitOptions {
  manifestPath: string;
  /** AddOns directory of the single target to add; created if missing. Without it the game directory is scanned. */
  path?: string;
  /** With `path`; defaults to "forever". */
  flavor?: Flavor;
  /** With `path`; defaults to the flavor name. */
  name?: string;
  /** Scanned for version folders when `path` is absent, instead of `gameDirs`. */
  gameDir?: string;
  /** Tried in order when neither `path` nor `gameDir` is given; the first with an install is used. Defaults to paths.gameDirCandidates(). */
  gameDirs?: string[];
}

export interface InitTarget extends NamedTarget {
  /** True when the AddOns directory did not exist and was created. */
  createdAddonsDir: boolean;
}

export interface InitResult {
  manifestPath: string;
  targets: InitTarget[];
}

export async function init(opts: InitOptions): Promise<InitResult> {
  if (await Bun.file(opts.manifestPath).exists()) {
    throw new WowgetError("manifest_exists", `A manifest already exists at ${opts.manifestPath}.`);
  }

  let targets: NamedTarget[];
  if (opts.path !== undefined) {
    if (opts.gameDir !== undefined) throw new WowgetError("usage", "--game-dir does not apply together with --path.");
    const path = absolutePath(opts.path, "--path");
    const flavor = opts.flavor ?? "forever";
    const name = opts.name ?? flavor;
    checkTargetName(name);
    targets = [{ name, path, flavor }];
  } else {
    if (opts.name !== undefined || opts.flavor !== undefined) {
      throw new WowgetError("usage", "--name and --flavor only apply together with --path.");
    }
    const candidates =
      opts.gameDir !== undefined
        ? [absolutePath(opts.gameDir, "--game-dir")]
        : (opts.gameDirs ?? gameDirCandidates()).map((d) => resolve(expandHome(d)));
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
    targets = found.map((d) => ({ name: d.name, path: d.addonsDir, flavor: d.flavor }));
  }

  const created: boolean[] = [];
  for (const target of targets) created.push(await ensureDir(target.path));
  const manifest = await createManifest(opts.manifestPath, targets);
  return {
    manifestPath: opts.manifestPath,
    targets: manifest.targets.map((t, i) => ({ ...t, createdAddonsDir: created[i]! })),
  };
}

// target list, add, remove

export interface TargetListEntry extends NamedTarget {
  /** Whether the AddOns directory exists. */
  exists: boolean;
}

export interface TargetListResult {
  targets: TargetListEntry[];
}

export async function targetList(opts: Pick<OpsOptions, "manifestPath">): Promise<TargetListResult> {
  const manifest = await readManifest(opts.manifestPath);
  const targets: TargetListEntry[] = [];
  for (const t of manifest.targets) {
    const exists = await stat(t.path).then(
      (s) => s.isDirectory(),
      () => false,
    );
    targets.push({ ...t, exists });
  }
  return { targets };
}

export interface TargetAddOptions {
  manifestPath: string;
  name: string;
  path: string;
  flavor: Flavor;
}

export interface TargetAddResult {
  target: NamedTarget;
  createdAddonsDir: boolean;
}

export async function targetAdd(opts: TargetAddOptions): Promise<TargetAddResult> {
  checkTargetName(opts.name);
  const path = absolutePath(opts.path, "--path");
  const manifest = await readManifest(opts.manifestPath);
  if (findTarget(manifest, opts.name)) {
    throw new WowgetError("duplicate", `A target named "${opts.name}" is already in the manifest.`);
  }
  const clash = manifest.targets.find((t) => resolve(expandHome(t.path)) === path);
  if (clash) throw new WowgetError("usage", `${path} is already the path of target "${clash.name}".`);
  const createdAddonsDir = await ensureDir(path);
  const updated = await addTarget(opts.manifestPath, opts.name, { path, flavor: opts.flavor });
  return { target: findTarget(updated, opts.name)!, createdAddonsDir };
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

export interface TargetRemoveOptions extends Pick<OpsOptions, "manifestPath" | "state"> {
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
  const addons: RemoveEntry[] = [];
  try {
    for (const active of opts.state.listActiveInstalls(target.name)) {
      const name = findAddon(manifest, active.addon)?.name ?? active.addon;
      const result = await uninstall({ target: target.name, addon: name, targetDir: target.path, state: opts.state });
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
}

export interface AddResult {
  name: string;
  source: string;
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
  target: NamedTarget;
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
  if (ctx.targets.length < ctx.manifest.targets.length) entry.targets = ctx.targets.map((t) => t.name);
  // Catch an entry the manifest would reject before downloading anything.
  try {
    parseManifest(appendAddonText(await readFile(opts.manifestPath, "utf8"), entry));
  } catch (err) {
    if (!(err instanceof WowgetError && err.code === "manifest")) throw err;
    throw new WowgetError("usage", `Cannot add "${name}": ${err.message}`, { cause: err });
  }

  // A missing target would only fail after the others were installed.
  for (const target of ctx.targets) {
    if (!(await stat(target.path).then((s) => s.isDirectory(), () => false))) {
      throw new WowgetError("io", `Target "${target.name}": ${target.path} does not exist or is not a directory.`);
    }
  }

  // Replaced folders are kept until the manifest is written, so a failure can put them back.
  const done: AddDone[] = [];
  try {
    for (const row of rowsFor(ctx, [entry])) {
      try {
        const previous = opts.state.getActiveInstall(row.target.name, name);
        const installed = await installRow(ctx, row, await resolveRow(ctx, row), { keepOld: true });
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
          },
        });
      } catch (err) {
        throw ctx.targets.length > 1 ? onTarget(row.target.name, err) : err;
      }
    }
    await addAddon(opts.manifestPath, entry);
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
  const result: AddResult = { name, source: opts.source, addons: done.map((d) => d.entry) };
  if (entry.targets) result.targets = entry.targets;
  return result;
}

// remove

export interface RemoveOptions extends Pick<OpsOptions, "manifestPath" | "state" | "targets"> {
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
  const targets = [...(filtered ? selected : manifest.targets)].sort((a, b) => byName(a.name, b.name));
  try {
    for (const target of targets) {
      const result = await uninstall({ target: target.name, addon: entry.name, targetDir: target.path, state: opts.state });
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
  targets: NamedTarget[];
  addons: ListEntry[];
}

export async function list(opts: Pick<OpsOptions, "manifestPath" | "state" | "targets">): Promise<ListResult> {
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

type OnRow<T> = { name: string; target: string } & T;

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
  const addons: OutdatedEntry[] = [];
  for (const row of rowsFor(ctx, ctx.manifest.addons)) {
    const { entry, target } = row;
    const ids = { name: entry.name, target: target.name };
    try {
      const resolved = await resolveRow(ctx, row);
      const active = opts.state.getActiveInstall(target.name, entry.name);
      if (!active) {
        addons.push({ ...ids, status: "not installed", latest: resolved.version });
        continue;
      }
      const installed = active.version ?? active.releaseId;
      const missing = await missingFolders(target.path, active);
      if (missing.length) addons.push({ ...ids, status: "missing", installed, latest: resolved.version, missingFolders: missing });
      else if (isCurrent(active, entry, resolved)) addons.push({ ...ids, status: "current", version: resolved.version });
      else addons.push({ ...ids, status: "outdated", installed, latest: resolved.version });
    } catch (err) {
      addons.push({ ...ids, status: "error", error: message(err) });
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

  const addons: UpdateEntry[] = [];
  for (const row of rowsFor(ctx, [...new Set(entries)])) {
    const { entry, target } = row;
    const ids = { name: entry.name, target: target.name };
    try {
      const resolved = await resolveRow(ctx, row);
      const active = opts.state.getActiveInstall(target.name, entry.name);
      if (active) {
        const intact = !(await missingFolders(target.path, active)).length;
        if (intact && isCurrent(active, entry, resolved)) addons.push({ ...ids, status: "current", version: resolved.version });
        else addons.push(await reinstall(ctx, row, resolved, active));
        continue;
      }
      const result = await installRow(ctx, row, resolved);
      addons.push({ ...ids, status: "installed", version: result.version, folders: result.folders, ...leftover(result) });
    } catch (err) {
      addons.push({ ...ids, status: "error", error: message(err) });
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
  for (const row of rowsFor(ctx, ctx.manifest.addons)) {
    const { entry, target } = row;
    const ids = { name: entry.name, target: target.name };
    const active = opts.state.getActiveInstall(target.name, entry.name);
    if (active && !(await missingFolders(target.path, active)).length) {
      addons.push({ ...ids, status: "skipped", version: active.version ?? active.releaseId });
      continue;
    }
    try {
      const resolved = await resolveRow(ctx, row);
      if (active) {
        addons.push(await reinstall(ctx, row, resolved, active));
        continue;
      }
      const result = await installRow(ctx, row, resolved);
      addons.push({ ...ids, status: "installed", version: result.version, folders: result.folders, ...leftover(result) });
    } catch (err) {
      addons.push({ ...ids, status: "error", error: message(err) });
    }
  }
  return { addons };
}
