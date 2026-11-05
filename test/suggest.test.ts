import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { join } from "node:path";
import { entryText, reportMarkdown, suggestEntries } from "../scripts/suggest-registry.ts";
import { HttpClient } from "../src/core/http.ts";
import { parseRegistry } from "../src/core/registry.ts";
import { addonsSection, parseSuggestionLines, sourceKey, suggestIssueUrl } from "../src/core/suggest.ts";
import { fakeFetch, json } from "./helpers/fetch.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();

// What GitHub renders for the issue form: a heading per field, the text field fenced.
const BODY = [
  "### Addons",
  "",
  "```text",
  "wowi:42",
  "github:Questie/Questie My Questie",
  "",
  "# a comment",
  "wowi:43 Bar Addon",
  "```",
  "",
  "### Notes",
  "",
  "_No response_",
].join("\n");

describe("suggestion lines", () => {
  test("reads the addons section of an issue form body", () => {
    expect(parseSuggestionLines(addonsSection(BODY))).toEqual([
      { source: "wowi:42" },
      { source: "github:Questie/Questie", name: "My Questie" },
      { source: "wowi:43", name: "Bar Addon" },
    ]);
  });

  test("uses the whole body when it has no addons heading", () => {
    expect(parseSuggestionLines(addonsSection("wowi:42 Foo\n"))).toEqual([{ source: "wowi:42", name: "Foo" }]);
  });

  test("the issue URL carries the lines the workflow reads back", () => {
    const url = new URL(suggestIssueUrl([{ source: "wowi:42", name: "Foo & Bar" }, { source: "github:a/b", name: "B" }]));
    expect(url.searchParams.get("template")).toBe("registry-addon.yml");
    expect(parseSuggestionLines(url.searchParams.get("addons")!)).toEqual([
      { source: "wowi:42", name: "Foo & Bar" },
      { source: "github:a/b", name: "B" },
    ]);
  });

  test("GitHub sources compare case-insensitively", () => {
    expect(sourceKey("github:Questie/Questie")).toBe(sourceKey("github:questie/QUESTIE"));
    expect(sourceKey("wowi:42")).toBe("wowi:42");
  });
});

describe("suggestEntries", () => {
  const REGISTRY = [
    "# header comment",
    "",
    "[[addon]]",
    'name = "Questie"',
    'source = "github:Questie/Questie"',
    'flavors = ["classic"]',
    'folders = ["Questie"]',
    "",
  ].join("\n");

  function details(id: number, name: string) {
    return json([{ UID: id, UIName: name, UIFileName: `${name}-1.0.zip`, UIVersion: "1.0", UIDownload: `https://dl/${id}` }]);
  }
  const zip = (folder: string, iface: string) =>
    zipSync({ [`${folder}/${folder}.toc`]: new TextEncoder().encode(`## Interface: ${iface}\n## Title: ${folder}\n`) });

  async function run(body: string) {
    const fake = fakeFetch({
      "https://api.mmoui.com/v3/game/WOW/filedetails/42.json": () => details(42, "Foo"),
      "https://dl/42": () => new Response(zip("Foo", "11507")),
      // Interface 99999 matches no flavor, so this one installs nowhere.
      "https://api.mmoui.com/v3/game/WOW/filedetails/43.json": () => details(43, "Bar"),
      "https://dl/43": () => new Response(zip("Bar", "99999")),
      // A second addon whose default name clashes with Questie.
      "https://api.mmoui.com/v3/game/WOW/filedetails/44.json": () => details(44, "Questie"),
      "https://dl/44": () => new Response(zip("QuestieTwo", "11507")),
    });
    return suggestEntries(REGISTRY, body, {
      http: new HttpClient({ fetch: fake.fetch, env: {} }),
      workDir: await tempDir(),
      fetch: fake.fetch,
    });
  }

  test("appends entries that install and reports the rest", async () => {
    const outcome = await run(
      ["wowi:42", "github:questie/questie", "url:https://x/y.zip", "wowi:42 Again", "wowi:43", "wowi:44", "nope"].join("\n"),
    );
    expect(outcome.added).toEqual([{ name: "Foo", source: "wowi:42", flavors: ["classic"], folders: ["Foo"] }]);
    expect(outcome.rejected.map((r) => [r.source, r.reason.split(" (")[0]])).toEqual([
      ["github:questie/questie", "already in the registry as Questie"],
      ["url:https://x/y.zip", "url: sources are not allowed in the registry"],
      ["wowi:42", "listed twice in the issue"],
      ["nope", expect.stringContaining("Unknown source")],
      ["wowi:43", "installs on no flavor"],
      ["wowi:44", '"questie" is already used by Questie'],
    ]);
    // Only appended: the original file is a prefix and the result is a valid registry.
    expect(outcome.text.startsWith(REGISTRY)).toBe(true);
    expect(outcome.text.endsWith(`\n\n${entryText(outcome.added[0]!)}\n`)).toBe(true);
    expect(parseRegistry(outcome.text, { strict: true }).problems).toEqual([]);
  });

  test("the report neutralises mentions and backticks from the issue", () => {
    const report = reportMarkdown({
      text: "",
      added: [],
      rejected: [{ source: "x`y", name: "@someone", reason: "bad" }],
      rateLimited: false,
    });
    expect(report).toContain("x'y");
    expect(report).not.toContain("@someone");
  });
});

describe("cli suggest", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli.ts");

  test("lists addons missing from the registry and prints the issue URL", async () => {
    const root = await tempDir();
    const manifestPath = join(root, "wowget.toml");
    await Bun.write(
      manifestPath,
      [
        "[targets.forever]",
        `path = ${JSON.stringify(join(root, "AddOns"))}`,
        'flavor = "forever"',
        "",
        "[[addon]]",
        'name = "Questie"',
        'source = "github:questie/questie"',
        "",
        "[[addon]]",
        'name = "Foo"',
        'source = "github:someone/Foo"',
        "",
        "[[addon]]",
        'name = "Zip"',
        'source = "url:https://example.com/Zip.zip"',
        "",
      ].join("\n"),
    );
    const env = {
      ...process.env,
      WOWGET_STATE_DIR: join(root, "state"),
      WOWGET_CACHE_DIR: join(root, "cache"),
      WOWGET_REGISTRY_URL: "off",
    };
    const spawn = async (args: string[]) => {
      const proc = Bun.spawn([process.execPath, CLI, ...args, `--manifest=${manifestPath}`], { env, stdout: "pipe", stderr: "pipe" });
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return { stdout, code };
    };

    const result = await spawn(["suggest", "--json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.addons).toEqual([
      { name: "Foo", source: "github:someone/Foo", status: "suggested" },
      { name: "Questie", source: "github:questie/questie", status: "listed", registryName: "Questie" },
      { name: "Zip", source: "url:https://example.com/Zip.zip", status: "url" },
    ]);
    expect(new URL(parsed.url).searchParams.get("addons")).toBe("github:someone/Foo Foo");

    const plain = await spawn(["suggest", "--print"]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain("https://github.com/axelekwall/wowget/issues/new?");

    const named = await spawn(["suggest", "Questie", "--json"]);
    expect(JSON.parse(named.stdout).url).toBeNull();
    expect((await spawn(["suggest", "Nope", "--print"])).code).toBe(2);
  });
});
