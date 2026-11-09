import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WowgetError } from "./errors.ts";
import { FLAVORS, isFlavor, type Flavor } from "./flavor.ts";
import { parseSource } from "./sources/parse.ts";

/** Exactly one of `path` and `folder` is set. */
export interface Target {
  /** Absolute path of the AddOns directory, kept verbatim. */
  path?: string;
  /**
   * A version folder in the game directory, such as `_classic_era_`. The AddOns directory is
   * `<game directory>/<folder>/Interface/AddOns`, found on each machine, so the manifest can be
   * shared between machines.
   */
  folder?: string;
  flavor: Flavor;
}

export interface NamedTarget extends Target {
  name: string;
}

/** A target whose AddOns directory was located on this machine. */
export interface ResolvedTarget {
  name: string;
  flavor: Flavor;
  /** The AddOns directory: `path` as written, or the one found for `folder`. */
  path: string;
  folder?: string;
}

export interface AddonEntry {
  name: string;
  source: string;
  prerelease: boolean;
  pin?: string;
  /** Target names the addon is installed on; absent means every target. */
  targets?: string[];
}

export interface Manifest {
  /** In file order. */
  targets: NamedTarget[];
  addons: AddonEntry[];
}

const TOP_KEYS = ["targets", "addon"];
const TARGET_KEYS = ["path", "folder", "flavor"];
const ADDON_KEYS = ["name", "source", "prerelease", "pin", "targets"];
const TARGET_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export function isTargetName(name: string): boolean {
  return TARGET_NAME.test(name);
}

/** A single folder name: no separators, drive letters, "." or "..". */
export function isVersionFolderName(name: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(name) && name !== "." && name !== "..";
}

