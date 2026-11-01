import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WowgetError } from "./errors.ts";
import { FLAVORS, isFlavor, type Flavor } from "./flavor.ts";
import { parseSource } from "./sources/parse.ts";

export interface InstallConfig {
  path: string;
  flavor: Flavor;
}

export interface AddonEntry {
  name: string;
  source: string;
  prerelease: boolean;
  pin?: string;
}

export interface Manifest {
  install: InstallConfig;
  addons: AddonEntry[];
}

const TOP_KEYS = ["install", "addon"];
const INSTALL_KEYS = ["path", "flavor"];
const ADDON_KEYS = ["name", "source", "prerelease", "pin"];

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

export function parseManifest(text: string, file?: string): Manifest {
  let data: unknown;
  try {
    data = Bun.TOML.parse(text);
  } catch (err) {
    fail(file, `invalid TOML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isTable(data)) fail(file, "invalid TOML");
  checkKeys(data, TOP_KEYS, "the top level", file);

  const install = data.install;
  if (!isTable(install)) fail(file, "missing [install] table");
  checkKeys(install, INSTALL_KEYS, "[install]", file);
  const path = requireString(install, "path", "install", file);
  const flavor = requireString(install, "flavor", "install", file);
  if (!isFlavor(flavor)) fail(file, `install.flavor "${flavor}" is not one of ${FLAVORS.join(", ")}`);

  const rawAddons = data.addon ?? [];
  if (!Array.isArray(rawAddons)) fail(file, "addon must be an array of tables ([[addon]])");

  const addons: AddonEntry[] = [];
  const seen = new Set<string>();
  rawAddons.forEach((raw, i) => {
    const where = `addon #${i + 1}`;
    if (!isTable(raw)) fail(file, `${where} must be a table`);
    checkKeys(raw, ADDON_KEYS, where, file);
    const name = requireString(raw, "name", where, file);
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
    addons.push(entry);
  });

  return { install: { path, flavor }, addons };
}

export async function readManifest(path: string): Promise<Manifest> {
  return parseManifest(await readText(path), path);
}

export function findAddon(manifest: Manifest, name: string): AddonEntry | undefined {
  const key = name.toLowerCase();
  return manifest.addons.find((a) => a.name.toLowerCase() === key);
}

function tomlString(value: string): string {
  // JSON string escapes are a subset of TOML basic-string escapes.
  return JSON.stringify(value);
}

export function renderManifest(install: InstallConfig): string {
  return `[install]\npath = ${tomlString(install.path)}\nflavor = ${tomlString(install.flavor)}\n`;
}

function renderAddon(entry: AddonEntry): string {
  let block = `[[addon]]\nname = ${tomlString(entry.name)}\nsource = ${tomlString(entry.source)}\n`;
  if (entry.prerelease) block += "prerelease = true\n";
  if (entry.pin !== undefined) block += `pin = ${tomlString(entry.pin)}\n`;
  return block;
}

/** Returns `text` with a blank line and an `[[addon]]` block appended. */
export function appendAddonText(text: string, entry: AddonEntry): string {
  let out = text;
  if (out !== "" && !out.endsWith("\n")) out += "\n";
  if (out !== "" && !out.endsWith("\n\n")) out += "\n";
  return out + renderAddon(entry);
}

const ADDON_HEADER = /^\s*\[\[\s*addon\s*\]\]\s*(#.*)?$/;

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

/**
 * Returns `text` without the `[[addon]]` block named `name`. The block runs from its header to
 * the last key line before the next line starting with "[". Blank and comment lines directly
 * above the header go with it; those between its last key and the next header stay, since they
 * introduce the next block.
 */
export function spliceAddonText(text: string, name: string): string {
  const lines = text.split("\n");
  const key = name.toLowerCase();
  for (let header = 0; header < lines.length; header++) {
    if (!ADDON_HEADER.test(lines[header]!)) continue;
    let next = header + 1;
    while (next < lines.length && !lines[next]!.trimStart().startsWith("[")) next++;
    if (blockName(lines.slice(header, next))?.toLowerCase() !== key) {
      header = next - 1;
      continue;
    }
    let end = next;
    while (end > header + 1 && isBlankOrComment(lines[end - 1]!)) end--;
    let start = header;
    while (start > 0 && isBlankOrComment(lines[start - 1]!)) start--;
    return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
  }
  throw new WowgetError("manifest", `Could not locate the [[addon]] block for "${name}"; edit the manifest by hand.`);
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

function sameAddons(a: AddonEntry[], b: AddonEntry[]): boolean {
  const norm = (list: AddonEntry[]) =>
    list
      .map((e) => JSON.stringify([e.name.toLowerCase(), e.source, e.prerelease, e.pin ?? null]))
      .sort()
      .join("\n");
  return norm(a) === norm(b);
}

/** Writes `next`, re-parses the file, and restores `previous` if the result is not `expected`. */
async function writeChecked(path: string, previous: string, next: string, expected: Manifest): Promise<Manifest> {
  await writeAtomic(path, next);
  let reason: string;
  try {
    const parsed = parseManifest(await readFile(path, "utf8"), path);
    const sameInstall =
      parsed.install.path === expected.install.path && parsed.install.flavor === expected.install.flavor;
    if (sameInstall && sameAddons(parsed.addons, expected.addons)) return parsed;
    reason = sameInstall ? "the addon list did not match the expected result" : "the [install] table changed";
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  await writeAtomic(path, previous);
  throw new WowgetError("manifest", `Updating ${path} failed (${reason}); the file was left unchanged.`);
}

export async function createManifest(path: string, install: InstallConfig): Promise<Manifest> {
  if (await Bun.file(path).exists()) {
    throw new WowgetError("manifest_exists", `A manifest already exists at ${path}.`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, renderManifest(install));
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

export async function removeAddon(path: string, name: string): Promise<Manifest> {
  const text = await readText(path);
  const manifest = parseManifest(text, path);
  const entry = findAddon(manifest, name);
  if (!entry) throw new WowgetError("not_found", `No addon named "${name}" in the manifest.`);
  const expected = { ...manifest, addons: manifest.addons.filter((a) => a !== entry) };
  return writeChecked(path, text, spliceAddonText(text, entry.name), expected);
}
