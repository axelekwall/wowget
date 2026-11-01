import { afterEach, describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProgressEvent } from "../src/core/events.ts";
import { install, uninstall } from "../src/core/installer.ts";
import type { Resolved } from "../src/core/sources/types.ts";
import { openState, type State } from "../src/core/state.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();
const text = (s: string) => new TextEncoder().encode(s);

let state: State | undefined;
afterEach(() => {
  state?.close();
  state = undefined;
});

interface Env {
  root: string;
  addons: string;
  cache: string;
  state: State;
}

async function setup(): Promise<Env> {
  const root = await tempDir();
  const addons = join(root, "AddOns");
  await mkdir(addons);
  state = openState(join(root, "state", "state.db"));
  return { root, addons, cache: join(root, "cache"), state };
}

async function localRelease(env: Env, releaseId: string, files: Record<string, string>): Promise<Resolved> {
  const zipPath = join(env.root, `${releaseId}.zip`);
  await writeFile(zipPath, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, text(v)]))));
  return {
    source: "github:Example/Details",
    releaseId,
    version: releaseId.replace(/^v/, ""),
    filename: "Details.zip",
    downloadUrl: "https://invalid.example/Details.zip",
    flavorVerified: false,
    localPath: zipPath,
  };
}

const visible = async (dir: string) => (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
const leftovers = async (dir: string) => (await readdir(dir)).filter((n) => n.startsWith(".wowget-"));

describe("install", () => {
  test("fresh install places folders, caches the zip, records state and emits events", async () => {
    const env = await setup();
    const resolved = await localRelease(env, "v1", {
      "Details/Details.toc": "## Interface: 16001\n",
      "Details/core.lua": "v1",
      "Details_Streamer/Details_Streamer_Forever.toc": "",
    });
    const events: ProgressEvent[] = [];
    const result = await install({
      addon: "Details",
      resolved,
      targetDir: env.addons,
      flavor: "forever",
      state: env.state,
      cacheDir: env.cache,
      onEvent: (e) => events.push(e),
    });

    expect(result.folders).toEqual(["Details", "Details_Streamer"]);
    expect(await visible(env.addons)).toEqual(["Details", "Details_Streamer"]);
    expect(await leftovers(env.addons)).toEqual([]);
    expect(await readFile(join(env.addons, "Details", "core.lua"), "utf8")).toBe("v1");
    expect(result.zipPath).toBe(join(env.cache, "details", "v1", "Details.zip"));
    expect(await Bun.file(result.zipPath).exists()).toBe(true);

    const active = env.state.getActiveInstall("details");
    expect(active?.releaseId).toBe("v1");
    expect(active?.version).toBe("1");
    expect(active?.sha256).toBe(result.sha256);
    expect(active?.folders).toEqual(["Details", "Details_Streamer"]);
    expect(events.map((e) => e.type)).toEqual(["download:done", "extract", "verify", "swap", "done"]);
  });

  test("update replaces folders and drops a folder the new release no longer has", async () => {
    const env = await setup();
    const opts = { addon: "Details", targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };
    await install({
      ...opts,
      resolved: await localRelease(env, "v1", {
        "Details/Details.toc": "## Interface: 16001\n",
        "Details/core.lua": "v1",
        "Details_Old/Details_Old.toc": "## Interface: 16001\n",
      }),
    });
    const result = await install({
      ...opts,
      resolved: await localRelease(env, "v2", { "Details/Details_Forever.toc": "", "Details/new.lua": "v2" }),
    });

    expect(result.removedFolders).toEqual(["Details_Old"]);
    expect(await visible(env.addons)).toEqual(["Details"]);
    expect(await readdir(join(env.addons, "Details"))).toEqual(["Details_Forever.toc", "new.lua"]);
    expect(await leftovers(env.addons)).toEqual([]);
    expect(env.state.getActiveInstall("Details")?.releaseId).toBe("v2");
    expect(env.state.listActiveInstalls()).toHaveLength(1);
  });

  test("an existing folder not owned by the addon fails without force and is replaced with it", async () => {
    const env = await setup();
    await mkdir(join(env.addons, "Details"));
    await writeFile(join(env.addons, "Details", "hand-installed.lua"), "mine");
    const resolved = await localRelease(env, "v1", { "Details/Details_Forever.toc": "" });
    const opts = { addon: "Details", resolved, targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };

    await expect(install(opts)).rejects.toThrow("is not managed by wowget");
    expect(await readdir(join(env.addons, "Details"))).toEqual(["hand-installed.lua"]);
    expect(env.state.getActiveInstall("Details")).toBeUndefined();
    expect(await leftovers(env.addons)).toEqual([]);

    await install({ ...opts, force: true });
    expect(await readdir(join(env.addons, "Details"))).toEqual(["Details_Forever.toc"]);
  });

  test("a folder owned by another addon is a conflict naming the owner", async () => {
    const env = await setup();
    const opts = { targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };
    await install({ ...opts, addon: "Details", resolved: await localRelease(env, "a", { "Shared/Shared_Forever.toc": "" }) });
    const err = await install({
      ...opts,
      addon: "Other",
      resolved: await localRelease(env, "b", { "Shared/Shared_Forever.toc": "" }),
    }).catch((e) => e);
    expect(err.code).toBe("conflict");
    expect(err.message).toContain('belongs to "details"');
  });

  test("flavor check: wrong flavor fails, unknown needs force, verified releases skip it", async () => {
    const env = await setup();
    const opts = { addon: "Details", targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };

    const classicOnly = await localRelease(env, "c", { "Details/Details_Vanilla.toc": "" });
    expect((await install({ ...opts, resolved: classicOnly }).catch((e) => e)).code).toBe("flavor");
    expect((await install({ ...opts, resolved: classicOnly, force: true }).catch((e) => e)).code).toBe("flavor");

    const unknown = await localRelease(env, "u", { "Details/Details.toc": "## Title: Details\n" });
    expect((await install({ ...opts, resolved: unknown }).catch((e) => e)).message).toContain("--force");
    expect(await visible(env.addons)).toEqual([]);
    await install({ ...opts, resolved: unknown, force: true });

    await install({ ...opts, resolved: { ...classicOnly, flavorVerified: true } });
    expect(env.state.getActiveInstall("Details")?.releaseId).toBe("c");
  });

  test("downloads from downloadUrl when there is no local file, then reuses the cache", async () => {
    const env = await setup();
    const zip = zipSync({ "Details/Details_Forever.toc": text("") });
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits++;
        return new Response(zip);
      },
    });
    try {
      const resolved: Resolved = {
        source: "url:x",
        releaseId: "r1",
        version: "r1",
        filename: "Details.zip",
        downloadUrl: `http://localhost:${server.port}/Details.zip`,
        flavorVerified: false,
      };
      const events: ProgressEvent[] = [];
      const opts = { addon: "Details", resolved, targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };
      await install({ ...opts, onEvent: (e) => events.push(e) });
      expect(events[0]?.type).toBe("download:start");
      expect(events.some((e) => e.type === "download:progress")).toBe(true);
      expect(events.find((e) => e.type === "download:done")).toMatchObject({ cached: false, bytes: zip.length });

      await install(opts);
      expect(hits).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("a failed download leaves nothing installed", async () => {
    const env = await setup();
    const resolved: Resolved = {
      source: "url:x",
      releaseId: "r1",
      version: "r1",
      filename: "Details.zip",
      downloadUrl: "https://example.invalid/Details.zip",
      flavorVerified: false,
    };
    const fetch = async () => new Response("nope", { status: 404 });
    const err = await install({ addon: "Details", resolved, targetDir: env.addons, flavor: "forever", state: env.state, cacheDir: env.cache, fetch }).catch((e) => e);
    expect(err.code).toBe("network");
    expect(await readdir(env.addons)).toEqual([]);
    expect(await readdir(join(env.cache, "details", "r1"))).toEqual([]);
  });
});

describe("uninstall", () => {
  test("removes recorded folders, tolerates missing ones and deactivates the install", async () => {
    const env = await setup();
    await install({
      addon: "Details",
      resolved: await localRelease(env, "v1", { "Details/Details_Forever.toc": "", "Details_Extra/Details_Extra_Forever.toc": "" }),
      targetDir: env.addons,
      flavor: "forever",
      state: env.state,
      cacheDir: env.cache,
    });
    await mkdir(join(env.addons, "Unrelated"));
    await rm(join(env.addons, "Details_Extra"), { recursive: true });

    const result = await uninstall({ addon: "details", targetDir: env.addons, state: env.state });
    expect(result).toEqual({ addon: "details", removedFolders: ["Details"], wasInstalled: true });
    expect(await readdir(env.addons)).toEqual(["Unrelated"]);
    expect(env.state.getActiveInstall("Details")).toBeUndefined();

    expect(await uninstall({ addon: "details", targetDir: env.addons, state: env.state })).toEqual({
      addon: "details",
      removedFolders: [],
      wasInstalled: false,
    });
  });
});
