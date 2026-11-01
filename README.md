# wowget

A small command-line addon manager for World of Warcraft on macOS. Keeps your
addon list in a plain TOML manifest, installs from open sources (GitHub
releases, WoWInterface, direct URLs) and updates them in place. No CurseForge
client, no ads, no browsing UI.

Status: MVP. See [docs/PLAN.md](docs/PLAN.md) for the roadmap and
[docs/SPEC-MVP.md](docs/SPEC-MVP.md) for the current behaviour.

## Usage

```
wowget init [--path DIR] [--flavor forever]   # create ~/.config/wowget/wowget.toml
wowget add github:Questie/Questie             # install and add to the manifest
wowget add url:https://example.com/Foo.zip --name Foo
wowget list                                   # what is installed (no network)
wowget outdated                               # check for newer releases
wowget update [name...]                       # install newer releases
wowget install                                # install manifest addons not yet installed
wowget remove Questie
```

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
