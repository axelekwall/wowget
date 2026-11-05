import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findStaleCacheDirs } from "../src/core/doctor.ts";
import { HttpClient } from "../src/core/http.ts";
import { readManifest } from "../src/core/manifest.ts";
import * as ops from "../src/core/ops.ts";
import { scanUnmanaged } from "../src/core/reconcile.ts";
import { findRegistryEntry, loadRegistry, parseRegistry } from "../src/core/registry.ts";
import { searchGithub, githubSearchUrl } from "../src/core/search/github-search.ts";
import { dedupe, matchTier, rankRows, type SearchRow } from "../src/core/search/index.ts";
import {
  CATALOG_MAX_AGE_MS,
  CATALOG_URL,
  catalogPath,
  decodeEntities,
  flavorsForVersions,
  loadCatalog,
  projectCatalog,
  readCachedCatalog,
} from "../src/core/search/wowi-catalog.ts";
import { openState } from "../src/core/state.ts";
import { fakeFetch, json } from "./helpers/fetch.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();
const text = (s: string) => new TextEncoder().encode(s);
const REGISTRY = "https://registry.test/addons.toml";

const REGISTRY_TEXT = `
[[addon]]
name = "Foo"
aliases = ["foo addon"]
source = "wowi:42"
flavors = ["forever", "classic"]
folders = ["Foo", "Foo_Options"]

[[addon]]
name = "Questie"
source = "github:Questie/Questie"
flavors = ["classic"]
folders = ["Questie"]

[[addon]]
name = "Foo Gone"
source = "wowi:99"
flavors = ["classic"]
folders = ["FooGone"]
disabled = "installs on no flavor (checked 2026-11-05)"
`;

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

  test("downloads once a day, keeps the copy when a refresh fails, and reports a missing copy", async () => {
    const cacheDir = await tempDir();
    let up = true;
    const fake = fakeFetch({ [CATALOG_URL]: () => (up ? json(FILELIST) : new Response("down", { status: 503 })) });
    const http = new HttpClient({ fetch: fake.fetch, env: {} });
    const now = Date.parse("2026-11-02T12:00:00Z");

    expect((await loadCatalog({ http, cacheDir, now })).entries).toHaveLength(3);
    expect(JSON.parse(await readFile(catalogPath(cacheDir), "utf8"))).toHaveLength(3);
    await loadCatalog({ http, cacheDir, now: now + CATALOG_MAX_AGE_MS - 1 });
    expect(fake.requests).toHaveLength(1);

    up = false;
    const stale = await loadCatalog({ http, cacheDir, now: now + CATALOG_MAX_AGE_MS + 3_600_000 });
    expect(stale.entries).toHaveLength(3);
    expect(stale.warning).toContain("using the copy from 25 hours ago");
    expect(fake.requests).toHaveLength(2);
    await loadCatalog({ http, cacheDir, now, refresh: true });
    expect(fake.requests).toHaveLength(3);

    const empty = await loadCatalog({ http, cacheDir: await tempDir(), now });
    expect(empty).toEqual({ entries: [], warning: expect.stringContaining("WoWInterface catalogue unavailable") });
  });
});

describe("registry loading", () => {
  test("uses the fetched file, falls back to the built-in copy, and skips the network when off", async () => {
    const served = fakeFetch({ [REGISTRY]: () => new Response(REGISTRY_TEXT, { headers: { etag: '"1"' } }) });
    const fetched = await loadRegistry(new HttpClient({ fetch: served.fetch, env: {} }), { WOWGET_REGISTRY_URL: REGISTRY });
    expect(fetched.entries.map((e) => e.name)).toEqual(["Foo", "Questie", "Foo Gone"]);
    expect(fetched.stale).toBeUndefined();

    const missing = fakeFetch({});
    const fallback = await loadRegistry(new HttpClient({ fetch: missing.fetch, env: {} }), { WOWGET_REGISTRY_URL: REGISTRY });
    expect(fallback.stale).toContain("Using the built-in addon registry");
    expect(fallback.entries.length).toBeGreaterThan(50);

    const off = await loadRegistry(new HttpClient({ fetch: missing.fetch, env: {} }), { WOWGET_REGISTRY_URL: "off" });
    expect(off.stale).toBeUndefined();
    expect(missing.requests).toHaveLength(1);
  });

  test("finds entries by normalised name or alias", () => {
    const { entries } = parseRegistry(REGISTRY_TEXT);
    expect(findRegistryEntry(entries, "FOO-ADDON")?.name).toBe("Foo");
    expect(findRegistryEntry(entries, "questie")?.source).toBe("github:Questie/Questie");
    expect(findRegistryEntry(entries, "nope")).toBeUndefined();
  });
});

