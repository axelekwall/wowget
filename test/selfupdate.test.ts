import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assetFor, compareVersions, selfUpdate, type SelfUpdateOptions } from "../src/core/selfupdate.ts";
import { fakeFetch, json } from "./helpers/fetch.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();
const LATEST = "https://api.github.com/repos/axelekwall/wowget/releases/latest";
const NEW_BINARY = new TextEncoder().encode("new wowget binary");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function release(tag: string, sums = `${sha(NEW_BINARY)}  wowget-darwin-arm64\n${"0".repeat(64)}  wowget-windows-x64.exe\n`) {
  const base = `https://github.com/axelekwall/wowget/releases/download/${tag}`;
  return fakeFetch({
    [LATEST]: () =>
      json({
        tag_name: tag,
        assets: ["wowget-darwin-arm64", "wowget-windows-x64.exe", "SHA256SUMS.txt"].map((name) => ({
          name,
          browser_download_url: `${base}/${name}`,
        })),
      }),
    [`${base}/wowget-darwin-arm64`]: () => new Response(NEW_BINARY),
    [`${base}/wowget-windows-x64.exe`]: () => new Response(NEW_BINARY),
    [`${base}/SHA256SUMS.txt`]: () => new Response(sums),
  });
}

async function setup(name = "wowget") {
  const dir = await tempDir();
  const execPath = join(dir, name);
  await writeFile(execPath, "old wowget binary");
  return { dir, execPath };
}

const base = (execPath: string, fetch: SelfUpdateOptions["fetch"]): SelfUpdateOptions => ({
  currentVersion: "0.2.0",
  execPath,
  platform: "darwin",
  arch: "arm64",
  fetch,
  env: {},
  probe: async () => "wowget 0.3.0\n",
});

describe("self-update helpers", () => {
  test("compareVersions orders releases and pre-releases", () => {
    expect(compareVersions("0.3.0", "0.2.0")).toBe(1);
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.3.0-beta.1", "0.3.0")).toBe(-1);
    expect(compareVersions("0.3.0-beta.10", "0.3.0-beta.2")).toBe(1);
  });

  test("assetFor maps the published platforms only", () => {
    expect(assetFor("darwin", "arm64")).toBe("wowget-darwin-arm64");
    expect(assetFor("darwin", "x64")).toBe("wowget-darwin-x64");
    expect(assetFor("win32", "x64")).toBe("wowget-windows-x64.exe");
    expect(assetFor("linux", "x64")).toBeUndefined();
  });
});

describe("selfUpdate", () => {
  test("a development build refuses to update", async () => {
    const { execPath } = await setup();
    const err = await selfUpdate({ ...base(execPath, release("v0.3.0").fetch), currentVersion: "dev" }).catch((e) => e);
    expect(err.code).toBe("usage");
  });

  test("reports current without downloading when the latest release is not newer", async () => {
    const { execPath } = await setup();
    const fake = release("v0.2.0");
    expect(await selfUpdate(base(execPath, fake.fetch))).toEqual({ status: "current", current: "0.2.0", latest: "0.2.0" });
    expect(fake.requests.map((r) => r.url)).toEqual([LATEST]);
  });

  test("--check reports a newer release and leaves the binary alone", async () => {
    const { execPath } = await setup();
    const fake = release("v0.3.0");
    expect(await selfUpdate({ ...base(execPath, fake.fetch), check: true })).toEqual({
      status: "available",
      current: "0.2.0",
      latest: "0.3.0",
    });
    expect(await readFile(execPath, "utf8")).toBe("old wowget binary");
    expect(fake.requests).toHaveLength(1);
  });

  test("replaces the binary with the verified download", async () => {
    const { dir, execPath } = await setup();
    const result = await selfUpdate(base(execPath, release("v0.3.0").fetch));
    expect(result).toEqual({ status: "updated", current: "0.2.0", latest: "0.3.0", path: execPath });
    expect(new Uint8Array(await readFile(execPath))).toEqual(NEW_BINARY);
    expect(await readdir(dir)).toEqual(["wowget"]);
  });

  test("a checksum mismatch or a binary that does not run keeps the old binary", async () => {
    const { dir, execPath } = await setup();
    const bad = release("v0.3.0", `${"f".repeat(64)}  wowget-darwin-arm64\n`);
    const mismatch = await selfUpdate(base(execPath, bad.fetch)).catch((e) => e);
    expect(mismatch.code).toBe("network");
    expect(mismatch.message).toContain("Checksum mismatch");

    const broken = await selfUpdate({ ...base(execPath, release("v0.3.0").fetch), probe: async () => "wowget 0.2.0" }).catch((e) => e);
    expect(broken.code).toBe("source");
    expect(broken.message).toContain('reported "wowget 0.2.0"');

    expect(await readFile(execPath, "utf8")).toBe("old wowget binary");
    expect(await readdir(dir)).toEqual(["wowget"]);
  });

  test("on Windows the running binary is moved aside and the next update removes it", async () => {
    const { dir, execPath } = await setup("wowget.exe");
    const sums = `${sha(NEW_BINARY)}  wowget-windows-x64.exe\n`;
    const opts = { ...base(execPath, release("v0.3.0", sums).fetch), platform: "win32" as const, arch: "x64" };
    await selfUpdate(opts);
    expect((await readdir(dir)).sort()).toEqual(["wowget.exe", "wowget.exe.old"]);
    expect(await readFile(`${execPath}.old`, "utf8")).toBe("old wowget binary");
    expect(new Uint8Array(await readFile(execPath))).toEqual(NEW_BINARY);

    await writeFile(execPath, "0.3.0 binary");
    await selfUpdate({ ...opts, currentVersion: "0.3.0", force: true, probe: async () => "wowget 0.3.0" });
    expect(await readFile(`${execPath}.old`, "utf8")).toBe("0.3.0 binary");
  });
});
