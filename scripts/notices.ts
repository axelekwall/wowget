// Builds THIRD-PARTY-NOTICES.txt for the release binaries: every package the bundle includes, the
// packages those depend on (some ship prebundled copies of them), and the TUI's native libraries,
// which statically link FFmpeg (LGPL-2.1-or-later) and other code under their own licences.
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LICENCE_FILE = /^(licen[cs]e|copying|notice|patents|authors)([-._].*)?$|^ffmpeg-source\.md$/i;

interface PackageJson {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, string>;
}

/** Package names whose modules end up in a bundle of `entry`, from Bun's metafile. */
async function bundledPackages(root: string, entry: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "wowget-notices-"));
  try {
    const proc = Bun.spawn(
      [process.execPath, "build", entry, "--target=bun", "--outdir", dir, `--metafile=${join(dir, "meta.json")}`],
      { cwd: root, stdout: "ignore", stderr: "inherit" },
    );
    if ((await proc.exited) !== 0) throw new Error("bundling for the notices failed");
    const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as { inputs: Record<string, unknown> };
    const names = new Set<string>();
    for (const input of Object.keys(meta.inputs)) {
      const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input);
      if (m) names.add(m[1]!);
    }
    return [...names];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function thirdPartyNotices(root: string, entry: string, nativePackages: string[]): Promise<string> {
  const isNative = (name: string) => /^@opentui\/core-/.test(name);
  const queue = [...(await bundledPackages(root, entry)).filter((n) => !isNative(n)), ...nativePackages];
  const seen = new Set<string>();
  const printed = new Map<string, string>();
  const sections: string[] = [];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = join(root, "node_modules", name);
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as PackageJson;
    queue.push(...Object.keys(pkg.dependencies ?? {}));
    const files = (await readdir(dir)).filter((f) => LICENCE_FILE.test(f)).sort();
    if (!files.length && !pkg.license) throw new Error(`${name} has no licence file and no license field`);
    const body: string[] = [];
    if (!files.length) body.push(`License: ${pkg.license} (from package.json; the package ships no licence file)`);
    for (const file of files) {
      const text = (await readFile(join(dir, file), "utf8")).trim();
      const hash = createHash("sha256").update(text).digest("hex");
      const same = printed.get(hash);
      if (same) body.push(`--- ${file}: same text as ${same}`);
      else {
        printed.set(hash, `${name} ${file}`);
        body.push(`--- ${file}\n\n${text}`);
      }
    }
    sections.push(`=== ${pkg.name} ${pkg.version}${pkg.license ? ` (${pkg.license})` : ""}\n\n${body.join("\n\n")}`);
  }
  sections.sort();
  return `Third-party software included in the wowget release binaries.\n\n${sections.join("\n\n\n")}\n`;
}
