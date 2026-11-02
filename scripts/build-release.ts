// Builds release binaries for every supported platform into dist/release and
// writes SHA256SUMS.txt next to them. The version comes from WOWGET_VERSION
// (a tag like "v0.1.0" or a bare version) and is compiled into `wowget --version`.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TARGETS = [
  { target: "bun-darwin-arm64", asset: "wowget-darwin-arm64" },
  { target: "bun-darwin-x64", asset: "wowget-darwin-x64" },
  { target: "bun-windows-x64", asset: "wowget-windows-x64.exe" },
];

const raw = process.env.WOWGET_VERSION;
if (!raw) {
  console.error("WOWGET_VERSION is not set (for example WOWGET_VERSION=v0.1.0).");
  process.exit(2);
}
const version = raw.replace(/^v/, "");
const only = process.argv.slice(2);
const targets = only.length ? TARGETS.filter((t) => only.includes(t.asset) || only.includes(t.target)) : TARGETS;
if (targets.length === 0) {
  console.error(`No matching targets; known: ${TARGETS.map((t) => t.asset).join(", ")}`);
  process.exit(2);
}

const outDir = join(import.meta.dir, "..", "dist", "release");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const sums: string[] = [];
for (const { target, asset } of targets) {
  const outfile = join(outDir, asset);
  console.log(`building ${asset} (${target})`);
  const proc = Bun.spawn(
    [
      process.execPath, "build", "--compile", `--target=${target}`,
      "--define", `WOWGET_VERSION=${JSON.stringify(version)}`,
      "src/cli.ts", "--outfile", outfile,
    ],
    { cwd: join(import.meta.dir, ".."), stdout: "inherit", stderr: "inherit" },
  );
  if ((await proc.exited) !== 0) {
    console.error(`build failed for ${target}`);
    process.exit(1);
  }
  const digest = createHash("sha256").update(await readFile(outfile)).digest("hex");
  sums.push(`${digest}  ${asset}`);
}
await writeFile(join(outDir, "SHA256SUMS.txt"), sums.join("\n") + "\n");
console.log(`wrote ${sums.length} binaries and SHA256SUMS.txt to ${outDir}`);
