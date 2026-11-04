import { afterEach, describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProgressEvent } from "../src/core/events.ts";
import { cachedZipPath, fetchToCache, install, uninstall } from "../src/core/installer.ts";
import type { Resolved } from "../src/core/sources/types.ts";
import { openState, State, type NewInstall } from "../src/core/state.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const text = (s: string) => new TextEncoder().encode(s);

let state: State | undefined;
afterEach(() => {
  state?.close();
  state = undefined;
});

const tempDir = useTempDirs();

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

function remoteRelease(downloadUrl: string, releaseId = "r1"): Resolved {
  return { source: "url:x", releaseId, version: releaseId, filename: "Details.zip", downloadUrl, flavorVerified: false };
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
      target: "forever", targetDir: env.addons,
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

    const active = env.state.getActiveInstall("forever", "details");
    expect(active?.releaseId).toBe("v1");
    expect(active?.version).toBe("1");
    expect(active?.sha256).toBe(result.sha256);
    expect(active?.folders).toEqual(["Details", "Details_Streamer"]);
    expect(events.map((e) => e.type)).toEqual(["download:done", "extract", "verify", "swap", "done"]);
  });

  test("update replaces folders and drops a folder the new release no longer has", async () => {
    const env = await setup();
    const opts = { addon: "Details", target: "forever", targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };
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
    expect((await readdir(join(env.addons, "Details"))).sort()).toEqual(["Details_Forever.toc", "new.lua"]);
    expect(await leftovers(env.addons)).toEqual([]);
    expect(env.state.getActiveInstall("forever", "Details")?.releaseId).toBe("v2");
    expect(env.state.listActiveInstalls()).toHaveLength(1);
  });

  test("an existing folder not owned by the addon fails without force and is replaced with it", async () => {
    const env = await setup();
    await mkdir(join(env.addons, "Details"));
    await writeFile(join(env.addons, "Details", "hand-installed.lua"), "mine");
    const resolved = await localRelease(env, "v1", { "Details/Details_Forever.toc": "" });
    const opts = { addon: "Details", resolved, target: "forever", targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };

    await expect(install(opts)).rejects.toThrow("is not managed by wowget");
    expect(await readdir(join(env.addons, "Details"))).toEqual(["hand-installed.lua"]);
    expect(env.state.getActiveInstall("forever", "Details")).toBeUndefined();
    expect(await leftovers(env.addons)).toEqual([]);

    await install({ ...opts, force: true });
    expect(await readdir(join(env.addons, "Details"))).toEqual(["Details_Forever.toc"]);
  });

  test("a folder owned by another addon is a conflict naming the owner", async () => {
    const env = await setup();
    const opts = { target: "forever", targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };
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
    const opts = { addon: "Details", target: "forever", targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };

    const classicOnly = await localRelease(env, "c", { "Details/Details_Vanilla.toc": "" });
    expect((await install({ ...opts, resolved: classicOnly }).catch((e) => e)).code).toBe("flavor");
    expect((await install({ ...opts, resolved: classicOnly, force: true }).catch((e) => e)).code).toBe("flavor");

    const unknown = await localRelease(env, "u", { "Details/Details.toc": "## Title: Details\n" });
    expect((await install({ ...opts, resolved: unknown }).catch((e) => e)).message).toContain("--force");
    expect(await visible(env.addons)).toEqual([]);
    await install({ ...opts, resolved: unknown, force: true });

    await install({ ...opts, resolved: { ...classicOnly, flavorVerified: true } });
    expect(env.state.getActiveInstall("forever", "Details")?.releaseId).toBe("c");
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
      const opts = { addon: "Details", resolved, target: "forever", targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };
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

  test("a folder named with a flavor word installs", async () => {
    const env = await setup();
    const resolved = await localRelease(env, "v1", { "Foo-Classic/Foo-Classic.toc": "## Interface: 16001\n" });
    const result = await install({ addon: "Foo", resolved, target: "forever", targetDir: env.addons, flavor: "forever", state: env.state, cacheDir: env.cache });
    expect(result.folders).toEqual(["Foo-Classic"]);
  });

  test("an update that changes folder casing replaces the old folder", async () => {
    const env = await setup();
    const opts = { addon: "Details", target: "forever", targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };
    await install({ ...opts, resolved: await localRelease(env, "v1", { "details/details_Forever.toc": "", "details/core.lua": "v1" }) });
    const result = await install({ ...opts, resolved: await localRelease(env, "v2", { "Details/Details_Forever.toc": "", "Details/core.lua": "v2" }) });
    expect(result.folders).toEqual(["Details"]);
    expect(await visible(env.addons)).toEqual(["Details"]);
    expect(await readFile(join(env.addons, "Details", "core.lua"), "utf8")).toBe("v2");
  });

  test("a forced takeover moves folder ownership to the new addon and marks it displaced for the old one", async () => {
    const env = await setup();
    const opts = { target: "forever", targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };
    await install({ ...opts, addon: "A", resolved: await localRelease(env, "a1", { "Shared/Shared_Forever.toc": "" }) });
    await install({ ...opts, addon: "B", force: true, resolved: await localRelease(env, "b1", { "Shared/Shared_Forever.toc": "" }) });
    expect(env.state.folderOwners("forever", "Shared")).toEqual(["b"]);
    expect(env.state.getActiveInstall("forever", "A")).toMatchObject({ folders: [], displacedFolders: ["Shared"] });

    const a2 = await localRelease(env, "a2", { "Shared/Shared_Forever.toc": "" });
    const err = await install({ ...opts, addon: "A", resolved: a2 }).catch((e) => e);
    expect(err.code).toBe("conflict");
    expect(err.message).toContain('belongs to "b"');

    expect((await uninstall({ addon: "B", target: "forever", targetDir: env.addons, state: env.state })).removedFolders).toEqual(["Shared"]);
    expect(await visible(env.addons)).toEqual([]);

    await install({ ...opts, addon: "A", resolved: a2 });
    expect(env.state.getActiveInstall("forever", "A")).toMatchObject({ folders: ["Shared"], displacedFolders: [] });
  });

  test("uninstalling the displaced addon leaves the folder to its new owner", async () => {
    const env = await setup();
    const opts = { target: "forever", targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };
    await install({ ...opts, addon: "A", resolved: await localRelease(env, "a1", { "A/A_Forever.toc": "", "Shared/Shared_Forever.toc": "" }) });
    await install({ ...opts, addon: "B", force: true, resolved: await localRelease(env, "b1", { "Shared/Shared_Forever.toc": "" }) });
    expect((await uninstall({ addon: "A", target: "forever", targetDir: env.addons, state: env.state })).removedFolders).toEqual(["A"]);
    expect(await visible(env.addons)).toEqual(["Shared"]);
  });

  test.skipIf(process.platform === "win32")("a folder that cannot be moved during the swap is a locked error and is rolled back (POSIX permissions)", async () => {
    const env = await setup();
    const opts = { addon: "Details", target: "forever", targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };
    await install({ ...opts, resolved: await localRelease(env, "v1", { "Details/Details_Forever.toc": "", "Details/core.lua": "v1" }) });
    // Moving a directory to another parent needs write permission on the directory itself.
    await chmod(join(env.addons, "Details"), 0o555);
    try {
      const err = await install({ ...opts, resolved: await localRelease(env, "v2", { "Details/Details_Forever.toc": "", "Details/core.lua": "v2" }) }).catch((e) => e);
      expect(err.code).toBe("locked");
      expect(err.message).toContain("close World of Warcraft");
      expect(await visible(env.addons)).toEqual(["Details"]);
      expect(await readFile(join(env.addons, "Details", "core.lua"), "utf8")).toBe("v1");
      expect(env.state.getActiveInstall("forever", "Details")?.releaseId).toBe("v1");
    } finally {
      await chmod(join(env.addons, "Details"), 0o755);
    }
  });

  test.skipIf(process.platform === "win32")("a folder that cannot be moved on uninstall is a locked error and nothing is removed (POSIX permissions)", async () => {
    const env = await setup();
    const opts = { addon: "Details", target: "forever", targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };
    await install({ ...opts, resolved: await localRelease(env, "v1", { "Details/Details_Forever.toc": "", "Details/a.lua": "", "Details_Extra/Details_Extra_Forever.toc": "", "Details_Extra/sub/x.lua": "" }) });
    // Details moves aside first; Details_Extra cannot, so Details must come back.
    await chmod(join(env.addons, "Details_Extra"), 0o555);
    try {
      const err = await uninstall({ addon: "Details", target: "forever", targetDir: env.addons, state: env.state }).catch((e) => e);
      expect(err.code).toBe("locked");
      expect((await readdir(env.addons)).sort()).toEqual(["Details", "Details_Extra"]);
      expect((await readdir(join(env.addons, "Details"))).sort()).toEqual(["Details_Forever.toc", "a.lua"]);
      expect(await readdir(join(env.addons, "Details_Extra", "sub"))).toEqual(["x.lua"]);
      expect(env.state.getActiveInstall("forever", "Details")?.releaseId).toBe("v1");
    } finally {
      await chmod(join(env.addons, "Details_Extra"), 0o755);
    }
  });

  test.skipIf(process.platform === "win32")("uninstalled folders that cannot be deleted are reported, not thrown (POSIX permissions)", async () => {
    const env = await setup();
    const opts = { addon: "Details", target: "forever", targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };
    await install({ ...opts, resolved: await localRelease(env, "v1", { "Details/Details_Forever.toc": "", "Details/sub/x.lua": "" }) });
    // A read-only subdirectory keeps its file from being deleted, but the folder can still move.
    await chmod(join(env.addons, "Details", "sub"), 0o555);
    let leftoverDir: string | undefined;
    try {
      const result = await uninstall({ addon: "Details", target: "forever", targetDir: env.addons, state: env.state });
      leftoverDir = result.leftoverDir;
      expect(result.removedFolders).toEqual(["Details"]);
      expect(leftoverDir).toStartWith(join(env.addons, ".wowget-old-"));
      expect(await visible(env.addons)).toEqual([]);
      expect(env.state.getActiveInstall("forever", "Details")).toBeUndefined();
    } finally {
      if (leftoverDir) await chmod(join(leftoverDir, "Details", "sub"), 0o755);
    }
  });

  test.skipIf(process.platform === "win32")("previous copies that cannot be deleted after a swap are reported, not thrown (POSIX permissions)", async () => {
    const env = await setup();
    const opts = { addon: "Details", target: "forever", targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache };
    await install({ ...opts, resolved: await localRelease(env, "v1", { "Details/Details_Forever.toc": "", "Details/locked/x.lua": "v1" }) });
    // A read-only subdirectory keeps its file from being deleted.
    await chmod(join(env.addons, "Details", "locked"), 0o555);
    let leftoverDir: string | undefined;
    try {
      const result = await install({ ...opts, resolved: await localRelease(env, "v2", { "Details/Details_Forever.toc": "" }) });
      leftoverDir = result.leftoverDir;
      expect(leftoverDir).toStartWith(join(env.addons, ".wowget-old-"));
      expect(await readFile(join(leftoverDir!, "Details", "locked", "x.lua"), "utf8")).toBe("v1");
      expect(await readdir(join(env.addons, "Details"))).toEqual(["Details_Forever.toc"]);
      expect(env.state.getActiveInstall("forever", "Details")?.releaseId).toBe("v2");
    } finally {
      if (leftoverDir) await chmod(join(leftoverDir, "Details", "locked"), 0o755);
      else await chmod(join(env.addons, "Details", "locked"), 0o755).catch(() => {});
    }
  });

  test("a non-zip download is not cached, and a corrupt cached zip is downloaded again", async () => {
    const env = await setup();
    const zip = zipSync({ "Details/Details_Forever.toc": text("") });
    let body: Uint8Array | string = "<html>rate limited</html>";
    let hits = 0;
    const fetch = async () => {
      hits++;
      return new Response(body);
    };
    const resolved = remoteRelease("https://example.invalid/Details.zip");
    const opts = { addon: "Details", resolved, target: "forever", targetDir: env.addons, flavor: "forever" as const, state: env.state, cacheDir: env.cache, fetch };
    const cached = cachedZipPath(env.cache, "Details", "r1", "Details.zip");

    // A web page in place of the zip is the server's doing, so it is a network error, not a zip one.
    expect((await install(opts).catch((e) => e)).code).toBe("network");
    expect(await readdir(join(env.cache, "details", "r1"))).toEqual([]);

    await writeFile(cached, zip.subarray(0, zip.length - 10));
    body = zip;
    await install(opts);
    expect(hits).toBe(2);
    expect(new Uint8Array(await readFile(cached))).toEqual(zip);
    expect(await visible(env.addons)).toEqual(["Details"]);
  });

  test("a connection dropped mid-body is a network error and caches nothing", async () => {
    const env = await setup();
    const server = Bun.serve({
      port: 0,
      fetch() {
        let sent = false;
        const stream = new ReadableStream({
          pull(controller) {
            if (sent) return controller.error(new Error("connection lost"));
            sent = true;
            controller.enqueue(new Uint8Array(1024));
          },
        });
        return new Response(stream, { headers: { "content-length": "100000" } });
      },
    });
    try {
      const resolved = remoteRelease(`http://localhost:${server.port}/Details.zip`);
      const err = await install({ addon: "Details", resolved, target: "forever", targetDir: env.addons, flavor: "forever", state: env.state, cacheDir: env.cache }).catch((e) => e);
      expect(err.code).toBe("network");
      expect(await readdir(join(env.cache, "details", "r1"))).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("a body shorter than its Content-Length is a network error", async () => {
    const env = await setup();
    const fetch = async () => new Response("short", { headers: { "content-length": "100" } });
    const resolved = remoteRelease("https://example.invalid/Details.zip");
    const err = await install({ addon: "Details", resolved, target: "forever", targetDir: env.addons, flavor: "forever", state: env.state, cacheDir: env.cache, fetch }).catch((e) => e);
    expect(err.code).toBe("network");
    expect(err.message).toContain("ended after 5 of 100 bytes");
  });

  test.skipIf(process.platform === "win32")("when rollback cannot restore a folder, the error names the directory holding it (POSIX permissions)", async () => {
    const env = await setup();
    const opts = { addon: "Details", target: "forever", targetDir: env.addons, flavor: "forever" as const, cacheDir: env.cache };
    await install({ ...opts, state: env.state, resolved: await localRelease(env, "v1", { "Details/Details_Forever.toc": "", "Details/core.lua": "v1" }) });

    let oldDir = "";
    class FailingState extends State {
      override recordInstall(_install: NewInstall): never {
        // A read-only holding directory makes moving the previous folder back fail.
        oldDir = join(env.addons, readdirSync(env.addons).find((n) => n.startsWith(".wowget-old-"))!);
        chmodSync(oldDir, 0o555);
        throw new Error("disk full");
      }
    }
    try {
      const err = await install({
        ...opts,
        state: new FailingState(env.state.db),
        resolved: await localRelease(env, "v2", { "Details/Details_Forever.toc": "", "Details/core.lua": "v2" }),
      }).catch((e) => e);
      expect(err.code).toBe("io");
      expect(err.message).toContain("disk full");
      expect(err.message).toContain(oldDir);
      expect(await readFile(join(oldDir, "Details", "core.lua"), "utf8")).toBe("v1");
    } finally {
      if (oldDir) await chmod(oldDir, 0o755);
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
    const err = await install({ addon: "Details", resolved, target: "forever", targetDir: env.addons, flavor: "forever", state: env.state, cacheDir: env.cache, fetch }).catch((e) => e);
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
      target: "forever", targetDir: env.addons,
      flavor: "forever",
      state: env.state,
      cacheDir: env.cache,
    });
    await mkdir(join(env.addons, "Unrelated"));
    await rm(join(env.addons, "Details_Extra"), { recursive: true });

    const result = await uninstall({ addon: "details", target: "forever", targetDir: env.addons, state: env.state });
    expect(result).toEqual({ addon: "details", removedFolders: ["Details"], wasInstalled: true });
    expect(await readdir(env.addons)).toEqual(["Unrelated"]);
    expect(env.state.getActiveInstall("forever", "Details")).toBeUndefined();

    expect(await uninstall({ addon: "details", target: "forever", targetDir: env.addons, state: env.state })).toEqual({
      addon: "details",
      removedFolders: [],
      wasInstalled: false,
    });
  });
});

describe("fetchToCache", () => {
  test("names a web page served in place of a zip, and still reports files that are not zips", async () => {
    const cacheDir = await tempDir();
    const serve = (body: string) => async () => new Response(body, { headers: { "content-type": "text/html" } });
    const page = await fetchToCache({
      addon: "Details",
      resolved: remoteRelease("https://example.test/Details.zip"),
      cacheDir,
      fetch: serve("  <html><body>Sign in to download</body></html>"),
    }).catch((e) => e);
    expect(page.message).toBe("https://example.test/Details.zip returned a web page instead of the zip Details.zip.");

    const garbage = await fetchToCache({
      addon: "Details",
      resolved: remoteRelease("https://example.test/Details.zip", "r2"),
      cacheDir,
      fetch: serve("not a zip"),
    }).catch((e) => e);
    expect(garbage.code).toBe("zip");
  });
});
