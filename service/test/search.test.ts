import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { applySql, diffCatalogue, sqlValue, stagingSql } from "../scripts/lib/catalogue-sql.ts";
import { CachedHttp } from "../src/http.ts";
import { parseRegistry } from "../src/registry.ts";
import { githubSearchUrl, searchGithub } from "../src/search/github-search.ts";
import { dedupe, matchTier, rankRows, type SearchRow } from "../src/search/index.ts";
import { registryRows } from "../src/search/registry.ts";
import { catalogueCandidates, search } from "../src/search/service.ts";
import { catalogRow, decodeEntities, flavorsForVersions, projectCatalog } from "../src/search/wowi-catalog.ts";
import { fakeFetch, json } from "./helpers/fetch.ts";

const REGISTRY = {
  addon: [
    { name: "Foo", aliases: ["foo addon"], source: "wowi:42", flavors: ["forever", "classic"], folders: ["Foo", "Foo_Options"] },
    { name: "Questie", source: "github:Questie/Questie", flavors: ["classic"], folders: ["Questie"] },
    {
      name: "Foo Gone",
      source: "wowi:99",
      flavors: ["classic"],
      folders: ["FooGone"],
      disabled: "installs on no flavor (checked 2026-11-05)",
    },
  ],
};

const FILELIST = [
  {
    UID: "42",
    UIName: "Foo",
    UIDownloadMonthly: "900",
    UIDate: 1790000000000,
    UICompatibility: [{ version: "1.15.7", name: "Classic" }],
    UIDir: ["Foo", "Foo_Options"],
  },
  {
    UID: "7",
    UIName: "Foo Bars",
    UIAuthorName: "someone",
    UIDownloadMonthly: "50",
    UICompatibility: [{ version: "12.1.0", name: "Midnight" }],
    UIDir: ["FooBars"],
  },
  {
    UID: "8",
    UIName: "Questie mirror",
    UIDownloadMonthly: "5",
    UICompatibility: [{ version: "1.13.2", name: "Classic" }],
    UIDir: ["Questie"],
  },
  { UID: "bad", UIName: "No id" },
];

function row(partial: Partial<SearchRow> & Pick<SearchRow, "name" | "origin">): SearchRow {
  return { source: `wowi:${partial.name.length}`, flavors: {}, aliases: [], folders: [], ...partial };
}

/** Stages and applies an import of `filelist` against the test database, the way the import script does. */
async function importCatalogue(filelist: unknown[], previous?: unknown[]) {
  const entries = projectCatalog(filelist);
  const diff = diffCatalogue(previous ? projectCatalog(previous) : undefined, entries);
  const id = `import-${crypto.randomUUID()}`;
  await runScript(stagingSql(id, diff, entries.length, "2026-11-21T00:00:00Z"));
  await env.DB.prepare(applySql(id, "2026-11-21T00:01:00Z")).run();
  return id;
}

/** Runs a script of statements one by one; D1's exec() only takes statements on single lines. */
async function runScript(sql: string) {
  const statements = sql.split(/;\n/).map((s) => s.trim()).filter(Boolean);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
}

