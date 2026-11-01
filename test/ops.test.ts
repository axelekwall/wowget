import { afterEach, describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addAddon, readManifest } from "../src/core/manifest.ts";
import * as ops from "../src/core/ops.ts";
import { openState, type State } from "../src/core/state.ts";
import { fakeFetch, json } from "./helpers/fetch.ts";
import { useTempDirs } from "./helpers/tmp.ts";


async function fakeVersionFolder(gameDir: string, folder: string): Promise<void> {
  await mkdir(join(gameDir, folder), { recursive: true });
  await writeFile(join(gameDir, folder, ".flavor.info"), "");
}
const text = (s: string) => new TextEncoder().encode(s);

let state: State | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  state?.close();
  state = undefined;
  server?.stop(true);
  server = undefined;
});

const tempDir = useTempDirs();

/** Serves `/MyAddon.zip` with whatever `files` currently holds, honouring If-None-Match. */
function serveAddon(files: { current: Record<string, string> }) {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname !== "/MyAddon.zip") return new Response("not found", { status: 404 });
      const zip = zipSync(Object.fromEntries(Object.entries(files.current).map(([k, v]) => [k, text(v)])), { mtime: new Date("2026-01-01T00:00:00Z") });
      const etag = `"${Bun.hash(zip).toString(16)}"`;
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
      return new Response(zip, { headers: { etag } });
    },
  });
  return `http://localhost:${server.port}`;
}

async function setup() {
  const root = await tempDir();
  state = openState(join(root, "state", "state.db"));
  const manifestPath = join(root, "config", "wowget.toml");
  const addons = join(root, "AddOns");
  const opts: ops.OpsOptions = { manifestPath, state, cacheDir: join(root, "cache"), env: {} };
  return { root, manifestPath, addons, opts };
}

