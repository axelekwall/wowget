import { afterEach, describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { addAddon, readManifest } from "../src/core/manifest.ts";
import * as ops from "../src/core/ops.ts";
import { openState, type State } from "../src/core/state.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();
const text = (s: string) => new TextEncoder().encode(s);

let state: State | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  state?.close();
  state = undefined;
  server?.stop(true);
  server = undefined;
});

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
    expect(init).toEqual({ manifestPath, install: { path: addons, flavor: "forever" }, createdAddonsDir: true });

    const added = await ops.add({ ...opts, source: `url:${base}/MyAddon.zip` });
    expect(added.name).toBe("MyAddon");
    expect(added.folders).toEqual(["MyAddon"]);
    expect(await readFile(join(addons, "MyAddon", "core.lua"), "utf8")).toBe("v1");
    expect((await readManifest(manifestPath)).addons).toEqual([
      { name: "MyAddon", source: `url:${base}/MyAddon.zip`, prerelease: false },
    ]);

    expect((await ops.list(opts)).addons).toEqual([
      {
        name: "MyAddon",
        source: `url:${base}/MyAddon.zip`,
        version: added.version,
        releaseId: added.releaseId,
        status: "ok",
        missingFolders: [],
      },
    ]);
    expect((await ops.outdated(opts)).addons).toEqual([{ name: "MyAddon", status: "current", version: added.version }]);

    files.current = { "MyAddon/MyAddon_Forever.toc": "## Version: 2\n", "MyAddon/core.lua": "v2" };
    const outdated = (await ops.outdated(opts)).addons[0]!;
    expect(outdated).toMatchObject({ name: "MyAddon", status: "outdated", installed: added.version });

    const updated = (await ops.update(opts)).addons[0]!;
    expect(updated).toMatchObject({ name: "MyAddon", status: "updated", from: added.version });
    expect(await readFile(join(addons, "MyAddon", "core.lua"), "utf8")).toBe("v2");
    expect((await ops.update({ ...opts, names: ["myaddon"] })).addons[0]!.status).toBe("current");

    await rm(join(addons, "MyAddon"), { recursive: true });
    expect((await ops.list(opts)).addons[0]).toMatchObject({ status: "missing", missingFolders: ["MyAddon"] });

    expect(await ops.remove({ ...opts, name: "myaddon" })).toEqual({ name: "MyAddon", wasInstalled: true, removedFolders: [] });
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

  test("add refuses a name that is already in the manifest, remove an unknown one", async () => {
    const { manifestPath, addons, opts } = await setup();
    await ops.init({ manifestPath, path: addons });
    await addAddon(manifestPath, { name: "MyAddon", source: "url:https://example.invalid/MyAddon.zip", prerelease: false });
    expect((await ops.add({ ...opts, source: "url:https://example.invalid/myaddon.zip" }).catch((e) => e)).code).toBe("duplicate");
    expect((await ops.remove({ ...opts, name: "Nope" }).catch((e) => e)).code).toBe("not_found");
  });
});

describe("init", () => {
  test("defaults to _forever_/Interface/AddOns, creating it when the game dir exists", async () => {
    const root = await tempDir();
    const gameDir = join(root, "World of Warcraft");
    const manifestPath = join(root, "wowget.toml");

    expect((await ops.init({ manifestPath, gameDir }).catch((e) => e)).message).toContain("--path");

    await mkdir(join(gameDir, "_forever_"), { recursive: true });
    const result = await ops.init({ manifestPath, gameDir });
    expect(result.install.path).toBe(join(gameDir, "_forever_", "Interface", "AddOns"));
    expect(result.createdAddonsDir).toBe(true);
    expect((await ops.init({ manifestPath, gameDir }).catch((e) => e)).code).toBe("manifest_exists");
  });
});
