import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function run(args: string[], root: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    WOWGET_STATE_DIR: join(root, "state"),
    WOWGET_CACHE_DIR: join(root, "cache"),
    WOWGET_MANIFEST: undefined,
    GITHUB_TOKEN: undefined,
  };
  const proc = Bun.spawn([process.execPath, CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("cli", () => {
  test("help, unknown commands and an empty --manifest", async () => {
    const root = await tempDir();
    const help = await run(["--help"], root);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: wowget");
    expect((await run(["frobnicate"], root)).code).toBe(2);
    expect((await run(["list", "--manifest="], root)).code).toBe(2);
  });

  test("init then list --json prints only JSON on stdout", async () => {
    const root = await tempDir();
    const manifest = `--manifest=${join(root, "wowget.toml")}`;
    expect((await run(["init", "--path", join(root, "AddOns"), manifest], root)).code).toBe(0);
    const listed = await run(["list", "--json", manifest], root);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ installPath: join(root, "AddOns"), flavor: "forever", addons: [] });
  });

  test("a missing manifest exits 1, with a JSON error under --json", async () => {
    const root = await tempDir();
    const manifest = `--manifest=${join(root, "missing.toml")}`;
    const plain = await run(["list", manifest], root);
    expect(plain.code).toBe(1);
    expect(plain.stdout).toBe("");
    expect(plain.stderr).toContain("Manifest not found");

    const json = await run(["list", "--json", manifest], root);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({
      error: { code: "not_found", message: expect.stringContaining("Manifest not found") },
    });
  });
});
