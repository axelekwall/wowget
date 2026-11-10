import { lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Flavor } from "./flavor.ts";

/** The flavor of the progressive Classic line (`_classic_`), which moves with each expansion. */
export const PROGRESSIVE_CLASSIC_FLAVOR: Flavor = "mists";

/** Version folders under the game directory, with the default target name and flavor of each. */
export const VERSION_FOLDERS: readonly { folder: string; name: string; flavor: Flavor }[] = [
  { folder: "_forever_", name: "forever", flavor: "forever" },
  { folder: "_classic_era_", name: "era", flavor: "classic" },
  { folder: "_classic_", name: "classic", flavor: PROGRESSIVE_CLASSIC_FLAVOR },
  { folder: "_retail_", name: "retail", flavor: "mainline" },
];

/** Files whose presence makes a version folder an installed game. */
const MARKERS = ["World of Warcraft.app", "World of Warcraft Classic.app", "Wow.exe", "WowClassic.exe", ".flavor.info"];

export interface DetectedInstall {
  /** Default target name. */
  name: string;
  flavor: Flavor;
  /** The version folder, e.g. `<gameDir>/_forever_`. */
  versionDir: string;
  /** `<versionDir>/Interface/AddOns`, which may not exist yet. */
  addonsDir: string;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** The installed version folders in `gameDir`, in the order of VERSION_FOLDERS. */
export async function detectInstalls(gameDir: string): Promise<DetectedInstall[]> {
  const found: DetectedInstall[] = [];
  for (const { folder, name, flavor } of VERSION_FOLDERS) {
    const versionDir = join(gameDir, folder);
    const isDir = await stat(versionDir).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isDir) continue;
    let installed = false;
    for (const marker of MARKERS) {
      if (await exists(join(versionDir, marker))) {
        installed = true;
        break;
      }
    }
    if (installed) found.push({ name, flavor, versionDir, addonsDir: join(versionDir, "Interface", "AddOns") });
  }
  return found;
}

/**
 * The AddOns directory of version folder `folder` in the first of `gameDirs` that has that folder,
 * or undefined when none does. The AddOns directory itself may not exist yet.
 */
export async function findVersionFolder(folder: string, gameDirs: string[]): Promise<string | undefined> {
  for (const gameDir of gameDirs) {
    const versionDir = join(gameDir, folder);
    const isDir = await stat(versionDir).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (isDir) return join(versionDir, "Interface", "AddOns");
  }
  return undefined;
}