describe("ops end to end", () => {
  test("init, add, list, outdated, update and remove with a URL source", async () => {
    const { manifestPath, addons, opts } = await setup();
    const files = { current: { "MyAddon/MyAddon_Forever.toc": "## Version: 1\n", "MyAddon/core.lua": "v1" } };
    const base = serveAddon(files);

    const init = await ops.init({ manifestPath, path: addons });
    expect(init).toEqual({ manifestPath, targets: [{ name: "forever", path: addons, flavor: "forever", createdAddonsDir: true }] });

    const added = await ops.add({ ...opts, source: `url:${base}/MyAddon.zip` });
    expect(added.name).toBe("MyAddon");
    expect(added.targets).toBeUndefined();
    const [row] = added.addons;
    expect(row).toMatchObject({ name: "MyAddon", target: "forever", folders: ["MyAddon"] });
    expect(await readFile(join(addons, "MyAddon", "core.lua"), "utf8")).toBe("v1");
    expect((await readManifest(manifestPath)).addons).toEqual([
      { name: "MyAddon", source: `url:${base}/MyAddon.zip`, prerelease: false },
    ]);

    expect((await ops.list(opts)).addons).toEqual([
      {
        name: "MyAddon",
        target: "forever",
        source: `url:${base}/MyAddon.zip`,
        version: row!.version,
        releaseId: row!.releaseId,
        status: "ok",
        missingFolders: [],
      },
    ]);
    expect((await ops.outdated(opts)).addons).toEqual([{ name: "MyAddon", target: "forever", status: "current", version: row!.version }]);

    files.current = { "MyAddon/MyAddon_Forever.toc": "## Version: 2\n", "MyAddon/core.lua": "v2" };
    const outdated = (await ops.outdated(opts)).addons[0]!;
    expect(outdated).toMatchObject({ name: "MyAddon", status: "outdated", installed: row!.version });

    const updated = (await ops.update(opts)).addons[0]!;
    expect(updated).toMatchObject({ name: "MyAddon", status: "updated", from: row!.version });
    expect(await readFile(join(addons, "MyAddon", "core.lua"), "utf8")).toBe("v2");
    expect((await ops.update({ ...opts, names: ["myaddon"] })).addons[0]!.status).toBe("current");

    await rm(join(addons, "MyAddon"), { recursive: true });
    expect((await ops.list(opts)).addons[0]).toMatchObject({ status: "missing", missingFolders: ["MyAddon"] });

    expect(await ops.remove({ ...opts, name: "myaddon" })).toEqual({
      name: "MyAddon",
      removedEntry: true,
      addons: [{ name: "MyAddon", target: "forever", wasInstalled: true, removedFolders: [] }],
    });
    expect((await readManifest(manifestPath)).addons).toEqual([]);
    expect((await ops.list(opts)).addons).toEqual([]);
  });

  test("a failed add writes nothing; outdated and update keep going past a broken addon", async () => {
    const { manifestPath, addons, opts } = await setup();
    const base = serveAddon({ current: { "MyAddon/MyAddon_Forever.toc": "" } });
    await ops.init({ manifestPath, path: addons });
    const before = await readFile(manifestPath, "utf8");

    const err = await ops.add({ ...opts, source: `url:${base}/Gone.zip` }).catch((e) => e);
    expect(err.code).toBe("network");
    expect(await readFile(manifestPath, "utf8")).toBe(before);
    expect(await readdir(addons)).toEqual([]);

    await addAddon(manifestPath, { name: "Gone", source: `url:${base}/Gone.zip`, prerelease: false });
    await addAddon(manifestPath, { name: "MyAddon", source: `url:${base}/MyAddon.zip`, prerelease: false });

    const outdated = (await ops.outdated(opts)).addons;
    expect(outdated.map((a) => [a.name, a.status])).toEqual([
      ["Gone", "error"],
      ["MyAddon", "not installed"],
    ]);

    const installed = (await ops.install(opts)).addons;
    expect(installed.map((a) => [a.name, a.status])).toEqual([
      ["Gone", "error"],
      ["MyAddon", "installed"],
    ]);
    expect((await ops.install(opts)).addons[1]!.status).toBe("skipped");
    expect((await ops.update(opts)).addons.map((a) => a.status)).toEqual(["error", "current"]);
  });

  test("folders deleted after install are reported by outdated and restored by update and install", async () => {
    const { manifestPath, addons, opts } = await setup();
    const base = serveAddon({ current: { "MyAddon/MyAddon_Forever.toc": "", "MyAddon/core.lua": "v1" } });
    await ops.init({ manifestPath, path: addons });
    const added = await ops.add({ ...opts, source: `url:${base}/MyAddon.zip` });

    await rm(join(addons, "MyAddon"), { recursive: true });
    expect((await ops.outdated(opts)).addons[0]).toMatchObject({ status: "missing", missingFolders: ["MyAddon"] });
    expect((await ops.update(opts)).addons[0]).toMatchObject({ status: "repaired", version: added.addons[0]!.version });
    expect(await readFile(join(addons, "MyAddon", "core.lua"), "utf8")).toBe("v1");
    expect((await ops.update(opts)).addons[0]!.status).toBe("current");

    await rm(join(addons, "MyAddon"), { recursive: true });
    expect((await ops.install(opts)).addons[0]!.status).toBe("repaired");
    expect(await readFile(join(addons, "MyAddon", "core.lua"), "utf8")).toBe("v1");
  });

  test("an addon whose folder another addon took over with --force is missing until that addon is removed", async () => {
    const { manifestPath, addons, opts } = await setup();
    const zips: Record<string, Uint8Array> = {
      "/A.zip": zipSync({ "A/A_Forever.toc": text(""), "Lib/Lib_Forever.toc": text(""), "Lib/lib.lua": text("from A") }),
      "/B.zip": zipSync({ "B/B_Forever.toc": text(""), "Lib/Lib_Forever.toc": text(""), "Lib/lib.lua": text("from B") }),
    };
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const zip = zips[new URL(req.url).pathname];
        return zip ? new Response(zip) : new Response("not found", { status: 404 });
      },
    });
    const base = `http://localhost:${server.port}`;
    await ops.init({ manifestPath, path: addons });
    await ops.add({ ...opts, source: `url:${base}/A.zip` });
    await ops.add({ ...opts, force: true, source: `url:${base}/B.zip` });
    expect(await readFile(join(addons, "Lib", "lib.lua"), "utf8")).toBe("from B");

    expect((await ops.list(opts)).addons.map((a) => [a.name, a.status, a.missingFolders])).toEqual([
      ["A", "missing", ["Lib"]],
      ["B", "ok", []],
    ]);
    expect((await ops.outdated(opts)).addons[0]).toMatchObject({ name: "A", status: "missing", missingFolders: ["Lib"] });
    const conflict = (await ops.update({ ...opts, names: ["A"] })).addons[0]!;
    expect(conflict).toMatchObject({ name: "A", status: "error" });
    expect(conflict.status === "error" && conflict.error).toContain('belongs to "b"');

    expect((await ops.remove({ ...opts, name: "B" })).addons).toEqual([
      { name: "B", target: "forever", wasInstalled: true, removedFolders: ["B", "Lib"] },
    ]);
    expect(await readdir(addons)).toEqual(["A"]);

    expect((await ops.update({ ...opts, names: ["A"] })).addons[0]).toMatchObject({ name: "A", status: "repaired" });
    expect(await readFile(join(addons, "Lib", "lib.lua"), "utf8")).toBe("from A");
    expect((await ops.list(opts)).addons[0]).toMatchObject({ name: "A", status: "ok" });
  });

  test("a GitHub release without a build for the flavor is a per-addon error", async () => {
    const { manifestPath, addons, opts } = await setup();
    const dl = "https://github.com/Example/Classic/releases/download/v1.0.0";
    const fake = fakeFetch({
      "https://api.github.com/repos/Example/Classic/releases?per_page=30": () =>
        json([
          {
            tag_name: "v1.0.0",
            draft: false,
            prerelease: false,
            assets: [
              { name: "Classic.zip", browser_download_url: `${dl}/Classic.zip` },
              { name: "release.json", browser_download_url: `${dl}/release.json` },
            ],
          },
        ]),
      [`${dl}/release.json`]: () => json({ releases: [{ filename: "Classic.zip", nolib: false, metadata: [{ flavor: "classic" }] }] }),
    });
    await ops.init({ manifestPath, path: addons });
    await addAddon(manifestPath, { name: "Classic", source: "github:Example/Classic", prerelease: false });
    const withFetch = { ...opts, fetch: fake.fetch };

    for (const result of [await ops.outdated(withFetch), await ops.update(withFetch), await ops.install(withFetch)]) {
      expect(result.addons).toEqual([
        {
          name: "Classic",
          target: "forever",
          status: "error",
          error: 'Example/Classic v1.0.0 has no build for flavor "forever" (release.json lists: classic).',
        },
      ]);
    }
    expect(fake.requests.some((r) => r.url.endsWith(".zip"))).toBe(false);
  });

  test("add rejects an entry the manifest would not accept before any download", async () => {
    const { manifestPath, addons, opts } = await setup();
    await ops.init({ manifestPath, path: addons });
    const before = await readFile(manifestPath, "utf8");
    const fake = fakeFetch({});
    const source = "url:https://example.invalid/MyAddon.zip";

    const err = await ops.add({ ...opts, fetch: fake.fetch, source, name: "" }).catch((e) => e);
    expect(err.code).toBe("usage");
    expect((await ops.add({ ...opts, fetch: fake.fetch, source, prerelease: true }).catch((e) => e)).code).toBe("usage");
    expect(fake.requests).toEqual([]);
    expect(await readdir(addons)).toEqual([]);
    expect(await readFile(manifestPath, "utf8")).toBe(before);
  });

  test("add refuses a name that is already in the manifest, remove an unknown one", async () => {
    const { manifestPath, addons, opts } = await setup();
    await ops.init({ manifestPath, path: addons });
    await addAddon(manifestPath, { name: "MyAddon", source: "url:https://example.invalid/MyAddon.zip", prerelease: false });
    expect((await ops.add({ ...opts, source: "url:https://example.invalid/myaddon.zip" }).catch((e) => e)).code).toBe("duplicate");
    expect((await ops.remove({ ...opts, name: "Nope" }).catch((e) => e)).code).toBe("not_found");
  });
});

