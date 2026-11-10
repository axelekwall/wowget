# Multiple targets and Windows support

Extends SPEC-MVP.md. Where the two disagree, this file wins.

## Goals

1. One manifest and one state database manage several WoW installs (Forever,
   Classic Era, retail, the progressive Classic line) side by side.
2. Every command works on all targets by default and can be filtered with a
   repeatable `--target` flag.
3. The tool runs on macOS and Windows 11 with sensible default locations and
   game-directory detection on both.

## Part A: targets

### Manifest

```toml
[targets.forever]
path = "/Applications/World of Warcraft/_forever_/Interface/AddOns"
flavor = "forever"

[targets.era]
path = "/Applications/World of Warcraft/_classic_era_/Interface/AddOns"
flavor = "classic"

[[addon]]
name = "Questie"
source = "github:Questie/Questie"
targets = ["forever", "era"]   # optional; absent means every target
```

- `targets` is a table of named targets. Names: `[a-z0-9][a-z0-9_-]*`, unique,
  case-sensitive, compared as written. At least one target is required for
  every command except `init`, `target add` and `target list`.
- Each target has `flavor` (as before) and exactly one of:
  - `path`: the AddOns directory, absolute, kept verbatim;
  - `folder`: a version folder in the game directory, such as `_classic_era_`
    (see "Folder targets" below). One folder name: letters, digits, `_`, `-`
    and `.`, not `.` or `..`.
- `[[addon]]` gains an optional `targets` array of target names. Unknown
  names are a manifest error naming the addon and the target. An empty array
  is an error. `pin` and `prerelease` apply on every target the addon is on.
- The old single `[install]` table is no longer accepted. The error message
  says the format changed and points at `wowget init`. No migration code.
- `renderManifest` writes the `[targets.*]` tables, with `path` or `folder`. New write helpers:
  - `addTarget(path, name, target)` appends a `[targets.<name>]` table **before
    the first `[[addon]]` block** (or at the end if none), so targets stay
    together above addons.
  - `removeTarget(path, name)` splices that table by line range like
    `removeAddon`, and rewrites every addon's `targets` line that mentions it
    (removing the name; if that would empty the list, the addon entry is
    removed too and reported).
  - `setAddonTargets(path, name, targets | undefined)` replaces, inserts (after
    the `source =` line) or deletes the `targets =` line inside the located
    addon block. `undefined` deletes the line (meaning all targets).
  - The re-parse-and-restore check now compares targets, addons and each
    addon's `targets` list.

### Folder targets

A `folder` target keeps machine-specific paths out of the manifest, so one
manifest can be shared between machines, for example through a dotfiles
repository, when the game is installed in a different place on each:

```toml
[targets.era]
folder = "_classic_era_"
flavor = "classic"
```

- Its AddOns directory is `<game dir>/<folder>/Interface/AddOns`, where the
  game dir is the first of the game directory candidates (see "Game directory
  detection"; `WOWGET_GAME_DIR` replaces the list) that has a `<folder>`
  directory. It is located on every run; nothing about it is stored.
- A folder target whose folder is in none of the candidates is **not on this
  machine**. Commands that act on every target skip it and emit a
  `target:absent` event, which the CLI prints to stderr. Naming it with
  `--target` on a command that works on the target's files (`add`, `list`,
  `outdated`, `update`, `install`, `rollback`, `reconcile`, `doctor`) is a
  `not_found` error, as is such a command where no selected target is on this
  machine.
- `add` without `--target` writes no `targets` list, so the addon stays on
  every target, also those not on this machine; `install` there picks it up.
- Two targets must not use the same AddOns directory (compared
  case-insensitively on macOS and Windows), since each keeps its own record of
  the folders it owns. `target add` refuses a target that would, including
  where a folder target not on this machine would resolve. A folder target is
  located on every run, so this can still happen later (a version folder is
  deleted, `WOWGET_GAME_DIR` changes): every command that loads targets, and
  `remove`, then fails with a `manifest` error naming both targets. `target
  list`, `target remove` and `target portable` still run, to fix it.
