import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectInstalls } from "../src/core/detect.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();

describe("detectInstalls", () => {
  test("finds version folders that hold a game, in table order, and ignores the rest", async () => {
    const gameDir = await tempDir();
    const folder = async (name: string, marker?: string) => {
      await mkdir(join(gameDir, name), { recursive: true });
      if (marker) await writeFile(join(gameDir, name, marker), "");
    };
    await folder("_retail_", ".flavor.info");
    await folder("_classic_", "WowClassic.exe");
    await folder("_forever_", ".flavor.info");
    await mkdir(join(gameDir, "_classic_era_", "World of Warcraft Classic.app"), { recursive: true });
    await folder("_ptr_", ".flavor.info");
    await folder("_classic_beta_", ".flavor.info");
    await mkdir(join(gameDir, "_xptr_", "Interface", "AddOns"), { recursive: true });

    expect(await detectInstalls(gameDir)).toEqual([
      {
        name: "forever",
        flavor: "forever",
        versionDir: join(gameDir, "_forever_"),
        addonsDir: join(gameDir, "_forever_", "Interface", "AddOns"),
      },
      {
        name: "era",
        flavor: "classic",
        versionDir: join(gameDir, "_classic_era_"),
        addonsDir: join(gameDir, "_classic_era_", "Interface", "AddOns"),
      },
      {
        name: "classic",
        flavor: "mists",
        versionDir: join(gameDir, "_classic_"),
        addonsDir: join(gameDir, "_classic_", "Interface", "AddOns"),
      },
      {
        name: "retail",
        flavor: "mainline",
        versionDir: join(gameDir, "_retail_"),
        addonsDir: join(gameDir, "_retail_", "Interface", "AddOns"),
      },
    ]);
  });

  test("an empty version folder or a missing game dir finds nothing", async () => {
    const gameDir = await tempDir();
    await mkdir(join(gameDir, "_forever_", "Interface", "AddOns"), { recursive: true });
    expect(await detectInstalls(gameDir)).toEqual([]);
    expect(await detectInstalls(join(gameDir, "missing"))).toEqual([]);
  });
});
