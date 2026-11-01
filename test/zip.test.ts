import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractAddons, extractZip } from "../src/core/zip.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();
const text = (s: string) => new TextEncoder().encode(s);

describe("extractAddons", () => {
  test("flat zip with two addon folders", async () => {
    const zip = zipSync({
      "Details/Details.toc": text("## Interface: 16001\n"),
      "Details/core.lua": text("-- core"),
      "Details_Streamer/Details_Streamer_Forever.toc": text(""),
      "README.md": text("readme"),
    });
    const dest = await tempDir();
    const folders = await extractAddons(zip, dest);
    expect(folders.map((f) => f.name)).toEqual(["Details", "Details_Streamer"]);
    expect(await readFile(join(dest, "Details", "core.lua"), "utf8")).toBe("-- core");
    expect(folders[0]!.path).toBe(join(dest, "Details"));
  });

  test("single wrapping directory is descended into", async () => {
    const zip = zipSync({
      "Questie-v11.2.0/": new Uint8Array(),
      "Questie-v11.2.0/Questie/Questie.toc": text(""),
      "Questie-v11.2.0/Questie/Questie.lua": text(""),
      "__MACOSX/._junk": text(""),
    });
    const dest = await tempDir();
    const folders = await extractAddons(zip, dest);
    expect(folders).toEqual([{ name: "Questie", path: join(dest, "Questie-v11.2.0", "Questie") }]);
  });

  test("zip without a matching TOC is an error", async () => {
    const zip = zipSync({ "Foo/Bar.toc": text(""), "Foo/foo.lua": text("") });
    await expect(extractAddons(zip, await tempDir())).rejects.toThrow("no addon folder");
  });

  test("path traversal is rejected before anything is written", async () => {
    const dest = await tempDir();
    for (const name of ["../evil.lua", "Foo/../../evil.lua", "/etc/evil.lua"]) {
      const zip = zipSync({ "Foo/Foo.toc": text(""), [name]: text("x") });
      await expect(extractZip(zip, dest)).rejects.toThrow(/Refusing zip entry/);
    }
    expect(await readdir(dest)).toEqual([]);
  });

  test("garbage bytes are a zip error", async () => {
    await expect(extractZip(text("not a zip"), await tempDir())).rejects.toThrow("Could not read zip");
  });
});