- `remove` and `target remove` on a target not on this machine deactivate its
  state rows without touching any files, with a `target:absent` event for
  each install forgotten. Folder names are compared case-insensitively when
  `target add` checks for a clash.
- `init --portable` scans the default candidates (or `WOWGET_GAME_DIR`) and
  writes folder targets. Without it `init` writes `path` targets as before,
  so a new manifest stays readable by older versions. `--portable` is a
  usage error with `--game-dir` or `--path`, since a later run would not look
  in that directory. A detected folder that an earlier candidate also has is
  written as a `path`, so it cannot resolve to the other directory later.
- A manifest with folder targets is rejected by wowget versions without them
  (as an unknown key); a manifest with only `path` targets is unchanged.
- `target portable [name...]` converts existing `path` targets (all of them by
  default). A target is converted only when its path, resolved, is
  `<game dir>/<folder>/Interface/AddOns` and a folder target `<folder>` would
  locate that same directory on this machine, with no other target having that
  folder (compared case-insensitively). The conversion therefore changes no
  directory here. The `path =` line is replaced by `folder =` in place, through
  the checked manifest write; everything else in the file stays. Every target
  left as it was is reported with the reason. A named target that is unknown
  is a `usage` error.
- `doctor` reports each target `target portable` would convert as a hint
  (`hints` in the result, kind `portable_target`). Hints are not issues and do
  not change the exit code. Nothing converts targets without being asked, so a
  manifest stays readable by older versions until the user opts in.

### State

Schema version 3:

- `installs` gains `target TEXT NOT NULL`. Migration 3 adds the column with
  default `'forever'` (the only target that existed before) and replaces the
  active index with `UNIQUE (target, addon) WHERE active = 1`.
- Every `State` method that took `addon` takes `target` first:
  `getActiveInstall(target, addon)`, `listActiveInstalls(target?)`,
  `deactivateInstall(target, addon)`, `folderOwners(target, folder)`,
  `releaseFolders(target, folders, exceptAddon)`. `NewInstall` gains
  `target`. Folder ownership is scoped to a target.
- The http cache and the zip cache are unchanged and shared across targets.

### Installer

`install` and `uninstall` take `target: string` next to `targetDir`, and pass
it through to the state. No other change.

### Ops

Every op takes the parsed manifest and an optional `targets?: string[]` filter.
Unknown filter names are a `usage` error listing the valid names. With no
filter, the op runs on every target.

| Command | Behaviour |
|---|---|
| `init [--path P --flavor F --name N] [--game-dir D]` | Without `--path`: scan the game directory and add a target for every version folder found (see detection). Error if none found. With `--path`: add exactly one target named `N` (default: the flavor name). Error if the manifest exists. Creates missing `Interface/AddOns` directories. Reports the targets added. |
| `target list` | Name, flavor, folder, path (null for a folder target not on this machine), and whether the path exists. |
| `target add <name> (--path P \| --folder D) --flavor F` | Appends a target; creates the AddOns dir if missing. A folder target not on this machine is added all the same. Refuses a path or folder another target already has. |
| `target portable [name...]` | Rewrites `path` targets as `folder` targets where that locates the same directory here (see "Folder targets"). Reports converted and skipped targets. |
| `target remove <name>` | Uninstalls every addon on it (deactivating state rows), removes the target, drops the name from addon `targets` lists, removes addons left with no targets. Reports everything removed. |
| `add <source> [--name N] [--target T]...` | Installs into the chosen targets (default all). Writes `targets` only when a subset. Validation (manifest text round trip) runs first, then resolve+install per target; the first target failure stops the rest, rolls back installs done in this call, and nothing is written. The flavor-not-available error from release.json is a per-target failure like any other. |
| `remove <name> [--target T]...` | No filter: uninstall on every target, splice the entry. With a filter: uninstall on those targets and remove them from the addon's `targets` (writing the full remaining list, since "absent" means all). If every target is removed, the entry is removed. |
| `list [--target T]...` | One row per (addon, target) the addon belongs to, sorted by addon name then target name: name, target, version, status, source. Statuses as before. No network. |
| `outdated`, `update [name...]`, `install` | As before, per (addon, target) row, with the per-row status. Resolution is memoised per (addon source, flavor, prerelease, pin) within one run so targets of the same flavor share one lookup. Errors stay per row. |

