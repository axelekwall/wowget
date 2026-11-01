import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

export const GAME_DIR = "/Applications/World of Warcraft";

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function manifestPath(override?: string, env: Env = process.env): string {
  const chosen = override ?? env.WOWGET_MANIFEST;
  if (chosen) return expandHome(chosen);
  return join(homedir(), ".config", "wowget", "wowget.toml");
}

export function stateDir(env: Env = process.env): string {
  if (env.WOWGET_STATE_DIR) return expandHome(env.WOWGET_STATE_DIR);
  return join(homedir(), "Library", "Application Support", "wowget");
}

export function stateDbPath(env: Env = process.env): string {
  return join(stateDir(env), "state.db");
}

export function cacheDir(env: Env = process.env): string {
  if (env.WOWGET_CACHE_DIR) return expandHome(env.WOWGET_CACHE_DIR);
  return join(homedir(), "Library", "Caches", "wowget");
}
