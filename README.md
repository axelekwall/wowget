# wowget

A small command-line addon manager for World of Warcraft on macOS and Windows.
Keeps your addon list in a plain TOML manifest, installs from open sources
(GitHub releases, direct URLs) and updates them in place. No CurseForge
client, no ads, no browsing UI.

Status: MVP. See [docs/PLAN.md](docs/PLAN.md) for the roadmap,
[docs/SPEC-MVP.md](docs/SPEC-MVP.md) for the base behaviour and
[docs/SPEC-TARGETS-WINDOWS.md](docs/SPEC-TARGETS-WINDOWS.md) for targets.

## Install

Prebuilt binaries for macOS (Apple silicon and Intel) and 64-bit Windows are attached to every [release](https://github.com/axelekwall/wowget/releases).

macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/axelekwall/wowget/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/axelekwall/wowget/main/install.ps1 | iex
```

The scripts download the binary for your platform, verify its SHA-256 checksum
and put it in `~/.local/bin` (macOS) or `%LOCALAPPDATA%\wowget\bin`
(Windows, added to your user `PATH`). Set `WOWGET_VERSION=0.1.0` to pin a
version and `WOWGET_INSTALL_DIR` to choose the directory.

With the GitHub CLI instead:

```sh
gh release download --repo axelekwall/wowget --pattern wowget-darwin-arm64 --output ~/.local/bin/wowget
chmod +x ~/.local/bin/wowget
```

Or pick the file for your platform on the releases page. A binary downloaded
with a browser on macOS needs `xattr -d com.apple.quarantine wowget` before it
runs.

Then:

```sh
wowget init                       # finds your World of Warcraft installs
wowget add github:Questie/Questie # installs on every target
wowget list
```

## Usage

```
wowget init                                   # one target per installed WoW version (forever, era, classic, retail)
wowget init --path DIR --flavor classic --name era   # or a single AddOns directory
wowget target list                            # targets and whether their AddOns directories exist
wowget target add retail --path DIR --flavor mainline
wowget target remove retail                   # uninstall everything on it and drop it
wowget add github:Questie/Questie             # install on every target and add to the manifest
wowget add github:Questie/Questie -t era      # install on some targets only
wowget add url:https://example.com/Foo.zip --name Foo
wowget list                                   # what is installed, per target (no network)
wowget outdated                               # check for newer releases
wowget update [name...]                       # install newer releases
wowget install                                # install manifest addons not yet installed
wowget remove Questie -t era                  # remove from one target, keep the others
wowget remove Questie
```

### Targets

A target is a named AddOns directory with a flavor. The manifest lists them as
`[targets.<name>]` tables; an addon is on every target unless its entry has a
`targets` list:

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
targets = ["era"]   # optional; absent means every target
```

`init` without `--path` scans the game directory for `_forever_`,
`_classic_era_`, `_classic_` and `_retail_` and adds a target for each one that
holds a game. It tries `/Applications/World of Warcraft` on macOS, and
`%PROGRAMFILES(X86)%\World of Warcraft` then `%PROGRAMFILES%\World of Warcraft`
on Windows, using the first that has an install. Linux has no default; pass
`--game-dir`, which (like `WOWGET_GAME_DIR`) replaces the list.

`add`, `remove`, `list`, `outdated`, `update` and `install` act on every target
unless filtered with `--target <name>` (`-t`), which can be repeated. `add -t` writes the chosen
targets to the entry; `remove -t` uninstalls from those targets and removes
them from the entry, removing the entry when none are left. Release lookups are
shared between targets of the same flavor within one run.

Manifests from before targets (with an `[install]` table) are rejected; move
the old file aside, run `wowget init` and add the addons again.
A state database from before targets is upgraded in place and assigns its
installs to the `forever` target.

### Options

`add` also takes `--prerelease` and `--pin <tag>`. Global flags: `--manifest
<path>`, `--json`, `--force` (replace unmanaged folders, skip an inconclusive
flavor check), `--verbose`. Set `GITHUB_TOKEN` to raise the GitHub API rate
limit.

### Locations

| Platform | Manifest | State | Cache |
|---|---|---|---|
| macOS | `~/.config/wowget/wowget.toml` | `~/Library/Application Support/wowget/state.db` | `~/Library/Caches/wowget` |
| Windows | `%APPDATA%\wowget\wowget.toml` | `%LOCALAPPDATA%\wowget\state.db` | `%LOCALAPPDATA%\wowget\cache` |
| Linux | `$XDG_CONFIG_HOME/wowget/wowget.toml` | `$XDG_STATE_HOME/wowget/state.db` | `$XDG_CACHE_HOME/wowget` |

On Linux the XDG variables default to `~/.config`, `~/.local/state` and
`~/.cache`. `WOWGET_MANIFEST`, `WOWGET_STATE_DIR` and `WOWGET_CACHE_DIR`
override these on every platform.

### Windows

Windows locks the files of a running game, so close World of Warcraft before
`update`, `install`, `remove` or `target remove`. A folder that is in use fails
with a `locked` error; an update that hits one restores the previous version.

## Stack

Bun + TypeScript, compiled to a single binary. SQLite (`bun:sqlite`) for local
state; the manifest stays a text file you can keep in your dotfiles.

```
bun run build       # dist/wowget for this machine
bun run build:mac   # dist/wowget for Apple silicon
bun run build:win   # dist/wowget.exe for 64-bit Windows, cross-compiled from any host
WOWGET_VERSION=0.1.0 bun run build:release   # dist/release/* for every platform, with SHA256SUMS.txt
```

`wowget --version` prints the version compiled in by `build:release` (`dev`
for other builds).

### Releasing

Push a tag and the release workflow builds the binaries, publishes a GitHub
release with generated notes, then downloads and runs each binary on its
platform. A tag with a `-` suffix (`v0.2.0-beta.1`) becomes a pre-release.

```sh
git tag v0.1.0 && git push origin v0.1.0
```

## License

MIT, see [LICENSE](LICENSE).