function fail(file: string | undefined, message: string): never {
  throw new WowgetError("manifest", file ? `${file}: ${message}` : message);
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function checkKeys(table: Record<string, unknown>, allowed: string[], where: string, file?: string): void {
  for (const key of Object.keys(table)) {
    if (!allowed.includes(key)) fail(file, `unknown key "${key}" in ${where}`);
  }
}

function requireString(table: Record<string, unknown>, key: string, where: string, file?: string): string {
  const value = table[key];
  if (typeof value !== "string" || value === "") fail(file, `${where}.${key} must be a non-empty string`);
  return value;
}

function parseTargets(data: Record<string, unknown>, file?: string): NamedTarget[] {
  const raw = data.targets ?? {};
  if (!isTable(raw)) fail(file, "targets must be a table of [targets.<name>] tables");
  return Object.entries(raw).map(([name, value]) => {
    const where = `targets.${name}`;
    if (!isTargetName(name)) {
      fail(file, `target name "${name}" must start with a-z or 0-9 and contain only a-z, 0-9, "_" and "-"`);
    }
    if (!isTable(value)) fail(file, `${where} must be a table ([${where}])`);
    checkKeys(value, TARGET_KEYS, `[${where}]`, file);
    if ((value.path === undefined) === (value.folder === undefined)) {
      fail(file, `${where} must have exactly one of path and folder`);
    }
    const flavor = requireString(value, "flavor", where, file);
    if (!isFlavor(flavor)) fail(file, `${where}.flavor "${flavor}" is not one of ${FLAVORS.join(", ")}`);
    if (value.path !== undefined) return { name, path: requireString(value, "path", where, file), flavor };
    const folder = requireString(value, "folder", where, file);
    if (!isVersionFolderName(folder)) {
      fail(file, `${where}.folder "${folder}" must be a single folder name in the game directory, such as "_retail_"`);
    }
    return { name, folder, flavor };
  });
}

/**
 * Why `name` cannot be an addon name, or undefined when it can. Names become cache directory
 * names, where "." and ".." would point at the cache itself or its parent.
 */
export function addonNameProblem(name: string): string | undefined {
  if (name.trim() === "") return "must not be blank";
  if (name.trim() === "." || name.trim() === "..") return 'must not be "." or ".."';
  return undefined;
}

export function parseManifest(text: string, file?: string): Manifest {
  let data: unknown;
  try {
    data = Bun.TOML.parse(text);
  } catch (err) {
    fail(file, `invalid TOML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isTable(data)) fail(file, "invalid TOML");
  if ("install" in data) {
    fail(
      file,
      'the manifest format changed: the [install] table was replaced by named [targets.<name>] tables. Move this file aside and run "wowget init" to create a new one, then add your addons again.',
    );
  }
  checkKeys(data, TOP_KEYS, "the top level", file);
  const targets = parseTargets(data, file);
  const targetNames = new Set(targets.map((t) => t.name));

  const rawAddons = data.addon ?? [];
  if (!Array.isArray(rawAddons)) fail(file, "addon must be an array of tables ([[addon]])");

  const addons: AddonEntry[] = [];
  const seen = new Set<string>();
  rawAddons.forEach((raw, i) => {
    const where = `addon #${i + 1}`;
    if (!isTable(raw)) fail(file, `${where} must be a table`);
    checkKeys(raw, ADDON_KEYS, where, file);
    const name = requireString(raw, "name", where, file);
    const nameProblem = addonNameProblem(name);
    if (nameProblem) fail(file, `${where}: name "${name}" ${nameProblem}`);
    const source = requireString(raw, "source", where, file);
    try {
      parseSource(source);
    } catch (err) {
      fail(file, `${where} (${name}): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (raw.prerelease !== undefined && typeof raw.prerelease !== "boolean") {
      fail(file, `${where}.prerelease must be true or false`);
    }
    if (raw.pin !== undefined && (typeof raw.pin !== "string" || raw.pin === "")) {
      fail(file, `${where}.pin must be a non-empty string`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) fail(file, `duplicate addon name "${name}"`);
    seen.add(key);
    const entry: AddonEntry = { name, source, prerelease: raw.prerelease === true };
    if (typeof raw.pin === "string") entry.pin = raw.pin;
    if (raw.targets !== undefined) {
      const list = raw.targets;
      if (!Array.isArray(list) || list.some((t) => typeof t !== "string")) {
        fail(file, `${where} (${name}): targets must be an array of target names`);
      }
      if (list.length === 0) fail(file, `${where} (${name}): targets must not be empty; remove the key to mean every target`);
      for (const t of list as string[]) {
        if (!targetNames.has(t)) fail(file, `${where} (${name}): unknown target "${t}"`);
      }
      if (new Set(list).size !== list.length) fail(file, `${where} (${name}): targets lists a target twice`);
      entry.targets = [...(list as string[])];
    }
    addons.push(entry);
  });

  return { targets, addons };
}

export async function readManifest(path: string): Promise<Manifest> {
  return parseManifest(await readText(path), path);
}

export function findAddon(manifest: Manifest, name: string): AddonEntry | undefined {
  const key = name.toLowerCase();
  return manifest.addons.find((a) => a.name.toLowerCase() === key);
}

export function findTarget(manifest: Manifest, name: string): NamedTarget | undefined {
  return manifest.targets.find((t) => t.name === name);
}

/** The names of the targets `entry` is on, in manifest order. */
export function addonTargets(manifest: Manifest, entry: AddonEntry): string[] {
  const names = manifest.targets.map((t) => t.name);
  return entry.targets ? names.filter((n) => entry.targets!.includes(n)) : names;
}

function tomlString(value: string): string {
  // JSON string escapes are a subset of TOML basic-string escapes.
  return JSON.stringify(value);
}

function renderTarget(name: string, target: Target): string {
  const location =
    target.folder !== undefined ? `folder = ${tomlString(target.folder)}` : `path = ${tomlString(target.path ?? "")}`;
  return `[targets.${name}]\n${location}\nflavor = ${tomlString(target.flavor)}\n`;
}

export function renderManifest(targets: NamedTarget[]): string {
  return targets.map((t) => renderTarget(t.name, t)).join("\n");
}

function renderTargetsLine(targets: string[]): string {
  return `targets = [${targets.map(tomlString).join(", ")}]`;
}

function renderPinLine(pin: string): string {
  return `pin = ${tomlString(pin)}`;
}

function renderAddon(entry: AddonEntry): string {
  let block = `[[addon]]\nname = ${tomlString(entry.name)}\nsource = ${tomlString(entry.source)}\n`;
  if (entry.targets !== undefined) block += `${renderTargetsLine(entry.targets)}\n`;
  if (entry.prerelease) block += "prerelease = true\n";
  if (entry.pin !== undefined) block += `pin = ${tomlString(entry.pin)}\n`;
  return block;
}

function appendBlock(text: string, block: string): string {
  let out = text;
  if (out !== "" && !out.endsWith("\n")) out += "\n";
  if (out !== "" && !out.endsWith("\n\n")) out += "\n";
  return out + block;
}

/** Returns `text` with a blank line and an `[[addon]]` block appended. */
export function appendAddonText(text: string, entry: AddonEntry): string {
  return appendBlock(text, renderAddon(entry));
}

const ADDON_HEADER = /^\s*\[\[\s*addon\s*\]\]\s*(#.*)?$/;
const TARGET_HEADER = /^\s*\[\s*targets\s*\.\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\]\s*(#.*)?$/;

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

function blockName(lines: string[]): string | undefined {
  try {
    const parsed = Bun.TOML.parse(lines.join("\n")) as { addon?: Array<{ name?: unknown }> };
    const name = parsed.addon?.[0]?.name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Index of the line after the block whose header is at `header`: the next line starting with "[". */
function blockEnd(lines: string[], header: number): number {
  let next = header + 1;
  while (next < lines.length && !lines[next]!.trimStart().startsWith("[")) next++;
  return next;
}

/**
 * The line range to remove for the block whose header is at `header`: up to its last key line,
 * plus the blank and comment lines directly above the header.
 */
function blockRange(lines: string[], header: number): [start: number, end: number] {
  let end = blockEnd(lines, header);
  while (end > header + 1 && isBlankOrComment(lines[end - 1]!)) end--;
  let start = header;
  while (start > 0 && isBlankOrComment(lines[start - 1]!)) start--;
  return [start, end];
}

/** Header line index of the `[[addon]]` block named `name` (case-insensitive). */
function findAddonHeader(lines: string[], name: string): number {
  const key = name.toLowerCase();
  for (let header = 0; header < lines.length; header++) {
    if (!ADDON_HEADER.test(lines[header]!)) continue;
    const next = blockEnd(lines, header);
    if (blockName(lines.slice(header, next))?.toLowerCase() === key) return header;
    header = next - 1;
  }
  throw new WowgetError("manifest", `Could not locate the [[addon]] block for "${name}"; edit the manifest by hand.`);
}

/**
 * Returns `text` without the `[[addon]]` block named `name`. The block runs from its header to
 * the last key line before the next line starting with "[". Blank and comment lines directly
 * above the header go with it; those between its last key and the next header stay, since they
 * introduce the next block.
 */
export function spliceAddonText(text: string, name: string): string {
  const lines = text.split("\n");
  const [start, end] = blockRange(lines, findAddonHeader(lines, name));
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

/** Returns `text` without the `[targets.<name>]` table, located and cut like an addon block. */
export function spliceTargetText(text: string, name: string): string {
  const lines = text.split("\n");
  const header = lines.findIndex((line) => {
    const m = TARGET_HEADER.exec(line);
    return m !== null && (m[1] ?? m[2] ?? m[3]) === name;
  });
  if (header < 0) {
    throw new WowgetError("manifest", `Could not locate the [targets.${name}] table; edit the manifest by hand.`);
  }
  const [start, end] = blockRange(lines, header);
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

/**
 * Returns `text` with a `[targets.<name>]` table inserted before the first `[[addon]]` block and
 * the comments that introduce it, or appended when there is no addon block.
 */
export function insertTargetText(text: string, name: string, target: Target): string {
  const block = renderTarget(name, target).replace(/\n$/, "").split("\n");
  const lines = text.split("\n");
  const first = lines.findIndex((line) => ADDON_HEADER.test(line));
  if (first < 0) return appendBlock(text, renderTarget(name, target));
  let start = first;
  while (start > 0 && isBlankOrComment(lines[start - 1]!)) start--;
  const before = lines.slice(0, start);
  const after = lines.slice(start);
  const out = [...before, ...(before.length ? [""] : []), ...block, ...(after[0]?.trim() === "" ? [] : [""]), ...after];
  return out.join("\n");
}

/** Index after the last line of the key/value pair that starts at `start`, which may span lines. */
function valueEnd(lines: string[], start: number, stop: number): number {
  for (let end = start + 1; end <= stop; end++) {
    try {
      Bun.TOML.parse(lines.slice(start, end).join("\n"));
      return end;
    } catch {
      // Not complete yet; a multi-line array or string continues on the next line.
    }
  }
  return start + 1;
}

/** Line index of the unquoted key `key` inside `[header + 1, end)`, skipping multi-line values. */
function findBlockKeyLine(lines: string[], header: number, end: number, key: string): number {
  const re = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = header + 1; i < end; ) {
    if (isBlankOrComment(lines[i]!)) {
      i++;
      continue;
    }
    if (re.test(lines[i]!)) return i;
    i = valueEnd(lines, i, end);
  }
  return -1;
}

/**
 * Returns `text` with the `targets =` line of the addon block named `name` replaced, inserted
 * after its `source =` line, or deleted when `targets` is undefined.
 */
export function setAddonTargetsText(text: string, name: string, targets: string[] | undefined): string {
  const lines = text.split("\n");
  const header = findAddonHeader(lines, name);
  const end = blockEnd(lines, header);
  const existing = findBlockKeyLine(lines, header, end, "targets");
  if (existing >= 0) {
    const stop = valueEnd(lines, existing, end);
    const replacement = targets === undefined ? [] : [renderTargetsLine(targets)];
    return [...lines.slice(0, existing), ...replacement, ...lines.slice(stop)].join("\n");
  }
  if (targets === undefined) return text;
  const source = findBlockKeyLine(lines, header, end, "source");
  const at = source >= 0 ? valueEnd(lines, source, end) : header + 1;
  return [...lines.slice(0, at), renderTargetsLine(targets), ...lines.slice(at)].join("\n");
}

/**
 * Returns `text` with the `pin =` line of the addon block named `name` replaced, appended at the
 * end of the block's keys, or deleted when `pin` is undefined.
 */
export function setAddonPinText(text: string, name: string, pin: string | undefined): string {
  const lines = text.split("\n");
  const header = findAddonHeader(lines, name);
  const end = blockEnd(lines, header);
  const existing = findBlockKeyLine(lines, header, end, "pin");
  if (existing >= 0) {
    const stop = valueEnd(lines, existing, end);
    const replacement = pin === undefined ? [] : [renderPinLine(pin)];
    return [...lines.slice(0, existing), ...replacement, ...lines.slice(stop)].join("\n");
  }
  if (pin === undefined) return text;
  const [, blockStop] = blockRange(lines, header);
  return [...lines.slice(0, blockStop), renderPinLine(pin), ...lines.slice(blockStop)].join("\n");
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WowgetError("not_found", `Manifest not found at ${path}. Run "wowget init" first.`);
    }
    throw err;
  }
}

/** Replaces the file at `path`, or at its symlink target, keeping the file's mode. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const real = await realpath(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return path;
    throw err;
  });
  const mode = await stat(real).then(
    (s) => s.mode & 0o7777,
    () => undefined,
  );
  const tmp = `${real}.tmp`;
  await writeFile(tmp, text);
  if (mode !== undefined) await chmod(tmp, mode);
  await rename(tmp, real);
}

function sameTargets(a: NamedTarget[], b: NamedTarget[]): boolean {
  const norm = (list: NamedTarget[]) =>
    list
      .map((t) => JSON.stringify([t.name, t.path ?? null, t.folder ?? null, t.flavor]))
      .sort()
      .join("\n");
  return norm(a) === norm(b);
}

function sameAddons(a: AddonEntry[], b: AddonEntry[]): boolean {
  const norm = (list: AddonEntry[]) =>
    list
      .map((e) => JSON.stringify([e.name.toLowerCase(), e.source, e.prerelease, e.pin ?? null, e.targets ?? null]))
      .sort()
      .join("\n");
  return norm(a) === norm(b);
}

/** Why `parsed` is not `expected`, or undefined when they match. */
function mismatch(parsed: Manifest, expected: Manifest): string | undefined {
  if (!sameTargets(parsed.targets, expected.targets)) return "the targets did not match the expected result";
  if (!sameAddons(parsed.addons, expected.addons)) return "the addon list did not match the expected result";
  return undefined;
}

/** Throws unless `next` parses back to `expected`; nothing is written. */
function checkPlanned(path: string, next: string, expected: Manifest): void {
  let reason: string | undefined;
  try {
    reason = mismatch(parseManifest(next, path), expected);
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  if (reason !== undefined) {
    throw new WowgetError("manifest", `Updating ${path} failed (${reason}); the file was left unchanged.`);
  }
}

/** Writes `next`, re-parses the file, and restores `previous` if the result is not `expected`. */
async function writeChecked(path: string, previous: string, next: string, expected: Manifest): Promise<Manifest> {
  await writeAtomic(path, next);
  let reason: string;
  try {
    const parsed = parseManifest(await readFile(path, "utf8"), path);
    const why = mismatch(parsed, expected);
    if (why === undefined) return parsed;
    reason = why;
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  await writeAtomic(path, previous);
  throw new WowgetError("manifest", `Updating ${path} failed (${reason}); the file was left unchanged.`);
}

export async function createManifest(path: string, targets: NamedTarget[]): Promise<Manifest> {
  if (await Bun.file(path).exists()) {
    throw new WowgetError("manifest_exists", `A manifest already exists at ${path}.`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, renderManifest(targets));
  return readManifest(path);
}

export async function addAddon(path: string, entry: AddonEntry): Promise<Manifest> {
  const text = await readText(path);
  const manifest = parseManifest(text, path);
  if (findAddon(manifest, entry.name)) {
    throw new WowgetError("duplicate", `An addon named "${entry.name}" is already in the manifest.`);
  }
  const expected = { ...manifest, addons: [...manifest.addons, entry] };
  return writeChecked(path, text, appendAddonText(text, entry), expected);
}

/** The manifest file's text and its parsed form. */
export async function readManifestText(path: string): Promise<{ text: string; manifest: Manifest }> {
  const text = await readText(path);
  return { text, manifest: parseManifest(text, path) };
}

/**
 * Writes `next`, which a plan function computed from `previous`, unless the file no longer holds
 * `previous`.
 */
export async function writePlanned(path: string, previous: string, next: string): Promise<Manifest> {
  if ((await readText(path)) !== previous) {
    throw new WowgetError("manifest", `${path} changed while wowget was running, so it was not updated.`);
  }
  return writePlannedText(path, previous, next);
}

/** Returns `text` without the addon named `name`, checked to parse back to the expected manifest. */
export function planRemoveAddon(text: string, name: string, path = "the manifest"): string {
  const manifest = parseManifest(text, path);
  const entry = findAddon(manifest, name);
  if (!entry) throw new WowgetError("not_found", `No addon named "${name}" in the manifest.`);
  const next = spliceAddonText(text, entry.name);
  checkPlanned(path, next, { ...manifest, addons: manifest.addons.filter((a) => a !== entry) });
  return next;
}

/** Writes `next`, already checked by a plan function, then checks the file again. */
function writePlannedText(path: string, previous: string, next: string): Promise<Manifest> {
  return writeChecked(path, previous, next, parseManifest(next, path));
}

export async function removeAddon(path: string, name: string): Promise<Manifest> {
  const text = await readText(path);
  return writePlannedText(path, text, planRemoveAddon(text, name, path));
}

export async function addTarget(path: string, name: string, target: Target): Promise<Manifest> {
  if (!isTargetName(name)) {
    throw new WowgetError(
      "usage",
      `Target name "${name}" must start with a-z or 0-9 and contain only a-z, 0-9, "_" and "-".`,
    );
  }
  const text = await readText(path);
  const manifest = parseManifest(text, path);
  if (findTarget(manifest, name)) throw new WowgetError("duplicate", `A target named "${name}" is already in the manifest.`);
  const expected = { ...manifest, targets: [...manifest.targets, { name, ...target }] };
  return writeChecked(path, text, insertTargetText(text, name, target), expected);
}

export interface RemoveTargetResult {
  manifest: Manifest;
  /** Addons whose entries were removed because the target was the last one they were on. */
  removedAddons: string[];
}

/**
 * Returns `text` without the `[targets.<name>]` table and with the name dropped from every addon's
 * `targets` list, checked to parse back to the expected manifest. Addons that would be left with
 * an empty list are removed.
 */
export function planRemoveTarget(text: string, name: string, path = "the manifest"): { text: string; removedAddons: string[] } {
  const manifest = parseManifest(text, path);
  if (!findTarget(manifest, name)) throw new WowgetError("not_found", `No target named "${name}" in the manifest.`);
  let next = spliceTargetText(text, name);
  const addons: AddonEntry[] = [];
  const removedAddons: string[] = [];
  for (const entry of manifest.addons) {
    if (!entry.targets?.includes(name)) {
      addons.push(entry);
      continue;
    }
    const remaining = entry.targets.filter((t) => t !== name);
    if (remaining.length) {
      next = setAddonTargetsText(next, entry.name, remaining);
      addons.push({ ...entry, targets: remaining });
    } else {
      next = spliceAddonText(next, entry.name);
      removedAddons.push(entry.name);
    }
  }
  checkPlanned(path, next, { targets: manifest.targets.filter((t) => t.name !== name), addons });
  return { text: next, removedAddons };
}

/** Removes the target as planRemoveTarget describes. */
export async function removeTarget(path: string, name: string): Promise<RemoveTargetResult> {
  const text = await readText(path);
  const { text: next, removedAddons } = planRemoveTarget(text, name, path);
  return { manifest: await writePlannedText(path, text, next), removedAddons };
}

/**
 * Returns `text` with the addon's `targets` list set, checked to parse back to the expected
 * manifest; `undefined` removes the key, meaning every target.
 */
export function planSetAddonTargets(text: string, name: string, targets: string[] | undefined, path = "the manifest"): string {
  const manifest = parseManifest(text, path);
  const entry = findAddon(manifest, name);
  if (!entry) throw new WowgetError("not_found", `No addon named "${name}" in the manifest.`);
  const updated: AddonEntry = { ...entry };
  if (targets === undefined) delete updated.targets;
  else updated.targets = [...targets];
  const next = setAddonTargetsText(text, entry.name, targets);
  checkPlanned(path, next, { ...manifest, addons: manifest.addons.map((a) => (a === entry ? updated : a)) });
  return next;
}

/** Sets the addon's `targets` list; `undefined` removes the key, meaning every target. */
export async function setAddonTargets(path: string, name: string, targets: string[] | undefined): Promise<Manifest> {
  const text = await readText(path);
  return writePlannedText(path, text, planSetAddonTargets(text, name, targets, path));
}

/**
 * Returns `text` with the addon's `pin` set, checked to parse back to the expected manifest;
 * `undefined` removes the key.
 */
export function planSetAddonPin(text: string, name: string, pin: string | undefined, path = "the manifest"): string {
  if (pin === "") throw new WowgetError("usage", "Pin must not be empty.");
  const manifest = parseManifest(text, path);
  const entry = findAddon(manifest, name);
  if (!entry) throw new WowgetError("not_found", `No addon named "${name}" in the manifest.`);
  const updated: AddonEntry = { ...entry };
  if (pin === undefined) delete updated.pin;
  else updated.pin = pin;
  const next = setAddonPinText(text, entry.name, pin);
  checkPlanned(path, next, { ...manifest, addons: manifest.addons.map((a) => (a === entry ? updated : a)) });
  return next;
}

/** Sets or clears (`undefined`) the addon's `pin` in the manifest. */
export async function setAddonPin(path: string, name: string, pin: string | undefined): Promise<Manifest> {
  const text = await readText(path);
  return writePlannedText(path, text, planSetAddonPin(text, name, pin, path));
}
