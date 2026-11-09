import { describe, expect, test } from "bun:test";
import { chmod, lstat, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WowgetError } from "../src/core/errors.ts";
import {
  addAddon,
  addTarget,
  createManifest,
  parseManifest,
  readManifest,
  removeAddon,
  removeTarget,
  setAddonPin,
  setAddonTargets,
} from "../src/core/manifest.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const tempDir = useTempDirs();

const VALID = `# My addons
[targets.forever]
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
  test("parses targets and addons with defaults", () => {
    const m = parseManifest(VALID);
    expect(m.targets).toEqual([{ name: "forever", path: "/tmp/AddOns", flavor: "forever" }]);
    expect(m.addons).toEqual([
      { name: "Questie", source: "github:Questie/Questie", prerelease: false },
      { name: "SomeAddon", source: "url:https://example.com/SomeAddon.zip", prerelease: true, pin: "v1.2.3" },
      { name: "Details", source: "github:Tercioo/Details-Damage-Meter", prerelease: false },
    ]);
  });

  test("a manifest without addons is valid", () => {
    expect(parseManifest(`[targets.era]\npath = "/x"\nflavor = "classic"\n`).addons).toEqual([]);
    expect(parseManifest("").targets).toEqual([]);
  });

  test("the old [install] table is rejected with a pointer to wowget init", () => {
    const err = errorOf(() => parseManifest(`[install]\npath = "/x"\nflavor = "forever"\n`));
    expect(err.code).toBe("manifest");
    expect(err.message).toContain("format changed");
    expect(err.message).toContain("wowget init");
  });

  test("addon targets must name existing targets and must not be empty", () => {
    const two = `${VALID.replace("# My addons\n", '[targets.era]\npath = "/era"\nflavor = "classic"\n\n')}\ntargets = ["era"]\n`;
    expect(parseManifest(two).addons.at(-1)).toEqual({
      name: "Details",
      source: "github:Tercioo/Details-Damage-Meter",
      prerelease: false,
      targets: ["era"],
    });
    const unknown = errorOf(() => parseManifest(two.replace('targets = ["era"]', 'targets = ["era", "retail"]')));
    expect(unknown.message).toContain("Details");
    expect(unknown.message).toContain('unknown target "retail"');
    expect(errorOf(() => parseManifest(two.replace('targets = ["era"]', "targets = []"))).message).toContain("must not be empty");
    expect(errorOf(() => parseManifest(`[targets.Era]\npath = "/x"\nflavor = "classic"\n`)).message).toContain(
      'target name "Era"',
    );
  });

  test("a target has either a path or a version folder", () => {
    expect(parseManifest(`[targets.era]\nfolder = "_classic_era_"\nflavor = "classic"\n`).targets).toEqual([
      { name: "era", folder: "_classic_era_", flavor: "classic" },
    ]);
    const both = errorOf(() => parseManifest(`[targets.era]\npath = "/x"\nfolder = "_classic_era_"\nflavor = "classic"\n`));
    expect(both.message).toContain("exactly one of path and folder");
    expect(errorOf(() => parseManifest(`[targets.era]\nflavor = "classic"\n`)).message).toContain("exactly one of path and folder");
    for (const folder of ["..", "a/b", "a\\\\b", "C:x", ""]) {
      expect(errorOf(() => parseManifest(`[targets.era]\nfolder = "${folder}"\nflavor = "classic"\n`)).code).toBe("manifest");
    }
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
    expect(errorOf(() => parseManifest(VALID.replace('flavor = "forever"', 'flavor = "retail"'))).message).toContain(
      "targets.forever.flavor",
    );
    expect(errorOf(() => parseManifest(VALID.replace("github:Questie/Questie", "curse:123"))).message).toContain(
      "github:owner/repo",
    );
  });

  test("rejects addon names that are not usable as a directory name", () => {
    for (const bad of ["..", ".", " ", " .. "]) {
      expect(errorOf(() => parseManifest(VALID.replace('name = "Questie"', `name = "${bad}"`))).message).toContain("name");
    }
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
    const path = await manifestFile(`[targets.forever]\npath = "/x"\nflavor = "forever"\n`);
    const entry = { name: 'Odd "Name" \\ here', source: "github:a/b", prerelease: true, pin: "v2" };
    const m = await addAddon(path, entry);
    expect(m.addons).toEqual([entry]);
  });

  test.skipIf(process.platform === "win32")("writes through a symlink to its target and keeps the file mode (symlinks and POSIX modes)", async () => {
    const dir = await tempDir();
    const target = join(dir, "real.toml");
    await writeFile(target, VALID);
    await chmod(target, 0o600);
    const link = join(dir, "wowget.toml");
    await symlink(target, link);

    await addAddon(link, { name: "WeakAuras", source: "github:WeakAuras/WeakAuras2", prerelease: false });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toContain('name = "WeakAuras"');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
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
[targets.forever]
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
    expect(text).toStartWith(`# My addons\n[targets.forever]\npath = "/tmp/AddOns"\nflavor = "forever"\n\n# Pinned until the next patch\n[[addon]]\nname = "SomeAddon"`);
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
    const original = `[targets.forever]\npath = "/x"\nflavor = "forever"\n\n[[addon]]\nname = "A"\nsource = "github:a/a"\n`;
    const path = await manifestFile(original);
    const m = await removeAddon(path, "A");
    expect(m.addons).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(`[targets.forever]\npath = "/x"\nflavor = "forever"\n`);
  });

  test("keeps a section that follows the removed block", async () => {
    const original = `[[addon]]\nname = "A"\nsource = "github:a/a"\n\n[[addon]]\nname = "B"\nsource = "github:b/b"\n\n[targets.forever]\npath = "/x"\nflavor = "forever"\n`;
    const path = await manifestFile(original);
    await removeAddon(path, "B");
    expect(await readFile(path, "utf8")).toBe(
      `[[addon]]\nname = "A"\nsource = "github:a/a"\n\n[targets.forever]\npath = "/x"\nflavor = "forever"\n`,
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
    const original = `[targets.forever]\npath = "/x"\nflavor = "forever"\n\n[[addon]]\nname = "A"\nsource = "github:a/a"\npin = """\n[[addon]]\nname = "B"\nsource = "github:b/b"\n[x]"""\n\n[[addon]]\nname = "B"\nsource = "github:b/b"\n`;
    const path = await manifestFile(original);
    expect(parseManifest(original).addons.map((a) => a.name)).toEqual(["A", "B"]);
    await expect(removeAddon(path, "B")).rejects.toThrow("left unchanged");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("restores the file when the splice changes a target", async () => {
    // The fake "B" block inside the target's path is spliced out, which leaves the path string open
    // until the comment in the real B block: B disappears as expected, but the path changes.
    const original = `[[addon]]\nname = "A"\nsource = "github:a/a"\n\n[targets.forever]\nflavor = "forever"\npath = """/x\n[[addon]]\nname = "B"\nsource = "github:b/b"\nz = [\n] # """\n\n[[addon]]\nname = "B"\nsource = "github:b/b"\n# """\n`;
    const path = await manifestFile(original);
    await expect(removeAddon(path, "B")).rejects.toThrow("targets did not match");
    expect(await readFile(path, "utf8")).toBe(original);
  });
});

describe("createManifest", () => {
  test("creates the file and directories, and refuses to overwrite", async () => {
    const path = join(await tempDir(), "nested", "wowget.toml");
    const targets = [
      { name: "forever", path: "/Applications/World of Warcraft/_forever_/Interface/AddOns", flavor: "forever" as const },
      { name: "era", path: "/Applications/World of Warcraft/_classic_era_/Interface/AddOns", flavor: "classic" as const },
    ];
    expect(await createManifest(path, targets)).toEqual({ targets, addons: [] });
    const err = await createManifest(path, [{ name: "x", path: "/y", flavor: "classic" }]).catch((e) => e);
    expect(err.code).toBe("manifest_exists");
  });
});

const TWO_TARGETS = `# Game installs
[targets.forever]
path = "/wow/_forever_/Interface/AddOns"
flavor = "forever"

[targets.era]
path = "/wow/_classic_era_/Interface/AddOns"
flavor = "classic"

# Quest helper
[[addon]]
name = "Questie"
source = "github:Questie/Questie"
targets = ["forever", "era"]
pin = "v1"

[[addon]]
name = "EraOnly"
source = "github:a/era-only"
targets = [
  "era",
]

[[addon]]
name = "Everywhere"
source = "github:a/everywhere"
`;

describe("addTarget", () => {
  test("inserts the table before the first addon block and its introducing comment", async () => {
    const path = await manifestFile(TWO_TARGETS);
    const m = await addTarget(path, "retail", { path: "/wow/_retail_/Interface/AddOns", flavor: "mainline" });
    expect(m.targets.map((t) => t.name)).toEqual(["forever", "era", "retail"]);
    expect(await readFile(path, "utf8")).toBe(
      TWO_TARGETS.replace(
        "\n\n# Quest helper",
        '\n\n[targets.retail]\npath = "/wow/_retail_/Interface/AddOns"\nflavor = "mainline"\n\n# Quest helper',
      ),
    );
  });

  test("writes a folder target", async () => {
    const path = await manifestFile("");
    const m = await addTarget(path, "retail", { folder: "_retail_", flavor: "mainline" });
    expect(m.targets).toEqual([{ name: "retail", folder: "_retail_", flavor: "mainline" }]);
    expect(await readFile(path, "utf8")).toBe('[targets.retail]\nfolder = "_retail_"\nflavor = "mainline"\n');
  });

  test("appends when there are no addons, and refuses duplicate or invalid names", async () => {
    const path = await manifestFile("");
    await addTarget(path, "era", { path: "/era", flavor: "classic" });
    await addTarget(path, "forever", { path: "/forever", flavor: "forever" });
    expect(await readFile(path, "utf8")).toBe(
      '[targets.era]\npath = "/era"\nflavor = "classic"\n\n[targets.forever]\npath = "/forever"\nflavor = "forever"\n',
    );
    expect((await addTarget(path, "era", { path: "/x", flavor: "classic" }).catch((e) => e)).code).toBe("duplicate");
    expect((await addTarget(path, "Bad Name", { path: "/x", flavor: "classic" }).catch((e) => e)).code).toBe("usage");
  });
});

describe("removeTarget", () => {
  test("removes the table, drops the name from addon lists and removes addons left without targets", async () => {
    const path = await manifestFile(TWO_TARGETS);
    const { manifest, removedAddons } = await removeTarget(path, "era");
    expect(removedAddons).toEqual(["EraOnly"]);
    expect(manifest.targets.map((t) => t.name)).toEqual(["forever"]);
    expect(manifest.addons.map((a) => [a.name, a.targets])).toEqual([
      ["Questie", ["forever"]],
      ["Everywhere", undefined],
    ]);
    expect(await readFile(path, "utf8")).toBe(`# Game installs
[targets.forever]
path = "/wow/_forever_/Interface/AddOns"
flavor = "forever"

# Quest helper
[[addon]]
name = "Questie"
source = "github:Questie/Questie"
targets = ["forever"]
pin = "v1"

[[addon]]
name = "Everywhere"
source = "github:a/everywhere"
`);
  });

  test("an unknown target throws and leaves the file untouched", async () => {
    const path = await manifestFile(TWO_TARGETS);
    expect((await removeTarget(path, "retail").catch((e) => e)).code).toBe("not_found");
    expect(await readFile(path, "utf8")).toBe(TWO_TARGETS);
  });
});

describe("setAddonTargets", () => {
  test("inserts after source, replaces a multi-line list, and deletes the line", async () => {
    const path = await manifestFile(TWO_TARGETS);

    await setAddonTargets(path, "everywhere", ["forever"]);
    expect(await readFile(path, "utf8")).toEndWith('name = "Everywhere"\nsource = "github:a/everywhere"\ntargets = ["forever"]\n');

    const m = await setAddonTargets(path, "EraOnly", ["forever", "era"]);
    expect(m.addons.find((a) => a.name === "EraOnly")?.targets).toEqual(["forever", "era"]);
    expect(await readFile(path, "utf8")).toContain('source = "github:a/era-only"\ntargets = ["forever", "era"]\n\n[[addon]]');

    await setAddonTargets(path, "Questie", undefined);
    expect(await readFile(path, "utf8")).toContain('source = "github:Questie/Questie"\npin = "v1"\n');
    expect((await readManifest(path)).addons.find((a) => a.name === "Questie")).toEqual({
      name: "Questie",
      source: "github:Questie/Questie",
      prerelease: false,
      pin: "v1",
    });
  });

  test("an unknown target name is rejected and the file restored", async () => {
    const path = await manifestFile(TWO_TARGETS);
    await expect(setAddonTargets(path, "Questie", ["retail"])).rejects.toThrow("left unchanged");
    expect(await readFile(path, "utf8")).toBe(TWO_TARGETS);
  });

  test("skips a targets = line inside a multi-line string value", async () => {
    const original = `[targets.forever]\npath = "/x"\nflavor = "forever"\n\n[targets.era]\npath = "/y"\nflavor = "classic"\n\n[[addon]]\nname = "A"\nsource = "github:a/a"\npin = """\ntargets = ["forever"]\n"""\n`;
    const path = await manifestFile(original);
    const updated = await setAddonTargets(path, "A", ["era"]);
    expect(updated.addons[0]?.targets).toEqual(["era"]);
  });
});

describe("setAddonPin", () => {
  test("inserts, replaces and removes the pin line while keeping comments", async () => {
    const path = await manifestFile(TWO_TARGETS);

    await setAddonPin(path, "Everywhere", "v2.0.0");
    expect((await readManifest(path)).addons.find((a) => a.name === "Everywhere")?.pin).toBe("v2.0.0");
    expect(await readFile(path, "utf8")).toEndWith('name = "Everywhere"\nsource = "github:a/everywhere"\npin = "v2.0.0"\n');

    await setAddonPin(path, "Questie", "v2");
    expect((await readManifest(path)).addons.find((a) => a.name === "Questie")?.pin).toBe("v2");

    await setAddonPin(path, "Questie", undefined);
    expect((await readManifest(path)).addons.find((a) => a.name === "Questie")?.pin).toBeUndefined();
    expect(await readFile(path, "utf8")).toContain("# Quest helper\n[[addon]]\nname = \"Questie\"\nsource = \"github:Questie/Questie\"\ntargets = [\"forever\", \"era\"]\n\n[[addon]]");
  });
});
