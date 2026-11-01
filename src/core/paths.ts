import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { WowgetError } from "./errors.ts";

type Env = Record<string, string | undefined>;
type Platform = NodeJS.Platform;

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** Joins with the separator of `platform`, so Windows paths come out right when computed elsewhere. */
function joinFor(platform: Platform, ...parts: string[]): string {
  return platform === "win32" ? win32.join(...parts) : join(...parts);
}

/** Reads `name` from `env`; on Windows variable names are case-insensitive. */
function envVar(env: Env, name: string, platform: Platform): string | undefined {
  if (env[name] || platform !== "win32") return env[name] || undefined;
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((k) => k.toUpperCase() === upper);
  return (key && env[key]) || undefined;
}

/** `%APPDATA%` or `%LOCALAPPDATA%`, falling back to their standard location under the home directory. */
function windowsAppData(env: Env, local: boolean): string {
  const fromEnv = envVar(env, local ? "LOCALAPPDATA" : "APPDATA", "win32");
  return fromEnv ?? win32.join(homedir(), "AppData", local ? "Local" : "Roaming");
}

/** An XDG base directory: `$<name>` when it is set to an absolute path, else `~/<fallback>`. */
function xdgDir(env: Env, name: string, fallback: string): string {
  const value = env[name];
  return value?.startsWith("/") ? value : join(homedir(), fallback);
}

export function manifestPath(override?: string, env: Env = process.env, platform: Platform = process.platform): string {
  if (override === "") throw new WowgetError("usage", "--manifest must not be empty.");
  const chosen = override ?? env.WOWGET_MANIFEST;
  if (chosen) return expandHome(chosen);
  if (platform === "win32") return win32.join(windowsAppData(env, false), "wowget", "wowget.toml");
  if (platform === "darwin") return join(homedir(), ".config", "wowget", "wowget.toml");
  return join(xdgDir(env, "XDG_CONFIG_HOME", ".config"), "wowget", "wowget.toml");
}

export function stateDir(env: Env = process.env, platform: Platform = process.platform): string {
  if (env.WOWGET_STATE_DIR) return expandHome(env.WOWGET_STATE_DIR);
  if (platform === "win32") return win32.join(windowsAppData(env, true), "wowget");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "wowget");
  return join(xdgDir(env, "XDG_STATE_HOME", join(".local", "state")), "wowget");
}

export function stateDbPath(env: Env = process.env, platform: Platform = process.platform): string {
  return joinFor(platform, stateDir(env, platform), "state.db");
}

export function cacheDir(env: Env = process.env, platform: Platform = process.platform): string {
  if (env.WOWGET_CACHE_DIR) return expandHome(env.WOWGET_CACHE_DIR);
  if (platform === "win32") return win32.join(windowsAppData(env, true), "wowget", "cache");
  if (platform === "darwin") return join(homedir(), "Library", "Caches", "wowget");
  return join(xdgDir(env, "XDG_CACHE_HOME", ".cache"), "wowget");
}

/** Game directories to scan for version folders, in order. `WOWGET_GAME_DIR` replaces the list. */
export function gameDirCandidates(platform: Platform = process.platform, env: Env = process.env): string[] {
  const override = env.WOWGET_GAME_DIR;
  if (override) return [expandHome(override)];
  if (platform === "darwin") return ["/Applications/World of Warcraft"];
  if (platform === "win32") {
    const roots = [envVar(env, "PROGRAMFILES(X86)", platform), envVar(env, "PROGRAMFILES", platform)];
    const dirs = roots.filter((r): r is string => !!r).map((r) => win32.join(r, "World of Warcraft"));
    return [...new Set(dirs)];
  }
  return [];
}
