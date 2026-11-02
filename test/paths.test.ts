import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { cacheDir, gameDirCandidates, manifestPath, stateDbPath } from "../src/core/paths.ts";

const home = homedir();

describe("default locations", () => {
  test("macOS", () => {
    expect(manifestPath(undefined, {}, "darwin")).toBe(join(home, ".config", "wowget", "wowget.toml"));
    expect(stateDbPath({}, "darwin")).toBe(join(home, "Library", "Application Support", "wowget", "state.db"));
    expect(cacheDir({}, "darwin")).toBe(join(home, "Library", "Caches", "wowget"));
  });

  test("Windows uses APPDATA and LOCALAPPDATA, matched case-insensitively", () => {
    const env = { AppData: "C:\\Users\\a\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" };
    expect(manifestPath(undefined, env, "win32")).toBe("C:\\Users\\a\\AppData\\Roaming\\wowget\\wowget.toml");
    expect(stateDbPath(env, "win32")).toBe("C:\\Users\\a\\AppData\\Local\\wowget\\state.db");
    expect(cacheDir(env, "win32")).toBe("C:\\Users\\a\\AppData\\Local\\wowget\\cache");
  });

  test("Windows without APPDATA falls back to the home directory", () => {
    expect(manifestPath(undefined, {}, "win32")).toBe(win32.join(home, "AppData", "Roaming", "wowget", "wowget.toml"));
    expect(cacheDir({}, "win32")).toBe(win32.join(home, "AppData", "Local", "wowget", "cache"));
  });

  test("Linux follows XDG and ignores relative XDG values", () => {
    const env = { XDG_CONFIG_HOME: "/xdg/config", XDG_STATE_HOME: "/xdg/state", XDG_CACHE_HOME: "/xdg/cache" };
    expect(manifestPath(undefined, env, "linux")).toBe(join("/xdg/config", "wowget", "wowget.toml"));
    expect(stateDbPath(env, "linux")).toBe(join("/xdg/state", "wowget", "state.db"));
    expect(cacheDir(env, "linux")).toBe(join("/xdg/cache", "wowget"));

    expect(manifestPath(undefined, { XDG_CONFIG_HOME: "relative" }, "linux")).toBe(join(home, ".config", "wowget", "wowget.toml"));
    expect(stateDbPath({}, "linux")).toBe(join(home, ".local", "state", "wowget", "state.db"));
    expect(cacheDir({}, "linux")).toBe(join(home, ".cache", "wowget"));
  });

  test("WOWGET_* variables and --manifest win on every platform", () => {
    const manifest = join(home, "m.toml");
    const state = join(home, "state");
    const cache = join(home, "cache");
    const env = { WOWGET_MANIFEST: manifest, WOWGET_STATE_DIR: state, WOWGET_CACHE_DIR: cache, APPDATA: "C:\\x", XDG_CACHE_HOME: "/x" };
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(manifestPath(undefined, env, platform)).toBe(manifest);
      expect(manifestPath("~/other.toml", env, platform)).toBe(join(home, "other.toml"));
      expect(stateDbPath(env, platform)).toBe(platform === "win32" ? win32.join(state, "state.db") : join(state, "state.db"));
      expect(cacheDir(env, platform)).toBe(cache);
    }
  });
});

describe("gameDirCandidates", () => {
  test("per platform", () => {
    expect(gameDirCandidates("darwin", {})).toEqual(["/Applications/World of Warcraft"]);
    expect(gameDirCandidates("win32", { "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramFiles: "C:\\Program Files" })).toEqual([
      "C:\\Program Files (x86)\\World of Warcraft",
      "C:\\Program Files\\World of Warcraft",
    ]);
    expect(gameDirCandidates("win32", {})).toEqual([]);
    expect(gameDirCandidates("linux", {})).toEqual([]);
  });

  test("WOWGET_GAME_DIR replaces the list", () => {
    const dir = join(home, "Games", "World of Warcraft");
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(gameDirCandidates(platform, { WOWGET_GAME_DIR: dir, ProgramFiles: "C:\\Program Files" })).toEqual([dir]);
    }
  });
});