describe("init", () => {
  test("scans the game dir and adds a target per installed version folder", async () => {
    const root = await tempDir();
    const gameDir = join(root, "World of Warcraft");
    const manifestPath = join(root, "wowget.toml");

    // An empty version folder, and folders that are not version folders, do not count.
    await mkdir(join(gameDir, "_classic_"), { recursive: true });
    await fakeVersionFolder(gameDir, "_ptr_");
    const none = await ops.init({ manifestPath, gameDir }).catch((e) => e);
    expect(none.code).toBe("not_found");
    expect(none.message).toContain("--path");

    await fakeVersionFolder(gameDir, "_forever_");
    await fakeVersionFolder(gameDir, "_classic_era_");
    await mkdir(join(gameDir, "_classic_era_", "Interface", "AddOns"), { recursive: true });
    const result = await ops.init({ manifestPath, gameDir });
    expect(result.targets).toEqual([
      { name: "forever", flavor: "forever", path: join(gameDir, "_forever_", "Interface", "AddOns"), createdAddonsDir: true },
      { name: "era", flavor: "classic", path: join(gameDir, "_classic_era_", "Interface", "AddOns"), createdAddonsDir: false },
    ]);
    expect((await readManifest(manifestPath)).targets.map((t) => t.name)).toEqual(["forever", "era"]);
    expect((await ops.init({ manifestPath, gameDir }).catch((e) => e)).code).toBe("manifest_exists");
  });

  test("tries each candidate game dir in order, and --game-dir overrides them", async () => {
    const root = await tempDir();
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(join(first, "_forever_"), { recursive: true });
    await fakeVersionFolder(second, "_classic_era_");

    const result = await ops.init({ manifestPath: join(root, "a.toml"), gameDirs: [first, second] });
    expect(result.targets.map((t) => [t.name, t.path])).toEqual([["era", join(second, "_classic_era_", "Interface", "AddOns")]]);

    const none = await ops.init({ manifestPath: join(root, "b.toml"), gameDirs: [first, join(root, "missing")] }).catch((e) => e);
    expect(none.code).toBe("not_found");
    expect(none.message).toContain(`${first}, ${join(root, "missing")}`);

    const overridden = await ops.init({ manifestPath: join(root, "c.toml"), gameDir: first, gameDirs: [second] }).catch((e) => e);
    expect(overridden.code).toBe("not_found");
    expect((await ops.init({ manifestPath: join(root, "d.toml"), gameDirs: [] }).catch((e) => e)).code).toBe("not_found");
  });

  test("with --path adds one target named after the flavor unless named", async () => {
    const root = await tempDir();
    const result = await ops.init({ manifestPath: join(root, "a.toml"), path: join(root, "A"), flavor: "classic" });
    expect(result.targets.map((t) => [t.name, t.flavor])).toEqual([["classic", "classic"]]);
    const named = await ops.init({ manifestPath: join(root, "b.toml"), path: join(root, "B"), flavor: "classic", name: "era" });
    expect(named.targets.map((t) => t.name)).toEqual(["era"]);
    expect((await ops.init({ manifestPath: join(root, "c.toml"), flavor: "classic" }).catch((e) => e)).code).toBe("usage");
  });

  test("rejects an empty path", async () => {
    const manifestPath = join(await tempDir(), "wowget.toml");
    expect((await ops.init({ manifestPath, path: "" }).catch((e) => e)).code).toBe("usage");
    expect(await Bun.file(manifestPath).exists()).toBe(false);
  });
});

