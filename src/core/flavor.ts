import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const FLAVORS = ["forever", "mainline", "classic", "bcc", "wrath", "cata", "mists"] as const;
export type Flavor = (typeof FLAVORS)[number];
export type FlavorFamily = "mainline" | "classic";
export type Support = "yes" | "no" | "unknown";

export function isFlavor(value: unknown): value is Flavor {
  return typeof value === "string" && (FLAVORS as readonly string[]).includes(value);
}

export function flavorFamily(flavor: Flavor): FlavorFamily {
  return flavor === "forever" || flavor === "mainline" ? "mainline" : "classic";
}

/** TOC suffixes that name exactly this flavor. */
const OWN_SUFFIXES: Record<Flavor, string[]> = {
  forever: ["Forever", "Camelot"],
  mainline: ["Mainline", "Standard"],
  classic: ["Vanilla"],
  bcc: ["TBC", "BCC"],
  wrath: ["Wrath", "WOTLKC"],
  cata: ["Cata"],
  mists: ["Mists"],
};

/** TOC suffixes shared by several flavors; they count only when their interface list is in range. */
const FAMILY_SUFFIXES: Record<Flavor, string[]> = {
  forever: ["Mainline"],
  mainline: [],
  classic: ["Classic"],
  bcc: ["Classic"],
  wrath: ["Classic"],
  cata: ["Classic"],
  mists: ["Classic"],
};

const KNOWN_SUFFIXES = [...new Set([...Object.values(OWN_SUFFIXES).flat(), ...Object.values(FAMILY_SUFFIXES).flat()])];

/** TOC suffixes that may satisfy a flavor, in priority order. "" is the unsuffixed TOC. */
export function tocSuffixes(flavor: Flavor): string[] {
  return [...OWN_SUFFIXES[flavor], ...FAMILY_SUFFIXES[flavor], ""];
}

/** Splits "Questie-Classic.toc" into base "Questie" and suffix "Classic". */
export function splitTocName(fileName: string): { base: string; suffix: string } {
  const stem = fileName.replace(/\.toc$/i, "");
  const match = /^(.*)[_-]([A-Za-z]+)$/.exec(stem);
  if (match) {
    const known = KNOWN_SUFFIXES.find((s) => s.toLowerCase() === match[2]!.toLowerCase());
    if (known && match[1]) return { base: match[1], suffix: known };
  }
  return { base: stem, suffix: "" };
}

/**
 * The flavor suffix of a TOC file in folder `folderName`, or undefined when the TOC does not
 * belong to the folder. A TOC whose whole stem is the folder name counts as unsuffixed, so
 * "BigWigs_Classic/BigWigs_Classic.toc" belongs to its folder.
 */
export function tocSuffixFor(fileName: string, folderName: string): string | undefined {
  if (!/\.toc$/i.test(fileName)) return undefined;
  const folder = folderName.toLowerCase();
  if (fileName.replace(/\.toc$/i, "").toLowerCase() === folder) return "";
  const { base, suffix } = splitTocName(fileName);
  return base.toLowerCase() === folder ? suffix : undefined;
}

export function interfaceMatchesFlavor(iface: number, flavor: Flavor): Support {
  switch (flavor) {
    case "forever":
      return iface >= 16000 && iface <= 16999 ? "yes" : "no";
    case "classic":
      return iface >= 11000 && iface <= 11999 ? "yes" : "no";
    case "mainline":
      return iface >= 100000 ? "yes" : "no";
    case "bcc":
      return iface >= 20000 && iface <= 29999 ? "yes" : "no";
    case "wrath":
      return iface >= 30000 && iface <= 39999 ? "yes" : "no";
    case "cata":
      return iface >= 40000 && iface <= 49999 ? "yes" : "no";
    case "mists":
      return iface >= 50000 && iface <= 59999 ? "yes" : "no";
    default:
      return "unknown";
  }
}

export interface Toc {
  interface: number[];
  title?: string;
  version?: string;
  fields: Record<string, string>;
}

function parseInterfaceList(value: string): number[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
}

export function parseToc(text: string): Toc {
  const toc: Toc = { interface: [], fields: {} };
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const match = /^##\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(raw);
    if (!match) continue;
    const key = match[1]!;
    const value = match[2]!;
    toc.fields[key] = value;
    const lower = key.toLowerCase();
    if (lower === "interface") toc.interface = parseInterfaceList(value);
    else if (lower === "title") toc.title = value;
    else if (lower === "version") toc.version = value;
  }
  return toc;
}

/** TOC file names in `dir` that belong to the folder (see tocSuffixFor). */
export async function addonTocs(dir: string): Promise<string[]> {
  const name = basename(dir);
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile() && tocSuffixFor(e.name, name) !== undefined).map((e) => e.name);
}

const sameSuffix = (list: string[], suffix: string) => list.some((s) => s.toLowerCase() === suffix.toLowerCase());

/**
 * A TOC with the flavor's own suffix means yes. A family-suffixed or unsuffixed TOC, and each
 * `## Interface-<Suffix>:` line, counts by its interface list: yes when a number is in the
 * flavor's range, no when every list is entirely outside it, unknown otherwise.
 */
export async function folderSupportsFlavor(dir: string, flavor: Flavor): Promise<Support> {
  const name = basename(dir);
  const tocs = (await addonTocs(dir)).map((file) => ({ file, suffix: tocSuffixFor(file, name)! }));
  if (tocs.length === 0) return "unknown";
  const own = OWN_SUFFIXES[flavor];
  const family = FAMILY_SUFFIXES[flavor];
  if (tocs.some((t) => sameSuffix(own, t.suffix))) return "yes";

  const lists: number[][] = [];
  for (const { file, suffix } of tocs) {
    if (suffix !== "" && !sameSuffix(family, suffix)) continue;
    const toc = parseToc(await readFile(join(dir, file), "utf8"));
    lists.push(toc.interface);
    for (const [key, value] of Object.entries(toc.fields)) {
      const typed = /^interface-(.+)$/i.exec(key);
      if (!typed) continue;
      const parsed = parseInterfaceList(value);
      if (sameSuffix(own, typed[1]!) && parsed.length) return "yes";
      if (sameSuffix(family, typed[1]!)) lists.push(parsed);
    }
  }

  let result: Support = "no";
  for (const list of lists) {
    if (list.length === 0) {
      result = "unknown";
      continue;
    }
    const matches = list.map((n) => interfaceMatchesFlavor(n, flavor));
    if (matches.includes("yes")) return "yes";
    if (matches.includes("unknown")) result = "unknown";
  }
  return result;
}
