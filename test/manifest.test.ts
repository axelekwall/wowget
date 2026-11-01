import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WowgetError } from "../src/core/errors.ts";
import { addAddon, createManifest, parseManifest, readManifest, removeAddon } from "../src/core/manifest.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();

const VALID = `# My addons
[install]
path = "/tmp/AddOns"
flavor = "forever"

[[addon]]
name = "Questie"
source = "github:Questie/Questie"

# Pinned until the next patch
[[addon]]
name = "SomeAddon"
source = "url:https://example.com/SomeAddon.zip"
prerelease = true
pin = "v1.2.3"

[[addon]]
name = "Details"
source = "github:Tercioo/Details-Damage-Meter"`;

async function manifestFile(text: string): Promise<string> {
  const path = join(await tempDir(), "wowget.toml");
  await writeFile(path, text);
  return path;
}

function errorOf(fn: () => unknown): WowgetError {
  try {
    fn();
  } catch (err) {
    if (err instanceof WowgetError) return err;
    throw err;
  }
  throw new Error("expected an error");
}

describe("parseManifest", () => {
  test("parses install and addons with defaults", () => {
    const m = parseManifest(VALID);
    expect(m.install).toEqual({ path: "/tmp/AddOns", flavor: "forever" });
    expect(m.addons).toEqual([
      { name: "Questie", source: "github:Questie/Questie", prerelease: false },
      { name: "SomeAddon", source: "url:https://example.com/SomeAddon.zip", prerelease: true, pin: "v1.2.3" },
      { name: "Details", source: "github:Tercioo/Details-Damage-Meter", prerelease: false },
    ]);
  });

  test("a manifest without addons is valid", () => {
    expect(parseManifest(`[install]\npath = "/x"\nflavor = "classic"\n`).addons).toEqual([]);
  });

  test("unknown keys are errors naming the key", () => {
    const err = errorOf(() => parseManifest(VALID.replace('pin = "v1.2.3"', 'pinned = "v1.2.3"')));
    expect(err.code).toBe("manifest");
    expect(err.message).toContain('"pinned"');
    expect(errorOf(() => parseManifest(`${VALID}\n[extra]\nx = 1\n`)).message).toContain('"extra"');
  });

  test("rejects duplicate names case-insensitively, bad flavors and bad sources", () => {
    expect(errorOf(() => parseManifest(`${VALID}\n\n[[addon]]\nname = "questie"\nsource = "github:a/b"\n`)).message).toContain(
      "duplicate",
    );
    expect(errorOf(() => parseManifest(VALID.replace('"forever"', '"retail"'))).message).toContain("install.flavor");
    expect(errorOf(() => parseManifest(VALID.replace("github:Questie/Questie", "curse:123"))).message).toContain(
      "github:owner/repo",
    );
  });
});

describe("addAddon", () => {
  test("appends a block that re-parses, writing only non-default keys", async () => {
    const path = await manifestFile(VALID);
    const m = await addAddon(path, { name: "WeakAuras", source: "github:WeakAuras/WeakAuras2", prerelease: false });
    expect(m.addons.map((a) => a.name)).toEqual(["Questie", "SomeAddon", "Details", "WeakAuras"]);
    const text = await readFile(path, "utf8");
    expect(text).toBe(`${VALID}\n\n[[addon]]\nname = "WeakAuras"\nsource = "github:WeakAuras/WeakAuras2"\n`);
    expect((await readManifest(path)).addons).toEqual(m.addons);
  });

  test("writes prerelease and pin when set, and escapes strings", async () => {
    const path = await manifestFile(`[install]\npath = "/x"\nflavor = "forever"\n`);
    const entry = { name: 'Odd "Name" \\ here', source: "github:a/b", prerelease: true, pin: "v2" };
    const m = await addAddon(path, entry);
    expect(m.addons).toEqual([entry]);
  });

  test("duplicate name throws and leaves the file untouched", async () => {
    const path = await manifestFile(VALID);
    await expect(addAddon(path, { name: "QUESTIE", source: "github:x/y", prerelease: false })).rejects.toThrow(
      "already in the manifest",
    );
    expect(await readFile(path, "utf8")).toBe(VALID);
  });
});

