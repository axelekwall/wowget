import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkEntry, disabledReason, rewriteEntry, unchangedEntries } from "../scripts/check-registry.ts";
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

  test("reads a disabled reason and rejects an empty one", () => {
    const disabled = QUESTIE.replace('folders = ["Questie"]', 'folders = ["Questie"]\ndisabled = "installs on no flavor"');
    expect(parseRegistry(disabled, { strict: true }).entries[0]!.disabled).toBe("installs on no flavor");
    const empty = QUESTIE.replace('folders = ["Questie"]', 'folders = ["Questie"]\ndisabled = ""');
    expect(parseRegistry(empty, { strict: true }).problems).toEqual([
      "addon #1 (Questie): disabled must be a non-empty one-line string",
    ]);
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

  test("a disabled entry matches while it installs nowhere and mismatches once it installs", async () => {
    const installs = await checkEntry(
      { name: "Foo", source: "wowi:42", flavors: ["mainline"], folders: ["Old"], aliases: [], disabled: "gone" },
      deps(await tempDir()),
    );
    expect(installs.mismatches).toEqual(["is disabled, but installs on classic"]);

    const missing = fakeFetch({ [API]: () => new Response("not found", { status: 404 }) });
    const nowhere = await checkEntry(
      { name: "Foo", source: "wowi:42", flavors: ["classic"], folders: ["Foo"], aliases: [], disabled: "gone" },
      { http: new HttpClient({ fetch: missing.fetch, env: {} }), workDir: await tempDir(), fetch: missing.fetch },
    );
    expect(nowhere.supported).toEqual([]);
    expect(nowhere.mismatches).toEqual([]);
    expect(disabledReason(nowhere, "2026-11-05")).toStartWith("installs on no flavor (checked 2026-11-05): ");
  });
});

describe("unchangedEntries", () => {
  test("an entry is unchanged when the base has the same check inputs under its name", () => {
    const base = `${QUESTIE}
[[addon]]
name = "Foo"
source = "wowi:42"
flavors = ["classic"]
folders = ["Foo"]
`;
    const head = `${QUESTIE.replace('flavors = ["classic", "forever"]', 'flavors = ["forever", "classic"]')}
aliases = ["quest helper"]

[[addon]]
name = "Foo"
source = "wowi:42"
flavors = ["classic", "mainline"]
folders = ["Foo"]

[[addon]]
name = "New"
source = "wowi:43"
flavors = ["classic"]
folders = ["New"]
`;
    // Questie only reordered flavors and gained an alias; Foo changed flavors; New is new.
    expect(unchangedEntries(parseRegistry(head, { strict: true }).entries, base)).toEqual(new Set(["Questie"]));
  });
});

describe("rewriteEntry", () => {
  const text = `# header
[[addon]]
name = "A"
source = "wowi:1"
flavors = ["classic"]
folders = ["A"]

# B keeps its comment
[[addon]]
name = "B"
aliases = ["bee"]
source = "wowi:2"
flavors = ["classic"] # was retail too
folders = ["B"]
`;

  test("replaces only the named entry's flavors and folders", () => {
    const out = rewriteEntry(text, "B", { flavors: ["forever", "classic"], folders: ["B", "B_Options"] });
    expect(out).toBe(
      text
        .replace('flavors = ["classic"] # was retail too', 'flavors = ["forever", "classic"]')
        .replace('folders = ["B"]', 'folders = ["B", "B_Options"]'),
    );
    expect(parseRegistry(out, { strict: true }).problems).toEqual([]);
  });

  test("sets, replaces and removes the disabled line", () => {
    const off = rewriteEntry(text, "A", { disabled: "installs on no flavor" });
    expect(off).toBe(text.replace('folders = ["A"]', 'folders = ["A"]\ndisabled = "installs on no flavor"'));
    expect(parseRegistry(off, { strict: true }).entries[0]!.disabled).toBe("installs on no flavor");
    const again = rewriteEntry(off, "A", { disabled: "still nothing" });
    expect(again).toBe(text.replace('folders = ["A"]', 'folders = ["A"]\ndisabled = "still nothing"'));
    expect(rewriteEntry(again, "A", { flavors: ["classic", "bcc"], folders: ["A"], disabled: null })).toBe(
      text.replace('flavors = ["classic"]\nfolders = ["A"]', 'flavors = ["classic", "bcc"]\nfolders = ["A"]'),
    );
  });

  test("refuses unknown names and multi-line arrays", () => {
    expect(() => rewriteEntry(text, "C", { flavors: ["classic"], folders: ["C"] })).toThrow("no [[addon]]");
    const multi = text.replace('folders = ["A"]', 'folders = [\n  "A",\n]');
    expect(() => rewriteEntry(multi, "A", { flavors: ["classic"], folders: ["A"] })).toThrow("not a one-line array");
  });
});
