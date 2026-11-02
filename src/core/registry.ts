import { WowgetError } from "./errors.ts";
import { FLAVORS, isFlavor, type Flavor } from "./flavor.ts";
import { addonNameProblem } from "./manifest.ts";
import { parseSource } from "./sources/parse.ts";

/** One curated addon in `registry/addons.toml`. */
export interface RegistryEntry {
  name: string;
  source: string;
  flavors: Flavor[];
  folders: string[];
  aliases: string[];
  description?: string;
}

export interface ParsedRegistry {
  entries: RegistryEntry[];
  /** Why entries were rejected or keys were unknown; only collected in strict mode. */
  problems: string[];
}

const ENTRY_KEYS = ["name", "source", "flavors", "folders", "aliases", "description"];

/** Lower-cased with everything but letters and digits removed, for comparing names and queries. */
export function normaliseName(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v === "")) return undefined;
  return value as string[];
}

/** Validates one `[[addon]]` table, returning the entry or what is wrong with it. */
function parseEntry(raw: unknown, strict: boolean): RegistryEntry | string[] {
  if (!isTable(raw)) return ["must be a table"];
  const problems: string[] = [];
  if (strict) {
    for (const key of Object.keys(raw)) {
      if (!ENTRY_KEYS.includes(key)) problems.push(`unknown key "${key}"`);
    }
  }

  const name = raw.name;
  if (typeof name !== "string" || name === "") problems.push("name must be a non-empty string");
  else {
    const nameProblem = addonNameProblem(name);
    if (nameProblem) problems.push(`name "${name}" ${nameProblem}`);
    if (normaliseName(name) === "") problems.push(`name "${name}" has no letters or digits`);
  }

  const source = raw.source;
  if (typeof source !== "string" || source === "") problems.push("source must be a non-empty string");
  else {
    try {
      if (parseSource(source).kind === "url") problems.push("url: sources are not allowed in the registry");
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }

  const flavors = stringList(raw.flavors);
  if (!flavors || flavors.length === 0) problems.push("flavors must be a non-empty array of flavor names");
  else {
    for (const f of flavors) {
      if (!isFlavor(f)) problems.push(`flavor "${f}" is not one of ${FLAVORS.join(", ")}`);
    }
    if (new Set(flavors).size !== flavors.length) problems.push("flavors lists a flavor twice");
  }

  const folders = stringList(raw.folders);
  if (!folders || folders.length === 0) problems.push("folders must be a non-empty array of folder names");

  const aliases = raw.aliases === undefined ? [] : stringList(raw.aliases);
  if (!aliases) problems.push("aliases must be an array of non-empty strings");
  else if (aliases.some((a) => normaliseName(a) === "")) problems.push("every alias needs a letter or digit");

  if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.includes("\n"))) {
    problems.push("description must be a one-line string");
  }

  if (problems.length) return problems;
  const entry: RegistryEntry = {
    name: name as string,
    source: source as string,
    flavors: flavors as Flavor[],
    folders: folders!,
    aliases: aliases!,
  };
  if (typeof raw.description === "string" && raw.description !== "") entry.description = raw.description;
  return entry;
}

/**
 * Parses the registry file. Strict mode (the check script) reports every problem. Otherwise
 * invalid entries are dropped and unknown keys ignored, so a binary keeps working when a newer
 * registry uses a source kind or key it does not know.
 */
export function parseRegistry(text: string, options: { strict?: boolean } = {}): ParsedRegistry {
  const strict = options.strict ?? false;
  let data: unknown;
  try {
    data = Bun.TOML.parse(text);
  } catch (err) {
    throw new WowgetError("source", `The addon registry is not valid TOML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isTable(data) || !Array.isArray(data.addon ?? [])) {
    throw new WowgetError("source", "The addon registry must be a list of [[addon]] tables.");
  }

  const problems: string[] = [];
  if (strict) {
    for (const key of Object.keys(data)) {
      if (key !== "addon") problems.push(`unknown top-level key "${key}"`);
    }
  }
  const entries: RegistryEntry[] = [];
  const owners = new Map<string, string>();
  ((data.addon ?? []) as unknown[]).forEach((raw, i) => {
    const label = isTable(raw) && typeof raw.name === "string" ? `addon #${i + 1} (${raw.name})` : `addon #${i + 1}`;
    const parsed = parseEntry(raw, strict);
    if (Array.isArray(parsed)) {
      if (strict) problems.push(...parsed.map((p) => `${label}: ${p}`));
      return;
    }
    // Names and aliases share one namespace, since bare-name add looks up both.
    const keys = [...new Set([parsed.name, ...parsed.aliases].map(normaliseName))];
    const clash = keys.find((k) => owners.has(k));
    if (clash) {
      if (strict) problems.push(`${label}: "${clash}" is already used by ${owners.get(clash)}`);
      return;
    }
    for (const k of keys) owners.set(k, parsed.name);
    entries.push(parsed);
  });
  return { entries, problems };
}
