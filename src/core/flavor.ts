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

const OWN_SUFFIXES: Record<Flavor, string[]> = {
  forever: ["Forever", "Camelot", "Mainline"],
  mainline: ["Standard", "Mainline"],
  classic: ["Vanilla", "Classic"],
  bcc: ["TBC", "BCC", "Classic"],
  wrath: ["Wrath", "WOTLKC", "Classic"],
  cata: ["Cata", "Classic"],
  mists: ["Mists", "Classic"],
};

const KNOWN_SUFFIXES = [...new Set(Object.values(OWN_SUFFIXES).flat())];

/** TOC suffixes that satisfy a flavor, in priority order. "" is the unsuffixed TOC. */
export function tocSuffixes(flavor: Flavor): string[] {
  return [...OWN_SUFFIXES[flavor], ""];
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

export function interfaceMatchesFlavor(iface: number, flavor: Flavor): Support {
  switch (flavor) {
    case "forever":
      return iface >= 16000 && iface <= 16999 ? "yes" : "no";
    case "classic":
      return iface >= 11000 && iface <= 11999 ? "yes" : "no";
    case "mainline":
      return iface >= 100000 ? "yes" : "no";
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

/** TOC file names in `dir` that belong to the folder (base name equals the folder name). */
export async function addonTocs(dir: string): Promise<string[]> {
  const name = basename(dir).toLowerCase();
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && /\.toc$/i.test(e.name))
    .map((e) => e.name)
    .filter((f) => splitTocName(f).base.toLowerCase() === name);
}

export async function folderSupportsFlavor(dir: string, flavor: Flavor): Promise<Support> {
  const tocs = await addonTocs(dir);
  const wanted = OWN_SUFFIXES[flavor];
  if (tocs.some((f) => wanted.includes(splitTocName(f).suffix))) return "yes";

  let result: Support = "no";
  for (const file of tocs.filter((f) => splitTocName(f).suffix === "")) {
    const toc = parseToc(await readFile(join(dir, file), "utf8"));
    for (const [key, value] of Object.entries(toc.fields)) {
      const typed = /^interface-(.+)$/i.exec(key);
      if (typed && wanted.some((s) => s.toLowerCase() === typed[1]!.toLowerCase()) && parseInterfaceList(value).length) {
        return "yes";
      }
    }
    if (toc.interface.length === 0) {
      result = "unknown";
      continue;
    }
    const matches = toc.interface.map((n) => interfaceMatchesFlavor(n, flavor));
    if (matches.includes("yes")) return "yes";
    if (matches.includes("unknown")) result = "unknown";
  }
  if (tocs.length === 0) return "unknown";
  return result;
}
