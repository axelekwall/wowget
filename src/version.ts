// Set at build time with --define WOWGET_VERSION='"x.y.z"' (see scripts/build-release.ts).
declare const WOWGET_VERSION: string | undefined;

export const VERSION: string = typeof WOWGET_VERSION === "string" ? WOWGET_VERSION : "dev";