Result objects carry `target` on every row. `--json` keeps the same shape with
rows in an array.

### CLI

- Global repeatable `--target <name>` (also `-t`). Accepted on `add`,
  `remove`, `list`, `outdated`, `update`, `install`. A usage error elsewhere.
- `target` subcommands: `wowget target list|add|remove|portable`.
- `init` flags: `--path`, `--flavor`, `--name`, `--game-dir`, `--portable`.
- `target add` flags: `--path` or `--folder`, and `--flavor`.
- `list` output gains a TARGET column. Other tables gain it too.
- Help text updated.

## Part B: Windows (and Linux defaults)

### Locations

| Platform | Manifest | State | Cache |
|---|---|---|---|
| macOS | `~/.config/wowget/wowget.toml` | `~/Library/Application Support/wowget/state.db` | `~/Library/Caches/wowget` |
| Windows | `%APPDATA%\wowget\wowget.toml` | `%LOCALAPPDATA%\wowget\state.db` | `%LOCALAPPDATA%\wowget\cache` |
| Linux | `$XDG_CONFIG_HOME/wowget/wowget.toml` (default `~/.config`) | `$XDG_STATE_HOME/wowget/state.db` (default `~/.local/state`) | `$XDG_CACHE_HOME/wowget` (default `~/.cache`) |

Env overrides (`WOWGET_MANIFEST`, `WOWGET_STATE_DIR`, `WOWGET_CACHE_DIR`) win
on every platform. `paths.ts` takes `platform` as an optional parameter
(default `process.platform`) so tests cover all three without mocking.

### Game directory detection

`gameDirCandidates(platform, env)`:

- macOS: `/Applications/World of Warcraft`
- Windows: `%PROGRAMFILES(X86)%\World of Warcraft`, `%PROGRAMFILES%\World of Warcraft`
- Linux: none (use `--game-dir`)
- `WOWGET_GAME_DIR` and `init --game-dir` override the list.

Version folders and their default target names and flavors:

| Folder | Target name | Flavor |
|---|---|---|
| `_forever_` | `forever` | `forever` |
| `_classic_era_` | `era` | `classic` |
| `_classic_` | `classic` | `mists` (the progressive line is Mists today; make this one constant) |
| `_retail_` | `retail` | `mainline` |

A folder counts when it contains `World of Warcraft.app`, `World of Warcraft Classic.app`, `Wow.exe`, `WowClassic.exe` or a `.flavor.info` file. `_classic_beta_`, `_ptr_` and similar are ignored.

### Locked files

On Windows, renaming or deleting a folder with open files fails with
`EPERM`, `EBUSY` or `EACCES`. In the installer swap and in uninstall, map
those codes to a `WowgetError("locked", ...)` whose message says the folder
is in use and to close World of Warcraft, after the normal rollback. On
other platforms the mapping is harmless.

### Build and CI

- `package.json` scripts: `build` (host), `build:mac`
  (`--target=bun-darwin-arm64 --outfile dist/wowget`), `build:win`
  (`--target=bun-windows-x64 --outfile dist/wowget.exe`).
- CI matrix adds `windows-latest`. The build step runs the host build.
- Tests that use `chmod` to make directories read-only, or symlinks, are
  guarded with `test.skipIf(process.platform === "win32")` and say why in the
  test name. All other tests must pass on Windows unchanged; use `path.join`
  everywhere, never string concatenation with `/`, and compare paths after
  `path.resolve`.
- `.gitattributes` with `* text=auto eol=lf` so fixtures keep LF on Windows
  checkouts.

### README

Document targets, the `--target` flag, and the Windows locations and build.
