export const FLAVORS = ["forever", "mainline", "classic", "bcc", "wrath", "cata", "mists"] as const;
export type Flavor = (typeof FLAVORS)[number];
export type Support = "yes" | "no" | "unknown";

export function isFlavor(value: unknown): value is Flavor {
  return typeof value === "string" && (FLAVORS as readonly string[]).includes(value);
}
