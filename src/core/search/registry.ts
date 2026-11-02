import type { Flavor, Support } from "../flavor.ts";
import type { RegistryEntry } from "../registry.ts";
import { parseSource } from "../sources/parse.ts";
import type { SearchRow } from "./types.ts";

function sourceUrl(source: string): string | undefined {
  const spec = parseSource(source);
  if (spec.kind === "github") return `https://github.com/${spec.owner}/${spec.repo}`;
  if (spec.kind === "wowi") return `https://www.wowinterface.com/downloads/info${spec.id}`;
  return undefined;
}

export function registryRows(entries: RegistryEntry[]): SearchRow[] {
  return entries.map((entry, order) => {
    const flavors: Partial<Record<Flavor, Support>> = {};
    for (const f of entry.flavors) flavors[f] = "yes";
    const row: SearchRow = {
      name: entry.name,
      source: entry.source,
      origin: "registry",
      flavors,
      aliases: entry.aliases,
      folders: entry.folders,
      order,
    };
    if (entry.description) row.description = entry.description;
    const url = sourceUrl(entry.source);
    if (url) row.url = url;
    return row;
  });
}