describe("matching and ranking", () => {
  test("match tiers: exact, prefix, substring, every word", () => {
    const r = row({ name: "Deadly Boss Mods", origin: "wowi", aliases: ["DBM"], folders: ["DBM-Core"] });
    expect(matchTier(r, "dbm")).toBe(1);
    expect(matchTier(r, "deadly")).toBe(2);
    expect(matchTier(r, "boss")).toBe(3);
    expect(matchTier(r, "mods deadly")).toBe(4);
    expect(matchTier(r, "core")).toBe(3.5);
    expect(matchTier(r, "weakauras")).toBeUndefined();
  });

  test("registry rows win over WoWInterface and GitHub copies of the same addon", () => {
    const rows = [
      row({ name: "Foo", origin: "registry", source: "wowi:42", folders: ["Foo", "Foo_Options"] }),
      row({ name: "Foo", origin: "wowi", source: "wowi:42" }),
      row({ name: "Foo copy", origin: "wowi", source: "wowi:99", folders: ["foo_options", "FOO"] }),
      row({ name: "Questie", origin: "registry", source: "github:Questie/Questie", folders: ["Questie"] }),
      row({ name: "Questie", origin: "github", source: "github:questie/questie" }),
      row({ name: "Other", origin: "wowi", source: "wowi:5", folders: ["Other"] }),
    ];
    expect(dedupe(rows).map((r) => `${r.origin}:${r.name}`)).toEqual(["registry:Foo", "registry:Questie", "wowi:Other"]);
  });

  test("sorts by tier, then origin, then registry order or popularity, and filters flavors", () => {
    const rows = [
      row({ name: "Map Pins", origin: "wowi", downloadsMonthly: 10, flavors: { mainline: "yes" } }),
      row({ name: "Mapster", origin: "wowi", downloadsMonthly: 500, flavors: { classic: "yes" } }),
      row({ name: "Map", origin: "github", source: "github:a/map", stars: 9, flavors: { classic: "unknown" } }),
      row({ name: "MapKit", origin: "registry", source: "github:a/mapkit", order: 1, flavors: { classic: "yes" } }),
      row({ name: "MapAll", origin: "registry", source: "github:a/mapall", order: 0, flavors: { classic: "yes" } }),
    ];
    expect(rankRows(rows, "map", { limit: 10 }).map((r) => r.name)).toEqual(["Map", "MapAll", "MapKit", "Mapster", "Map Pins"]);
    expect(rankRows(rows, "map", { flavors: ["classic"], limit: 3 }).map((r) => r.name)).toEqual(["Map", "MapAll", "MapKit"]);
    const described = row({ name: "Cartographer", origin: "github", source: "github:a/carto" });
    expect(rankRows([...rows, described], "map", { limit: 10 }).at(-1)?.name).toBe("Cartographer");
  });
});

describe("WoWInterface catalogue", () => {
  test("maps patch numbers to flavors and never claims Forever", () => {
    expect(flavorsForVersions(["1.15.7", "2.5.4", "3.4.3", "4.4.2", "5.5.1", "9.2.0", "12.1.0"]).sort()).toEqual(
      ["bcc", "cata", "classic", "mainline", "mists", "wrath"],
    );
    expect(flavorsForVersions(["16.0.1"])).toEqual(["mainline"]);
    expect(catalogRow(projectCatalog(FILELIST)[1]!).flavors).toEqual({ forever: "unknown", mainline: "yes" });
  });

  test("keeps entries with a numeric id and a name", () => {
    expect(projectCatalog(FILELIST).map((e) => e.id)).toEqual(["42", "7", "8"]);
    expect(projectCatalog(FILELIST)[1]).toEqual({
      id: "7",
      name: "Foo Bars",
      author: "someone",
      downloadsMonthly: 50,
      versions: ["12.1.0"],
      folders: ["FooBars"],
    });
  });

  test("HTML entities in WoWInterface names are decoded", () => {
    expect(decodeEntities("MountMod (new &amp; improved) &#54392;&#x41;&bogus;")).toBe(
      `MountMod (new & improved) ${String.fromCodePoint(54392)}A&bogus;`,
    );
    expect(projectCatalog([{ UID: 1, UIName: "A &amp; B" }])[0]!.name).toBe("A & B");
  });
});