describe("targets", () => {
  /** Serves `/<Name>.zip` from `zips`, each a map of file path to contents. */
  function serveZips(zips: Record<string, Record<string, string>>) {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const files = zips[new URL(req.url).pathname.slice(1)];
        if (!files) return new Response("not found", { status: 404 });
        return new Response(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, text(v)]))));
      },
    });
    return `http://localhost:${server.port}`;
  }

  async function twoTargets() {
    const env = await setup();
    const forever = join(env.root, "forever", "AddOns");
    const era = join(env.root, "era", "AddOns");
    await ops.init({ manifestPath: env.manifestPath, path: forever });
    const added = await ops.targetAdd({ manifestPath: env.manifestPath, name: "era", path: era, flavor: "classic" });
    expect(added).toEqual({ target: { name: "era", path: era, flavor: "classic" }, createdAddonsDir: true });
    return { ...env, forever, era };
  }

  const both = { "A/A_Forever.toc": "", "A/A_Vanilla.toc": "" };

  test("add to all or some targets, list per target, and remove from one target then the last", async () => {
    const { manifestPath, opts, forever, era } = await twoTargets();
    const base = serveZips({ "A.zip": both, "B.zip": { "B/B_Vanilla.toc": "" } });

    expect((await ops.targetList(opts)).targets).toEqual([
      { name: "forever", path: forever, flavor: "forever", exists: true },
      { name: "era", path: era, flavor: "classic", exists: true },
    ]);

    const a = await ops.add({ ...opts, source: `url:${base}/A.zip` });
    expect(a.targets).toBeUndefined();
    expect(a.addons.map((r) => r.target)).toEqual(["era", "forever"]);
    const b = await ops.add({ ...opts, targets: ["era"], source: `url:${base}/B.zip` });
    expect(b.targets).toEqual(["era"]);
    expect(await readdir(forever)).toEqual(["A"]);
    expect((await readdir(era)).sort()).toEqual(["A", "B"]);
    expect((await readManifest(manifestPath)).addons.map((e) => [e.name, e.targets])).toEqual([
      ["A", undefined],
      ["B", ["era"]],
    ]);

    expect((await ops.list(opts)).addons.map((r) => [r.name, r.target, r.status])).toEqual([
      ["A", "era", "ok"],
      ["A", "forever", "ok"],
      ["B", "era", "ok"],
    ]);
    const onlyForever = await ops.list({ ...opts, targets: ["forever"] });
    expect(onlyForever.targets.map((t) => t.name)).toEqual(["forever"]);
    expect(onlyForever.addons.map((r) => [r.name, r.target])).toEqual([["A", "forever"]]);
    const unknown = await ops.list({ ...opts, targets: ["retail"] }).catch((e) => e);
    expect(unknown.code).toBe("usage");
    expect(unknown.message).toContain("forever, era");

    expect(await ops.remove({ ...opts, name: "a", targets: ["era"] })).toEqual({
      name: "A",
      removedEntry: false,
      remainingTargets: ["forever"],
      addons: [{ name: "A", target: "era", wasInstalled: true, removedFolders: ["A"] }],
    });
    expect((await readManifest(manifestPath)).addons.find((e) => e.name === "A")?.targets).toEqual(["forever"]);
    expect(await readdir(era)).toEqual(["B"]);

    const last = await ops.remove({ ...opts, name: "A", targets: ["forever"] });
    expect(last.removedEntry).toBe(true);
    expect((await readManifest(manifestPath)).addons.map((e) => e.name)).toEqual(["B"]);
    expect(await readdir(forever)).toEqual([]);
  });

  test("target remove uninstalls what is on it and drops addons left without targets", async () => {
    const { manifestPath, opts, forever, era } = await twoTargets();
    const base = serveZips({ "A.zip": both, "B.zip": { "B/B_Vanilla.toc": "" } });
    await ops.add({ ...opts, source: `url:${base}/A.zip` });
    await ops.add({ ...opts, targets: ["era"], source: `url:${base}/B.zip` });

    const result = await ops.targetRemove({ ...opts, name: "era" });
    expect(result).toEqual({
      name: "era",
      removedAddons: ["B"],
      addons: [
        { name: "A", target: "era", wasInstalled: true, removedFolders: ["A"] },
        { name: "B", target: "era", wasInstalled: true, removedFolders: ["B"] },
      ],
    });
    expect(await readdir(era)).toEqual([]);
    expect(await readdir(forever)).toEqual(["A"]);
    const manifest = await readManifest(manifestPath);
    expect(manifest.targets.map((t) => t.name)).toEqual(["forever"]);
    expect(manifest.addons.map((e) => e.name)).toEqual(["A"]);
    expect(opts.state.listActiveInstalls().map((r) => [r.addon, r.target])).toEqual([["a", "forever"]]);
  });

  test("add rolls back the targets it installed when a later target fails", async () => {
    const { manifestPath, opts, forever, era } = await twoTargets();
    const base = serveZips({ "C.zip": { "C/C_Vanilla.toc": "" } });
    const before = await readFile(manifestPath, "utf8");

    // Rows run in target-name order: era (classic) installs, then forever has no matching TOC.
    const err = await ops.add({ ...opts, source: `url:${base}/C.zip` }).catch((e) => e);
    expect(err.code).toBe("flavor");
    expect(err.message).toStartWith("forever: ");
    expect(await readdir(era)).toEqual([]);
    expect(await readdir(forever)).toEqual([]);
    expect(opts.state.listActiveInstalls()).toEqual([]);
    expect(await readFile(manifestPath, "utf8")).toBe(before);
  });

  test("update resolves once for targets that share a flavor", async () => {
    const env = await setup();
    const second = join(env.root, "second", "AddOns");
    await ops.init({ manifestPath: env.manifestPath, path: env.addons });
    await ops.targetAdd({ manifestPath: env.manifestPath, name: "second", path: second, flavor: "forever" });
    await addAddon(env.manifestPath, { name: "Example", source: "github:Example/Example", prerelease: false });

    const releases = "https://api.github.com/repos/Example/Example/releases?per_page=30";
    const zipUrl = "https://github.com/Example/Example/releases/download/v1/Example.zip";
    const fake = fakeFetch({
      [releases]: () =>
        json([{ tag_name: "v1", draft: false, prerelease: false, assets: [{ name: "Example.zip", browser_download_url: zipUrl }] }]),
      [zipUrl]: () => new Response(zipSync({ "Example/Example_Forever.toc": text("") })),
    });

    const result = await ops.update({ ...env.opts, fetch: fake.fetch });
    expect(result.addons.map((r) => [r.target, r.status])).toEqual([
      ["forever", "installed"],
      ["second", "installed"],
    ]);
    expect(fake.requests.filter((r) => r.url === releases)).toHaveLength(1);
    expect(fake.requests.filter((r) => r.url === zipUrl)).toHaveLength(1);
    expect(await readdir(second)).toEqual(["Example"]);
  });
});
