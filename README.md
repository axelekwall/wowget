# wowget

A small command-line addon manager for World of Warcraft on macOS. Keeps your
addon list in a plain TOML manifest, installs from open sources (GitHub
releases, WoWInterface, direct URLs) and updates them in place. No CurseForge
client, no ads, no browsing UI.

Status: design stage. See [docs/PLAN.md](docs/PLAN.md) for the roadmap and the
decisions taken so far.

## Planned usage

```
wowget add github:Questie/Questie
wowget list
wowget outdated
wowget update
```

## Stack

Bun + TypeScript, compiled to a single binary. SQLite (`bun:sqlite`) for local
state; the manifest stays a text file you can keep in your dotfiles.

## License

MIT, see [LICENSE](LICENSE).
