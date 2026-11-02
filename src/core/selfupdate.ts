import { createHash } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { WowgetError } from "./errors.ts";
import { HttpClient, type FetchFn } from "./http.ts";

export const REPO = "axelekwall/wowget";
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface SelfUpdateOptions {
  /** The running version, "dev" when run from source. */
  currentVersion: string;
  /** Path of the running binary. */
  execPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Only report whether a newer release exists. */
  check?: boolean;
  /** Reinstall the latest release even when it is not newer. */
  force?: boolean;
  fetch?: FetchFn;
  env?: Record<string, string | undefined>;
  /** Runs `<path> --version` and returns its output; replaced in tests. */
  probe?: (path: string) => Promise<string>;
  onDownload?: (asset: string, version: string) => void;
}

export type SelfUpdateResult =
  | { status: "current"; current: string; latest: string }
  | { status: "available"; current: string; latest: string }
  | { status: "updated"; current: string; latest: string; path: string };

interface GithubRelease {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

/** The release asset name for a platform, or undefined when no binary is published for it. */
export function assetFor(platform: string, arch: string): string | undefined {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `wowget-darwin-${arch}`;
  if (platform === "win32" && arch === "x64") return "wowget-windows-x64.exe";
  return undefined;
}

type Parsed = { core: number[]; pre?: string };

function parseVersion(v: string): Parsed | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return undefined;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] };
}

/** Compares two release versions; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new WowgetError("source", `Cannot compare versions "${a}" and "${b}".`);
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i]! - pb.core[i]!;
    if (d !== 0) return Math.sign(d);
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === undefined) return 1;
  if (pb.pre === undefined) return -1;
  return pa.pre.localeCompare(pb.pre, "en", { numeric: true }) < 0 ? -1 : 1;
}

async function defaultProbe(path: string): Promise<string> {
  const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`exited with code ${code}`);
  return out;
}

function ioError(action: string, path: string, err: unknown): WowgetError {
  const reason = err instanceof Error ? err.message : String(err);
  return new WowgetError(
    "io",
    `Could not ${action} ${path}: ${reason}. Reinstall with the install script instead: https://github.com/${REPO}#install`,
    { cause: err },
  );
}

/** Replaces the running binary with the latest GitHub release for this platform. */
export async function selfUpdate(opts: SelfUpdateOptions): Promise<SelfUpdateResult> {
  const current = opts.currentVersion;
  if (current === "dev") {
    throw new WowgetError("usage", "This is a development build run from source; self-update only replaces release binaries.");
  }
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const asset = assetFor(platform, arch);
  if (!asset) throw new WowgetError("source", `No wowget binary is published for ${platform}-${arch}.`);

  const http = new HttpClient({ fetch: opts.fetch, env: opts.env });
  const release = await http.getJson<GithubRelease>(LATEST_URL, { headers: { Accept: "application/vnd.github+json" } });
  const latest = release.tag_name.replace(/^v/, "");
  const newer = compareVersions(latest, current) > 0;
  if (!newer && !opts.force) return { status: "current", current, latest };
  if (opts.check) return { status: newer ? "available" : "current", current, latest };

  const urlOf = (name: string) => {
    const found = release.assets.find((a) => a.name === name);
    if (!found) throw new WowgetError("source", `Release ${release.tag_name} has no ${name} asset.`);
    return found.browser_download_url;
  };
  const binaryUrl = urlOf(asset);
  const sumsUrl = urlOf("SHA256SUMS.txt");

  const sums = new TextDecoder().decode(await http.getBytes(sumsUrl));
  const expected = sums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+\*?/))
    .find(([, name]) => name === asset)?.[0]
    ?.toLowerCase();
  if (!expected) throw new WowgetError("source", `SHA256SUMS.txt of ${release.tag_name} has no entry for ${asset}.`);

  opts.onDownload?.(asset, latest);
  const binary = await http.getBytes(binaryUrl);
  const actual = createHash("sha256").update(binary).digest("hex");
  if (actual !== expected) {
    throw new WowgetError("network", `Checksum mismatch for ${asset}: expected ${expected}, got ${actual}.`);
  }

  const target = opts.execPath;
  const dir = dirname(target);
  const staged = join(dir, `.${basename(target)}.new-${process.pid}`);
  try {
    await writeFile(staged, binary);
    await chmod(staged, 0o755);
  } catch (err) {
    await rm(staged, { force: true }).catch(() => {});
    throw ioError("write the new binary next to", target, err);
  }

  try {
    const reported = (await (opts.probe ?? defaultProbe)(staged)).trim();
    if (reported !== `wowget ${latest}`) throw new Error(`it reported "${reported}"`);
  } catch (err) {
    await rm(staged, { force: true }).catch(() => {});
    const reason = err instanceof Error ? err.message : String(err);
    throw new WowgetError("source", `The downloaded ${asset} did not run as wowget ${latest}: ${reason}.`, { cause: err });
  }

  if (platform === "win32") {
    // Windows cannot overwrite or delete a running executable, but it can rename it.
    // The old binary stays as <name>.old until the next self-update removes it.
    const old = `${target}.old`;
    await rm(old, { force: true }).catch(() => {});
    try {
      await rename(target, old);
    } catch (err) {
      await rm(staged, { force: true }).catch(() => {});
      throw ioError("move aside", target, err);
    }
    try {
      await rename(staged, target);
    } catch (err) {
      await rename(old, target).catch(() => {});
      await rm(staged, { force: true }).catch(() => {});
      throw ioError("replace", target, err);
    }
  } else {
    try {
      await rename(staged, target);
    } catch (err) {
      await rm(staged, { force: true }).catch(() => {});
      throw ioError("replace", target, err);
    }
  }
  return { status: "updated", current, latest, path: target };
}