describe("catalogue import", () => {
  test("a full import loads every entry and a later diff applies only changes", async () => {
    await importCatalogue(FILELIST);
    const names = async () =>
      (await env.DB.prepare("SELECT id, name FROM catalogue ORDER BY id").all<{ id: number; name: string }>()).results;
    expect(await names()).toEqual([
      { id: 7, name: "Foo Bars" },
      { id: 8, name: "Questie mirror" },
      { id: 42, name: "Foo" },
    ]);

    const next = [{ ...FILELIST[0], UIName: "Foo Renamed" }, FILELIST[1], { UID: "9", UIName: "New", UIDir: ["New"] }];
    const diff = diffCatalogue(projectCatalog(FILELIST), projectCatalog(next));
    expect(diff.changed.map((e) => e.id)).toEqual(["42", "9"]);
    expect(diff.removed).toEqual(["8"]);
    await importCatalogue(next, FILELIST);
    expect(await names()).toEqual([
      { id: 7, name: "Foo Bars" },
      { id: 9, name: "New" },
      { id: 42, name: "Foo Renamed" },
    ]);
    // The search index follows the table, and staging tables are emptied.
    expect((await catalogueCandidates(env.DB, "renamed")).map((e) => e.id)).toEqual(["42"]);
    expect(await catalogueCandidates(env.DB, "mirror")).toEqual([]);
    const staged = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM catalogue_staging) + (SELECT COUNT(*) FROM catalogue_staging_removed) AS n").first<{ n: number }>();
    expect(staged?.n).toBe(0);
  });

  test("a staged import changes nothing until it is applied, and a newer import abandons it", async () => {
    await importCatalogue(FILELIST);
    const entries = projectCatalog([FILELIST[1]]);
    await runScript(stagingSql("unfinished", { full: true, changed: entries, removed: [] }, 1, "2026-11-21T00:00:00Z"));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM catalogue").first<{ n: number }>())?.n).toBe(3);

    await importCatalogue(FILELIST);
    const status = await env.DB.prepare("SELECT status FROM catalogue_imports WHERE id = 'unfinished'").first<{ status: string }>();
    expect(status?.status).toBe("abandoned");
    // Applying an abandoned import does nothing.
    await env.DB.prepare(applySql("unfinished", "2026-11-21T00:02:00Z")).run();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM catalogue").first<{ n: number }>())?.n).toBe(3);
  });

  test("a repeated id keeps its first entry", async () => {
    const twice = [...FILELIST, { ...FILELIST[1], UIName: "Foo Bars again" }];
    expect(diffCatalogue(undefined, projectCatalog(twice)).changed.map((e) => e.name)).toEqual(["Foo", "Foo Bars", "Questie mirror"]);
    await importCatalogue(twice);
    expect((await env.DB.prepare("SELECT name FROM catalogue WHERE id = 7").first<{ name: string }>())?.name).toBe("Foo Bars");
  });

  test("SQL literals escape quotes and drop NUL", () => {
    expect(sqlValue("it's")).toBe("'it''s'");
    expect(sqlValue("a\0b")).toBe("'ab'");
    expect(sqlValue(undefined)).toBe("NULL");
    expect(sqlValue(5)).toBe("5");
  });
});