describe("GitHub search", () => {
  test("maps repositories to rows with unknown flavors", async () => {
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
    const rows = await searchGithub(new HttpClient({ fetch: fake.fetch, env: {} }), "bags");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Bags", source: "github:a/Bags", origin: "github", stars: 12 });
    expect(rows[0]!.flavors.classic).toBe("unknown");
  });
});

describe("ops.search", () => {
  const routes = () => ({
    [REGISTRY]: () => new Response(REGISTRY_TEXT),
    // A WoWInterface copy of the disabled registry entry.
    [CATALOG_URL]: () =>
      json([...FILELIST, { UID: "99", UIName: "Foo Gone", UICompatibility: [{ version: "1.15.7", name: "Classic" }], UIDir: ["FooGone"] }]),
  });

  test("works without a manifest and filters on the targets' flavors when there is one", async () => {
    const root = await tempDir();
    const state = openState(join(root, "state", "state.db"));
    try {
      const fake = fakeFetch(routes());
      const base = { state, cacheDir: join(root, "cache"), fetch: fake.fetch, env: { WOWGET_REGISTRY_URL: REGISTRY } };
      const manifestPath = join(root, "wowget.toml");

      // The disabled "Foo Gone" entry is left out, and so is its WoWInterface copy.
      const all = await ops.search({ ...base, manifestPath, query: "foo" });
      expect(all.warnings).toEqual([]);
      expect(all.results.map((r) => [r.name, r.source, r.origin])).toEqual([
        ["Foo", "wowi:42", "registry"],
        ["Foo Bars", "wowi:7", "wowi"],
      ]);
      expect(all.results[1]!.flavors).toEqual({ forever: "unknown", mainline: "yes" });

      await ops.init({ manifestPath, path: join(root, "AddOns"), flavor: "classic", name: "era" });
      const era = await ops.search({ ...base, manifestPath, query: "foo" });
      expect(era.results.map((r) => r.name)).toEqual(["Foo"]);
      expect(era.results[0]!.flavors).toEqual({ classic: "yes", forever: "yes" });
      expect((await ops.search({ ...base, manifestPath, query: "foo", flavor: "mainline" })).results.map((r) => r.name)).toEqual(["Foo Bars"]);
      expect((await ops.search({ ...base, manifestPath, query: "foo", allFlavors: true })).results).toHaveLength(2);

      await expect(ops.search({ ...base, manifestPath, query: "  " })).rejects.toMatchObject({ code: "usage" });
      await expect(ops.search({ ...base, manifestPath, query: "foo", flavor: "classic", allFlavors: true })).rejects.toMatchObject({
        code: "usage",
      });
    } finally {
      state.close();
    }
  });

  test("reports a GitHub failure as a warning and keeps the other results", async () => {
    const root = await tempDir();
    const state = openState(join(root, "state", "state.db"));
    try {
      const fake = fakeFetch(routes());
      const result = await ops.search({
        manifestPath: join(root, "none.toml"),
        state,
        cacheDir: join(root, "cache"),
        fetch: fake.fetch,
        env: { WOWGET_REGISTRY_URL: REGISTRY },
        query: "questie",
        github: true,
      });
      // wowi:8 installs the same folders as the registry entry, so only the registry row is left.
      expect(result.results.map((r) => r.source)).toEqual(["github:Questie/Questie"]);
      expect(result.warnings).toEqual([expect.stringContaining("GitHub search failed")]);
    } finally {
      state.close();
    }
  });
});

describe("bare-name add", () => {
  test("installs the registry entry under its name and stores the full source", async () => {
    const root = await tempDir();
    const state = openState(join(root, "state", "state.db"));
    try {
      const manifestPath = join(root, "wowget.toml");
      await ops.init({ manifestPath, path: join(root, "AddOns") });
      const DL = "https://cdn.wowinterface.com/downloads/getfile.php?id=42";
      const fake = fakeFetch({
        [REGISTRY]: () => new Response(REGISTRY_TEXT),
        "https://api.mmoui.com/v3/game/WOW/filedetails/42.json": () =>
          json([{ UID: 42, UIName: "Foo", UIFileName: "Foo-1.0.zip", UIVersion: "1.0", UIDownload: DL }]),
        [DL]: () => new Response(zipSync({ "Foo/Foo_Forever.toc": text(""), "Foo_Options/Foo_Options_Forever.toc": text("") })),
      });
      const opts = { manifestPath, state, cacheDir: join(root, "cache"), fetch: fake.fetch, env: { WOWGET_REGISTRY_URL: REGISTRY } };

      const added = await ops.add({ ...opts, source: "foo addon" });
      expect(added).toMatchObject({ name: "Foo", source: "wowi:42", registryName: "foo addon" });
      expect((await readManifest(manifestPath)).addons).toEqual([{ name: "Foo", source: "wowi:42", prerelease: false }]);

      const miss = await ops.add({ ...opts, source: "nothing-like-it" }).catch((e) => e);
      expect(miss.code).toBe("source");
      expect(miss.message).toContain('wowget search nothing-like-it');

      const off = await ops.add({ ...opts, source: "foo gone" }).catch((e) => e);
      expect(off.code).toBe("source");
      expect(off.message).toBe(
        "Foo Gone is disabled in the addon registry: installs on no flavor (checked 2026-11-05). Give its source (wowi:99) to add it anyway.",
      );
    } finally {
      state.close();
    }
  });
});

