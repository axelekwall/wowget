export const FLAVORS = ["forever", "mainline", "classic", "bcc", "wrath", "cata", "mists"] as const;
export type Flavor = (typeof FLAVORS)[number];
export type Support = "yes" | "no" | "unknown";

/** One bit per flavor, in FLAVORS order, for the catalogue's indexed flavor column. */
export function flavorMask(flavors: readonly Flavor[]): number {
  return flavors.reduce((mask, f) => mask | (1 << FLAVORS.indexOf(f)), 0);
}

export function isFlavor(value: unknown): value is Flavor {
  return typeof value === "string" && (FLAVORS as readonly string[]).includes(value);
}
