# wowget

A small command-line addon manager for World of Warcraft on macOS. Keeps your
addon list in a plain TOML manifest, installs from open sources (GitHub
releases, WoWInterface, direct URLs) and updates them in place. No CurseForge
client, no ads, no browsing UI.

Status: MVP. See [docs/PLAN.md](docs/PLAN.md) for the roadmap,
[docs/SPEC-MVP.md](docs/SPEC-MVP.md) for the base behaviour and
[docs/SPEC-TARGETS-WINDOWS.md](docs/SPEC-TARGETS-WINDOWS.md) for targets.

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

`init` without `--path` scans `/Applications/World of Warcraft` (or
`--game-dir`) for `_forever_`, `_classic_era_`, `_classic_` and `_retail_` and
adds a target for each one that holds a game. `add`, `remove`, `list`,
`outdated`, `update` and `install` act on every target unless filtered with
`--target <name>` (`-t`), which can be repeated. `add -t` writes the chosen
targets to the entry; `remove -t` uninstalls from those targets and removes
them from the entry, removing the entry when none are left. Release lookups are
shared between targets of the same flavor within one run.

Manifests from before targets (with an `[install]` table) are rejected; move
the old file aside, run `wowget init` and add the addons again.

### Options

`add` also takes `--prerelease` and `--pin <tag>`. Global flags: `--manifest
<path>`, `--json`, `--force` (replace unmanaged folders, skip an inconclusive
flavor check), `--verbose`. Set `GITHUB_TOKEN` to raise the GitHub API rate
limit. `WOWGET_MANIFEST`, `WOWGET_STATE_DIR` and `WOWGET_CACHE_DIR` override the
default locations.

## Stack

Bun + TypeScript, compiled to a single binary. SQLite (`bun:sqlite`) for local
state; the manifest stays a text file you can keep in your dotfiles.

## License

MIT, see [LICENSE](LICENSE).