describe("reconcile hints", () => {
  test("registry folders give a source and name; catalogue folders only give suggestions", async () => {
    const root = await tempDir();
    const state = openState(join(root, "state", "state.db"));
    try {
      const addons = join(root, "AddOns");
      for (const name of ["Foo", "Foo_Options", "FooBars", "Mystery"]) {
        await mkdir(join(addons, name), { recursive: true });
        await writeFile(join(addons, name, `${name}.toc`), "## Version: 1.0\n");
      }
      const unmanaged = await scanUnmanaged(addons, "era", state, {
        registry: parseRegistry(REGISTRY_TEXT).entries,
        catalog: projectCatalog(FILELIST),
      });
      expect(unmanaged).toEqual([
        { name: "Foo", target: "era", folders: ["Foo", "Foo_Options"], version: "1.0", source: "wowi:42" },
        { name: "FooBars", target: "era", folders: ["FooBars"], version: "1.0", source: null, suggestions: ["wowi:7"] },
        { name: "Mystery", target: "era", folders: ["Mystery"], version: "1.0", source: null },
      ]);
    } finally {
      state.close();
    }
  });
});

describe("review fixes", () => {
  test("a companion folder joins its parent's TOC source instead of taking a registry source", async () => {
    const root = await tempDir();
    const state = openState(join(root, "state", "state.db"));
    try {
      const addons = join(root, "AddOns");
      const toc = async (name: string, body: string) => {
        await mkdir(join(addons, name), { recursive: true });
        await writeFile(join(addons, name, `${name}.toc`), body);
      };
      await toc("BigWigs", "## Version: 1\n## X-WoWI-ID: 5086\n");
      for (const name of ["BigWigs_Core", "BigWigs_Options"]) await toc(name, "## Dependencies: BigWigs\n");
      const registry = parseRegistry(`
[[addon]]
name = "BigWigs"
source = "github:BigWigsMods/BigWigs"
flavors = ["classic"]
folders = ["BigWigs", "BigWigs_Core", "BigWigs_Options"]
`).entries;
      expect(await scanUnmanaged(addons, "era", state, { registry })).toEqual([
        { name: "BigWigs", target: "era", folders: ["BigWigs", "BigWigs_Core", "BigWigs_Options"], version: "1", source: "wowi:5086" },
      ]);
      // Without a TOC source the whole group takes the registry source and name.
      await writeFile(join(addons, "BigWigs", "BigWigs.toc"), "## Version: 1\n");
      const fromRegistry = await scanUnmanaged(addons, "era", state, { registry });
      expect(fromRegistry.map((a) => [a.name, a.source, a.folders.length])).toEqual([["BigWigs", "github:BigWigsMods/BigWigs", 3]]);
    } finally {
      state.close();
    }
  });

  test("reconcile reports a registry match under the registry name", async () => {
    const root = await tempDir();
    const state = openState(join(root, "state", "state.db"));
    try {
      const manifestPath = join(root, "wowget.toml");
      const addons = join(root, "AddOns");
      await ops.init({ manifestPath, path: addons });
      await mkdir(join(addons, "Foo_Options"), { recursive: true });
      await writeFile(join(addons, "Foo_Options", "Foo_Options.toc"), "## Version: 2\n");
      const fake = fakeFetch({ [REGISTRY]: () => new Response(REGISTRY_TEXT) });
      const report = await ops.reconcile({
        manifestPath,
        state,
        cacheDir: join(root, "cache"),
        fetch: fake.fetch,
        env: { WOWGET_REGISTRY_URL: REGISTRY },
      });
      expect(report.addons.map((a) => [a.name, a.status, a.source])).toEqual([["Foo", "unmanaged", "wowi:42"]]);
    } finally {
      state.close();
    }
  });

  test("bare-name add on another target extends the entry that has the same source", async () => {
    const root = await tempDir();
    const state = openState(join(root, "state", "state.db"));
    try {
      const manifestPath = join(root, "wowget.toml");
      await ops.init({ manifestPath, path: join(root, "one") });
      await ops.targetAdd({ manifestPath, name: "two", path: join(root, "two"), flavor: "forever" });
      const DL = "https://cdn.wowinterface.com/downloads/getfile.php?id=42";
      const events: string[] = [];
      const fake = fakeFetch({
        [REGISTRY]: () => new Response(REGISTRY_TEXT),
        "https://api.mmoui.com/v3/game/WOW/filedetails/42.json": () =>
          json([{ UID: 42, UIName: "Foo", UIFileName: "FooAddon-1.0.zip", UIVersion: "1.0", UIDownload: DL }]),
        [DL]: () => new Response(zipSync({ "FooAddon/FooAddon_Forever.toc": text("") })),
      });
      const opts = {
        manifestPath,
        state,
        cacheDir: join(root, "cache"),
        fetch: fake.fetch,
        env: { WOWGET_REGISTRY_URL: REGISTRY },
        onEvent: (e: { type: string }) => events.push(e.type),
      };
      await ops.add({ ...opts, source: "wowi:42", targets: ["forever"] });
      const extended = await ops.add({ ...opts, source: "foo", targets: ["two"] });
      expect(extended.name).toBe("FooAddon");
      expect((await readManifest(manifestPath)).addons).toEqual([{ name: "FooAddon", source: "wowi:42", prerelease: false }]);
      expect(events).not.toContain("registry:stale");

      const offline = { ...opts, fetch: fakeFetch({}).fetch };
      await ops.add({ ...offline, source: "questie" }).catch(() => {});
      expect(events).toContain("registry:stale");
      const slash = await ops.add({ ...offline, source: "Questie/Questie-x" }).catch((e) => e);
      expect(slash.message).toContain('Did you mean "github:Questie/Questie-x"?');
      await expect(ops.add({ ...opts, source: " " })).rejects.toMatchObject({ code: "usage" });
    } finally {
      state.close();
    }
  });

  test("a cached catalogue in another shape is ignored, and a failed save still returns the download", async () => {
    const cacheDir = await tempDir();
    await mkdir(join(cacheDir, ".catalog"), { recursive: true });
    await writeFile(catalogPath(cacheDir), JSON.stringify([{ id: "1", name: "X" }, null]));
    expect(await readCachedCatalog(cacheDir)).toEqual([]);
    const fake = fakeFetch({ [CATALOG_URL]: () => json(FILELIST) });
    const http = new HttpClient({ fetch: fake.fetch, env: {} });
    expect((await loadCatalog({ http, cacheDir })).entries).toHaveLength(3);

    const notADir = join(await tempDir(), "file");
    await writeFile(notADir, "");
    const unsaved = await loadCatalog({ http, cacheDir: notADir });
    expect(unsaved.entries).toHaveLength(3);
    expect(unsaved.warning).toContain("Could not save the WoWInterface catalogue");
  });

  test("HTML entities in WoWInterface names are decoded", () => {
    expect(decodeEntities("MountMod (new &amp; improved) &#54392;&#x41;&bogus;")).toBe(`MountMod (new & improved) ${String.fromCodePoint(54392)}A&bogus;`);
    expect(projectCatalog([{ UID: 1, UIName: "A &amp; B" }])[0]!.name).toBe("A & B");
  });

  test("a fetched registry with no readable entries falls back to the built-in copy", async () => {
    const fake = fakeFetch({ [REGISTRY]: () => new Response('[[addon]]\nname = "New"\nsource = "tukui:elvui"\n') });
    const loaded = await loadRegistry(new HttpClient({ fetch: fake.fetch, env: {} }), { WOWGET_REGISTRY_URL: REGISTRY });
    expect(loaded.stale).toContain("no addon entries this version of wowget can read");
    expect(loaded.entries.length).toBeGreaterThan(50);
  });

  test("search rejects unknown targets even with --all-flavors, and doctor skips dot directories", async () => {
    const root = await tempDir();
    const state = openState(join(root, "state", "state.db"));
    try {
      const manifestPath = join(root, "wowget.toml");
      await ops.init({ manifestPath, path: join(root, "AddOns") });
      const fake = fakeFetch({ [REGISTRY]: () => new Response(REGISTRY_TEXT), [CATALOG_URL]: () => json(FILELIST) });
      const base = { manifestPath, state, cacheDir: join(root, "cache"), fetch: fake.fetch, env: { WOWGET_REGISTRY_URL: REGISTRY } };
      await expect(ops.search({ ...base, query: "foo", targets: ["nope"], allFlavors: true })).rejects.toMatchObject({ code: "usage" });

      await mkdir(join(root, "cache", ".catalog", "sub"), { recursive: true });
      await mkdir(join(root, "cache", "someaddon", "v1"), { recursive: true });
      expect(await findStaleCacheDirs(join(root, "cache"), state)).toEqual([join(root, "cache", "someaddon", "v1")]);
    } finally {
      state.close();
    }
  });
});