describe("search over the registry and the catalogue", () => {
  const registry = parseRegistry(REGISTRY, { strict: true }).entries;
  const deps = (fetch = fakeFetch({}).fetch) => ({ db: env.DB, fetch, registry });

  test("matches, de-duplicates and filters by flavor", async () => {
    // A WoWInterface copy of the disabled registry entry.
    await importCatalogue([
      ...FILELIST,
      { UID: "99", UIName: "Foo Gone", UICompatibility: [{ version: "1.15.7", name: "Classic" }], UIDir: ["FooGone"] },
    ]);
    const all = await search(deps(), { query: "foo", github: false, limit: 20 });
    expect(all.warnings).toEqual([]);
    expect(all.rows.map((r) => [r.name, r.source, r.origin])).toEqual([
      ["Foo", "wowi:42", "registry"],
      ["Foo Bars", "wowi:7", "wowi"],
    ]);
    expect(all.rows[1]).toMatchObject({ flavors: { forever: "unknown", mainline: "yes" }, downloads: 50, folders: ["FooBars"] });

    const classic = await search(deps(), { query: "foo", flavors: ["classic"], github: false, limit: 20 });
    expect(classic.rows.map((r) => r.name)).toEqual(["Foo"]);
    expect(Object.keys(classic.rows[0]!.flavors)).toEqual(["classic", "forever"]);

    // wowi:8 installs the same folders as the registry entry, so only the registry row is left.
    const questie = await search(deps(), { query: "questie", github: false, limit: 20 });
    expect(questie.rows.map((r) => r.source)).toEqual(["github:Questie/Questie"]);
  });

  test("a word matches inside a folder name, and short words still match", async () => {
    await importCatalogue(FILELIST);
    expect((await catalogueCandidates(env.DB, "bars")).map((e) => e.id)).toEqual(["7"]);
    expect((await catalogueCandidates(env.DB, "fo")).map((e) => e.id).sort()).toEqual(["42", "7"]);
    expect((await catalogueCandidates(env.DB, "foo options")).map((e) => e.id)).toEqual(["42"]);
  });

  test("every query word filters the lookup, so the cap cannot hide a row matching all of them", async () => {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
    // 600 popular rows match the first eight words but not the ninth.
    const decoys = Array.from({ length: 600 }, (_, i) => ({ UID: String(2000 + i), UIName: `${words.join(" ")} ${i}`, UIDownloadMonthly: String(1000 + i) }));
    await importCatalogue([...decoys, { UID: "9", UIName: `${words.join(" ")} india`, UIDownloadMonthly: "1" }]);
    const ids = (await catalogueCandidates(env.DB, `${words.join(" ")} india`)).map((e) => e.id);
    expect(ids).toEqual(["9"]);
  });

  test("a name longer than D1's LIKE pattern limit still matches exactly and by prefix", async () => {
    const long = "Supercalifragilistic Expialidocious Raid Frame Enhancements";
    await importCatalogue([...FILELIST, { UID: "77", UIName: long, UIDir: ["SuperRaidFrames"] }]);
    expect((await catalogueCandidates(env.DB, long)).map((e) => e.id)).toEqual(["77"]);
    expect((await catalogueCandidates(env.DB, "Supercalifragilistic Expialidocious Raid Frame")).map((e) => e.id)).toEqual(["77"]);
    const rows = await search(deps(), { query: long, github: false, limit: 5 });
    expect(rows.rows.map((r) => r.source)).toEqual(["wowi:77"]);
  });

  test("a query matching many rows keeps the exact match and the most downloaded", async () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ UID: String(1000 + i), UIName: `Xyz helper ${i}`, UIDownloadMonthly: String(i + 10) }));
    await importCatalogue([...many, { UID: "5", UIName: "Xyz", UIDownloadMonthly: "1" }]);
    const ids = (await catalogueCandidates(env.DB, "xyz")).map((e) => e.id);
    expect(ids).toHaveLength(501);
    expect(ids).toContain("5");
    expect(ids).toContain("1599");
    expect(ids).not.toContain("1000");
    const top = await search(deps(), { query: "xyz", github: false, limit: 2 });
    expect(top.rows.map((r) => r.name)).toEqual(["Xyz", "Xyz helper 599"]);
  });

  test("GitHub rows are cached for an hour and a failure is a warning", async () => {
    const url = githubSearchUrl("bags");
    const fake = fakeFetch({
      [url]: () =>
        json({
          items: [
            { full_name: "a/Bags", name: "Bags", stargazers_count: 12, pushed_at: "2026-10-01T00:00:00Z", html_url: "https://github.com/a/Bags" },
            { full_name: "not a repo" },
          ],
        }),
    });
    const first = await search(deps(fake.fetch), { query: "Bags", github: true, limit: 20 });
    expect(first.rows).toEqual([expect.objectContaining({ name: "Bags", source: "github:a/Bags", origin: "github", stars: 12 })]);
    await search(deps(fake.fetch), { query: "bags", github: true, limit: 20 });
    expect(fake.requests).toHaveLength(1);

    const failed = await search(deps(), { query: "other", github: true, limit: 20 });
    expect(failed.warnings).toEqual([expect.stringContaining("GitHub search failed")]);
  });

  test("searchGithub maps repositories to rows with unknown flavors", async () => {
    const url = githubSearchUrl("bags");
    const fake = fakeFetch({ [url]: () => json({ items: [{ full_name: "a/Bags", name: "Bags", stargazers_count: 12 }] }) });
    const rows = await searchGithub(new CachedHttp({ fetch: fake.fetch, maxAgeMs: 0 }), "bags");
    expect(rows[0]).toMatchObject({ name: "Bags", source: "github:a/Bags", origin: "github", stars: 12 });
    expect(rows[0]!.flavors.classic).toBe("unknown");
  });

  test("registry rows carry the source page and file order", () => {
    const rows = registryRows(registry);
    expect(rows.map((r) => [r.order, r.url])).toEqual([
      [0, "https://www.wowinterface.com/downloads/info42"],
      [1, "https://github.com/Questie/Questie"],
      [2, "https://www.wowinterface.com/downloads/info99"],
    ]);
    expect(rows[2]!.disabled).toBe(true);
  });
});
