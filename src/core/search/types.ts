import type { Flavor, Support } from "../flavor.ts";

export type Origin = "registry" | "wowi" | "github";

/** One search candidate, from any source. */
export interface SearchRow {
  name: string;
  /** A source string `wowget add` accepts. */
  source: string;
  origin: Origin;
  /** Support per flavor; a flavor that is absent is "no". */
  flavors: Partial<Record<Flavor, Support>>;
  aliases: string[];
  folders: string[];
  description?: string;
  downloadsMonthly?: number;
  stars?: number;
  /** ISO 8601. */
  updatedAt?: string;
  url?: string;
  /** Position in the registry file; registry rows have no popularity and keep this order. */
  order?: number;
}
