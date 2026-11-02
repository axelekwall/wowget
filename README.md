# wowget

A small command-line addon manager for World of Warcraft on macOS and Windows.
Keeps your addon list in a plain TOML manifest, installs from open sources
(GitHub releases, WoWInterface, direct URLs) and updates them in place. No CurseForge
client, no ads, no browsing UI.

Status: MVP. See [docs/PLAN.md](docs/PLAN.md) for the roadmap,
[docs/SPEC-MVP.md](docs/SPEC-MVP.md) for the base behaviour,
[docs/SPEC-TARGETS-WINDOWS.md](docs/SPEC-TARGETS-WINDOWS.md) for targets and
[docs/SPEC-SEARCH.md](docs/SPEC-SEARCH.md) for the planned search.

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

To upgrade later, run `wowget self-update`. It downloads the latest release
for your platform, verifies its checksum, checks that it runs, and replaces
the binary in place. `wowget self-update --check` only reports whether a newer
release exists. On Windows the previous binary is kept as `wowget.exe.old`
until the next self-update. Versions before 0.3.0 lack the command; upgrade
those by running the install script again.

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
wowget add wowi:7032                          # install from WoWInterface by addon ID (TomTom)
wowget add url:https://example.com/Foo.zip --name Foo
wowget list                                   # what is installed, per target (no network)
wowget outdated                               # check for newer releases
wowget update [name...]                       # install newer releases
wowget install                                # install manifest addons not yet installed
wowget pin Questie [v11.2.0]                  # freeze an addon at its installed or a given release
wowget unpin Questie                          # remove the pin
wowget rollback Questie                       # reinstall the previous release from the cache
wowget reconcile [--adopt]                    # find hand-installed addons and optionally adopt them
wowget doctor [--clean]                       # verify targets, TOC interfaces and cache health
wowget self-update [--check]                  # upgrade wowget itself to the latest release
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
bun run registry:check [--only Questie]       # resolve registry/addons.toml entries on every flavor
```

`wowget --version` prints the version compiled in by `build:release` (`dev`
for other builds).

### Releasing

Every push to `main` is checked for a release. Commit headers follow
[Conventional Commits](https://www.conventionalcommits.org/), and the ones
since the last `vX.Y.Z` tag decide the next version: a breaking change (`feat!:`
or a `BREAKING CHANGE:` footer) bumps the major version, `feat` the minor and
`fix` or `perf` the patch. Other types (`docs`, `ci`, `test`, `chore`,
`refactor`, ...) do not release. Before 1.0 a breaking change bumps the minor
version. Pull requests are squash-merged, so their title is the header that
counts, or the commit's own header when there is one commit; a check rejects
titles that do not follow the format.

The release workflow then builds the binaries, publishes a GitHub release
with generated notes and creates the tag, then downloads and runs each binary
on its platform. Run "Release on merge" by hand with "dry run" to see the next
version without releasing, or locally:

```sh
bun scripts/release-version.ts
```

Pushing a tag by hand still releases it; a tag with a `-` suffix
(`v0.4.0-beta.1`) becomes a pre-release and is ignored when computing the
next version.

```sh
git tag v0.4.0-beta.1 && git push origin v0.4.0-beta.1
```

## License

MIT, see [LICENSE](LICENSE).
