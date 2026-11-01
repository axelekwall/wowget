import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { folderSupportsFlavor, parseToc, splitTocName, tocSuffixes, tocSuffixFor } from "../src/core/flavor.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();

async function addonDir(name: string, tocs: Record<string, string>): Promise<string> {
  const dir = join(await tempDir(), name);
  await mkdir(dir);
  for (const [file, text] of Object.entries(tocs)) await writeFile(join(dir, file), text);
  return dir;
}

describe("parseToc", () => {
  test("reads an interface list, title, version and typed interface fields", async () => {
    const toc = parseToc(await readFile(join(import.meta.dir, "fixtures", "Questie.toc"), "utf8"));
    expect(toc.interface).toEqual([11507, 16001, 110105]);
    expect(toc.title).toBe("|cFFFFFFFFQuestie|r");
    expect(toc.version).toBe("11.2.0");
    expect(toc.fields["Interface-Classic"]).toBe("11507");
    expect(toc.fields.SavedVariables).toBe("QuestieConfig");
  });

  test("no interface line gives an empty list", () => {
    expect(parseToc("## Title: X\n").interface).toEqual([]);
  });
});

describe("splitTocName", () => {
  test("recognises flavor suffixes with either separator", () => {
    expect(splitTocName("Questie_Forever.toc")).toEqual({ base: "Questie", suffix: "Forever" });
    expect(splitTocName("Questie-Classic.toc")).toEqual({ base: "Questie", suffix: "Classic" });
    expect(splitTocName("Details_TinyThreat.toc")).toEqual({ base: "Details_TinyThreat", suffix: "" });
  });

  test("a TOC whose whole stem is the folder name is unsuffixed", () => {
    expect(tocSuffixFor("BigWigs_Classic.toc", "BigWigs_Classic")).toBe("");
    expect(tocSuffixFor("BigWigs_Classic.toc", "BigWigs")).toBe("Classic");
    expect(tocSuffixFor("Foo-Classic_Vanilla.toc", "foo-classic")).toBe("Vanilla");
    expect(tocSuffixFor("Other.toc", "Foo")).toBeUndefined();
  });

  test("forever accepts its own suffixes before the unsuffixed TOC", () => {
    expect(tocSuffixes("forever")).toEqual(["Forever", "Camelot", "Mainline", ""]);
  });
});

describe("folderSupportsFlavor", () => {
  test("a suffixed TOC for the flavor means yes", async () => {
    const dir = await addonDir("Foo", { "Foo_Camelot.toc": "", "Foo_Vanilla.toc": "## Interface: 11507\n" });
    expect(await folderSupportsFlavor(dir, "forever")).toBe("yes");
    expect(await folderSupportsFlavor(dir, "classic")).toBe("yes");
  });

  test("an unsuffixed TOC with an interface in range means yes, out of range means no", async () => {
    const dir = await addonDir("Foo", { "Foo.toc": "## Interface: 11507, 16001\n" });
    expect(await folderSupportsFlavor(dir, "forever")).toBe("yes");
    expect(await folderSupportsFlavor(dir, "classic")).toBe("yes");
    expect(await folderSupportsFlavor(dir, "mainline")).toBe("no");
  });

  test("an unsuffixed TOC without an interface line means unknown", async () => {
    const dir = await addonDir("Foo", { "Foo.toc": "## Title: Foo\n" });
    expect(await folderSupportsFlavor(dir, "forever")).toBe("unknown");
  });

  test("only TOCs for other flavors means no", async () => {
    const dir = await addonDir("Foo", { "Foo_Vanilla.toc": "", "Foo-Wrath.toc": "" });
    expect(await folderSupportsFlavor(dir, "forever")).toBe("no");
  });

  test("a family suffix counts only by its interface list", async () => {
    const empty = await addonDir("Foo", { "Foo_Mainline.toc": "" });
    expect(await folderSupportsFlavor(empty, "forever")).toBe("unknown");
    expect(await folderSupportsFlavor(empty, "mainline")).toBe("yes");
    const retail = await addonDir("Foo", { "Foo_Mainline.toc": "## Interface: 110105\n" });
    expect(await folderSupportsFlavor(retail, "forever")).toBe("no");
    const both = await addonDir("Foo", { "Foo_Mainline.toc": "## Interface: 110105, 16001\n" });
    expect(await folderSupportsFlavor(both, "forever")).toBe("yes");
    const classic = await addonDir("Foo", { "Foo_Classic.toc": "## Interface: 11507\n" });
    expect(await folderSupportsFlavor(classic, "classic")).toBe("yes");
    expect(await folderSupportsFlavor(classic, "wrath")).toBe("no");
  });

  test("typed interface lines count like a TOC with that suffix", async () => {
    const own = await addonDir("Foo", { "Foo.toc": "## Interface: 110105\n## Interface-Forever: 16001\n" });
    expect(await folderSupportsFlavor(own, "forever")).toBe("yes");
    const family = await addonDir("Foo", { "Foo.toc": "## Interface: 110105\n## Interface-Mainline: 110105\n" });
    expect(await folderSupportsFlavor(family, "forever")).toBe("no");
  });

  test("a folder named with a suffix word uses its whole-name TOC", async () => {
    const dir = await addonDir("BigWigs_Classic", { "BigWigs_Classic.toc": "## Interface: 16001\n" });
    expect(await folderSupportsFlavor(dir, "forever")).toBe("yes");
  });
});
