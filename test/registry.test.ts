import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkEntry } from "../scripts/check-registry.ts";
import { HttpClient } from "../src/core/http.ts";
import { normaliseName, parseRegistry } from "../src/core/registry.ts";
import { fakeFetch, json } from "./helpers/fetch.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();

const QUESTIE = `
[[addon]]
name = "Questie"
source = "github:Questie/Questie"
flavors = ["classic", "forever"]
folders = ["Questie"]
`;

describe("parseRegistry", () => {
  test("reads an entry and defaults aliases to empty", () => {
    expect(parseRegistry(QUESTIE, { strict: true })).toEqual({
      entries: [
        { name: "Questie", source: "github:Questie/Questie", flavors: ["classic", "forever"], folders: ["Questie"], aliases: [] },
      ],
      problems: [],
    });
  });

  test("strict mode reports unknown keys and invalid entries; lenient mode drops them", () => {
    const text = `${QUESTIE}
category = "quests"

[[addon]]
name = "Direct"
source = "url:https://example.com/Direct.zip"
flavors = ["classic"]
folders = ["Direct"]

[[addon]]
name = "NoFlavors"
source = "wowi:1"
flavors = ["vanilla"]
folders = []
`;
    const strict = parseRegistry(text, { strict: true });
    expect(strict.problems).toEqual([
      'addon #1 (Questie): unknown key "category"',
      "addon #2 (Direct): url: sources are not allowed in the registry",
      'addon #3 (NoFlavors): flavor "vanilla" is not one of forever, mainline, classic, bcc, wrath, cata, mists',
      "addon #3 (NoFlavors): folders must be a non-empty array of folder names",
    ]);
    expect(strict.entries.map((e) => e.name)).toEqual([]);

    const lenient = parseRegistry(text);
    expect(lenient.problems).toEqual([]);
    expect(lenient.entries.map((e) => e.name)).toEqual(["Questie"]);
  });

  test("names and aliases share one namespace after normalisation", () => {
    const text = `
[[addon]]
name = "Raider.IO"
source = "github:RaiderIO/raiderio-addon"
flavors = ["mainline"]
folders = ["RaiderIO"]

[[addon]]
name = "Other"
aliases = ["raider io"]
source = "wowi:2"
flavors = ["mainline"]
folders = ["Other"]
`;
    const { entries, problems } = parseRegistry(text, { strict: true });
    expect(problems).toEqual(['addon #2 (Other): "raiderio" is already used by Raider.IO']);
    expect(entries.map((e) => e.name)).toEqual(["Raider.IO"]);
  });

  test("normaliseName keeps only letters and digits", () => {
    expect(normaliseName("WIM (WoW Instant Messenger)")).toBe("wimwowinstantmessenger");
    expect(normaliseName("Prat-3.0")).toBe("prat30");
  });

  test("the shipped registry passes strict validation", async () => {
    const text = await readFile(join(import.meta.dir, "..", "registry", "addons.toml"), "utf8");
    const { entries, problems } = parseRegistry(text, { strict: true });
    expect(problems).toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
  });
});

describe("checkEntry", () => {
  const API = "https://api.mmoui.com/v3/game/WOW/filedetails/42.json";
  const DL = "https://cdn.wowinterface.com/downloads/getfile.php?id=42";
  const zip = zipSync({
    "Foo/Foo.toc": new TextEncoder().encode("## Interface: 11507\n## Title: Foo\n"),
    "Foo/Foo.lua": new TextEncoder().encode("-- foo\n"),
  });

  function deps(workDir: string) {
    const fake = fakeFetch({
      [API]: () => json([{ UID: 42, UIName: "Foo", UIFileName: "Foo-1.0.zip", UIVersion: "1.0", UIDownload: DL }]),
      [DL]: () => new Response(zip),
    });
    return { http: new HttpClient({ fetch: fake.fetch, env: {} }), workDir, fetch: fake.fetch };
  }

  test("passes when the listed flavors and folders match what installs", async () => {
    const report = await checkEntry(
      { name: "Foo", source: "wowi:42", flavors: ["classic"], folders: ["Foo"], aliases: [] },
      deps(await tempDir()),
    );
    expect(report.supported).toEqual(["classic"]);
    expect(report.folders).toEqual(["Foo"]);
    expect(report.mismatches).toEqual([]);
  });

  test("reports listed flavors that do not install and folders that differ", async () => {
    const report = await checkEntry(
      { name: "Foo", source: "wowi:42", flavors: ["classic", "mainline"], folders: ["Foo", "Foo_Options"], aliases: [] },
      deps(await tempDir()),
    );
    expect(report.mismatches).toEqual([
      'lists mainline, which does not install: Foo: TOC support is "no"',
      'lists folders ["Foo","Foo_Options"], installs ["Foo"]',
    ]);
  });
});