describe("removeAddon", () => {
  test("removes a middle block with its introducing comment, keeping everything else", async () => {
    const path = await manifestFile(VALID);
    const m = await removeAddon(path, "someaddon");
    expect(m.addons.map((a) => a.name)).toEqual(["Questie", "Details"]);
    expect(await readFile(path, "utf8")).toBe(`# My addons
[install]
path = "/tmp/AddOns"
flavor = "forever"

[[addon]]
name = "Questie"
source = "github:Questie/Questie"

[[addon]]
name = "Details"
source = "github:Tercioo/Details-Damage-Meter"`);
  });

  test("removes the first block but keeps the comment that introduces the next one", async () => {
    const path = await manifestFile(VALID);
    await removeAddon(path, "Questie");
    const text = await readFile(path, "utf8");
    expect(text).toStartWith(`# My addons\n[install]\npath = "/tmp/AddOns"\nflavor = "forever"\n\n# Pinned until the next patch\n[[addon]]\nname = "SomeAddon"`);
    expect(parseManifest(text).addons.map((a) => a.name)).toEqual(["SomeAddon", "Details"]);
  });

  test("removes a trailing block without a final newline", async () => {
    const path = await manifestFile(VALID);
    await removeAddon(path, "Details");
    const text = await readFile(path, "utf8");
    expect(text).toEndWith(`prerelease = true\npin = "v1.2.3"`);
    expect(parseManifest(text).addons.map((a) => a.name)).toEqual(["Questie", "SomeAddon"]);
  });

  test("removes the only addon", async () => {
    const original = `[install]\npath = "/x"\nflavor = "forever"\n\n[[addon]]\nname = "A"\nsource = "github:a/a"\n`;
    const path = await manifestFile(original);
    const m = await removeAddon(path, "A");
    expect(m.addons).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(`[install]\npath = "/x"\nflavor = "forever"\n`);
  });

  test("keeps a section that follows the removed block", async () => {
    const original = `[[addon]]\nname = "A"\nsource = "github:a/a"\n\n[[addon]]\nname = "B"\nsource = "github:b/b"\n\n[install]\npath = "/x"\nflavor = "forever"\n`;
    const path = await manifestFile(original);
    await removeAddon(path, "B");
    expect(await readFile(path, "utf8")).toBe(
      `[[addon]]\nname = "A"\nsource = "github:a/a"\n\n[install]\npath = "/x"\nflavor = "forever"\n`,
    );
  });

  test("unknown name throws and leaves the file untouched", async () => {
    const path = await manifestFile(VALID);
    const err = await removeAddon(path, "Nope").catch((e) => e);
    expect(err).toBeInstanceOf(WowgetError);
    expect(err.code).toBe("not_found");
    expect(await readFile(path, "utf8")).toBe(VALID);
  });

  test("restores the file when the spliced result does not parse back to the expected set", async () => {
    // A's multi-line pin contains lines that look like a "B" block, so the line scan splices
    // inside the string; the re-parse must notice and restore the original.
    const original = `[install]\npath = "/x"\nflavor = "forever"\n\n[[addon]]\nname = "A"\nsource = "github:a/a"\npin = """\n[[addon]]\nname = "B"\nsource = "github:b/b"\n[x]"""\n\n[[addon]]\nname = "B"\nsource = "github:b/b"\n`;
    const path = await manifestFile(original);
    expect(parseManifest(original).addons.map((a) => a.name)).toEqual(["A", "B"]);
    await expect(removeAddon(path, "B")).rejects.toThrow("left unchanged");
    expect(await readFile(path, "utf8")).toBe(original);
  });
});

describe("createManifest", () => {
  test("creates the file and directories, and refuses to overwrite", async () => {
    const path = join(await tempDir(), "nested", "wowget.toml");
    const m = await createManifest(path, { path: "/Applications/World of Warcraft/_forever_/Interface/AddOns", flavor: "forever" });
    expect(m).toEqual({
      install: { path: "/Applications/World of Warcraft/_forever_/Interface/AddOns", flavor: "forever" },
      addons: [],
    });
    const err = await createManifest(path, { path: "/y", flavor: "classic" }).catch((e) => e);
    expect(err.code).toBe("manifest_exists");
  });
});
