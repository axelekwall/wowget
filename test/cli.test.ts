import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
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
    WOWGET_REGISTRY_URL: "off",
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
    const version = await run(["--version"], root);
    expect(version.code).toBe(0);
    expect(version.stdout).toBe("wowget dev\n");
    expect((await run(["frobnicate"], root)).code).toBe(2);
    expect((await run(["list", "--manifest="], root)).code).toBe(2);
  });

  test("self-update refuses to replace a development build", async () => {
    const root = await tempDir();
    const result = await run(["self-update", "--check"], root);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("development build");
  });

  test("init then list --json prints only JSON on stdout", async () => {
    const root = await tempDir();
    const manifest = `--manifest=${join(root, "wowget.toml")}`;
    expect((await run(["init", "--path", join(root, "AddOns"), manifest], root)).code).toBe(0);
    const listed = await run(["list", "--json", manifest], root);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual({
      targets: [{ name: "forever", path: join(root, "AddOns"), flavor: "forever" }],
      addons: [],
    });
  });

  test("target add and list, and list filtered with -t", async () => {
    const root = await tempDir();
    const manifestPath = join(root, "wowget.toml");
    const manifest = `--manifest=${manifestPath}`;
    expect((await run(["init", "--path", join(root, "forever"), manifest], root)).code).toBe(0);
    const added = await run(["target", "add", "era", "--path", join(root, "era"), "--flavor", "classic", manifest], root);
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("Added target era (classic)");

    const targets = await run(["target", "list", manifest], root);
    expect(targets.code).toBe(0);
    expect(targets.stdout.split("\n")[0]).toMatch(/^TARGET\s+FLAVOR\s+PATH\s+EXISTS$/);
    expect(targets.stdout).toMatch(/era\s+classic\s+\S+era\s+yes/);

    await Bun.write(
      manifestPath,
      `${await Bun.file(manifestPath).text()}\n[[addon]]\nname = "Questie"\nsource = "github:Questie/Questie"\ntargets = ["era"]\n`,
    );
    const era = await run(["list", "-t", "era", manifest], root);
    expect(era.code).toBe(0);
    expect(era.stdout).toMatch(/^NAME\s+TARGET\s+VERSION\s+STATUS\s+SOURCE\nQuestie\s+era\s+-\s+not installed\s+github:Questie\/Questie\n$/);
    const forever = await run(["list", "--json", "--target", "forever", manifest], root);
    expect(JSON.parse(forever.stdout).addons).toEqual([]);

    expect((await run(["list", "-t", "retail", manifest], root)).code).toBe(2);
    expect((await run(["target", "list", "-t", "era", manifest], root)).code).toBe(2);
    expect((await run(["target", "frob", manifest], root)).code).toBe(2);
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

  test("unpin, reconcile, and doctor CLI commands", async () => {
    const root = await tempDir();
    const manifestPath = join(root, "wowget.toml");
    const manifest = `--manifest=${manifestPath}`;
    const addonsDir = join(root, "AddOns");
    expect((await run(["init", "--path", addonsDir, manifest], root)).code).toBe(0);

    await mkdir(join(addonsDir, "Details"), { recursive: true });
    await writeFile(
      join(addonsDir, "Details", "Details_Forever.toc"),
      "## Interface: 16001\n## Version: 1.2.3\n## X-GitHub: Tercioo/Details-Damage-Meter\n",
    );

    const rec = await run(["reconcile", manifest], root);
    expect(rec.code).toBe(0);
    expect(rec.stdout).toMatch(/Details\s+forever\s+1\.2\.3\s+unmanaged\s+github:Tercioo\/Details-Damage-Meter\s+Details/);

    await Bun.write(
      manifestPath,
      `${await Bun.file(manifestPath).text()}\n[[addon]]\nname = "Details"\nsource = "github:Tercioo/Details-Damage-Meter"\npin = "1.2.3"\n`,
    );

    const unpinned = await run(["unpin", "Details", manifest], root);
    expect(unpinned.code).toBe(0);
    expect(unpinned.stdout).toBe("Unpinned Details (was 1.2.3)\n");

    const doc = await run(["doctor", manifest], root);
    expect(doc.code).toBe(0);
    expect(doc.stdout).toContain("No issues found.");
  });
});
