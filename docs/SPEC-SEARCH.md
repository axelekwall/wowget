# Search

Extends SPEC-MVP.md and SPEC-TARGETS-WINDOWS.md. Scope: Milestone 4's
`search`, a curated addon registry, and the bare-name `add` the registry
enables. CurseForge stays out (see "Not in scope").

## Goals

1. `wowget search <query>` finds addons and prints source strings that
   `wowget add` accepts as they are.
2. The best-known addons, most of which are only on GitHub, rank first and
   carry checked flavor support.
3. `wowget add questie` works for registry addons without the user looking up
   the source.
4. Searching costs at most one catalogue download a day and works offline from
   the last copy.

## Data sources (checked 2026-11-02)

| Source | Endpoint | Access | Size | Caching headers |
|---|---|---|---|---|
| Registry | `https://raw.githubusercontent.com/axelekwall/wowget/main/registry/addons.toml` | open | ~100 entries | ETag |
| WoWInterface | `https://api.mmoui.com/v3/game/WOW/filelist.json` | open | 8,234 entries, 5.6 MB (gzip on the wire) | `max-age=3600` only, no ETag or Last-Modified |
| GitHub | `https://api.github.com/search/repositories?q=topic:wow-addon+<query>&sort=stars` | open, 10 searches/min unauthenticated, 30 with `GITHUB_TOKEN` | 1,774 repos with the topic | none useful |

WoWInterface catalogue entry fields used: `UID`, `UIName`, `UIAuthorName`,
`UIVersion`, `UIDate` (ms epoch), `UIDownloadTotal`, `UIDownloadMonthly`,
`UICompatibility` (`[{ version, name }]`, author-maintained), `UIDir` (the
folders the zip installs), `UIFileInfoURL`.

## Registry

A TOML file in this repository at `registry/addons.toml`, edited by hand and
through pull requests.

```toml
[[addon]]
name = "Questie"
source = "github:Questie/Questie"
flavors = ["forever", "classic", "bcc", "wrath", "cata", "mists"]
folders = ["Questie"]
aliases = ["questhelper"]                # optional
description = "Quest helper for Classic"  # optional, one line
```

- `name`: display name, unique case-insensitively across names and aliases.
  It is also the default manifest name on bare-name `add`, so it must pass
  `addonNameProblem`.
- `source`: any source string `parseSource` accepts except `url:`. One
  source per entry.
- `flavors`: flavors `wowget add` installs on today, without `--force`. For
  GitHub that can be an older release when the newest has no build for the
  flavor. Checked by CI (below).
- `folders`: the addon folders those installs produce, across all listed
  flavors. Used for reconcile and for de-duplicating WoWInterface rows.
  Checked by CI.
- `aliases`: other names a user might type. Compared after normalisation.
- Unknown keys are an error in the check script and are ignored by the
  client, so older binaries keep working when the format grows.

### Loading

- `loadRegistry(http)` fetches the raw URL through `Http.getBytes` (ETag
  cache in `http_cache`) and parses with `Bun.TOML.parse`.
- A snapshot of `registry/addons.toml` is compiled into the binary (text
  import). It is used when the fetch fails or returns something that does not
  parse, with a `registry_stale` event so the CLI can warn once.
- `WOWGET_REGISTRY_URL` overrides the URL; `WOWGET_REGISTRY_URL=off` uses the
  snapshot only. Tests use both.

### Check script and CI

`bun run registry:check` (`scripts/check-registry.ts`):

1. Validates the file: required keys, unique names and aliases, parseable
   sources, known flavors.
2. For each entry and each flavor in `FLAVORS`, resolves the source with the
   same `Source` code the CLI uses, sharing one `HttpClient` so release
   lookups are reused across flavors.
3. When `Resolved.flavorVerified` is false (WoWInterface), downloads the zip
   once per entry, extracts it to a temp directory and runs
   `folderSupportsFlavor` on each addon folder, the same check the installer
   runs. `unknown` counts as not supported.
4. Compares the supported set with `flavors` and the extracted folder names
   with `folders`. Prints one line per mismatch and exits 1 if there is any.
   With `--write` it puts the values it found into the file instead,
   rewriting only those two lines of each entry; an entry that installs on no
   flavor is left for a person. `--report <file>` writes a Markdown summary.
5. An error reaching a source (a failed download, a checksum the source lists
   wrongly) is reported but does not fail the run, because it says the source
   is broken rather than that the entry is wrong. A GitHub rate limit does
   fail it.

The CI workflow runs the check on pull requests that touch `registry/` or the
source code. A daily scheduled run (also startable by hand) runs it with
`--write` and, when an entry changed, opens a pull request titled
`chore(registry): update flavors and folders from the sources` from the
`registry/update` branch, or refreshes the one already open. The run fails
when an entry needs a person, so the failure shows in the Actions tab. A PR
opened with the workflow token starts no workflows, so that PR shows no CI
checks; the scheduled run already did the check.

### Seeding

Target about 100 entries. Start from addons that publish GitHub releases with
the BigWigs packager (they carry `release.json` flavor data), then add
WoWInterface addons ranked by `UIDownloadMonthly` whose compatibility list
includes a current client. Every seeded entry must pass the check script.
There is no open popularity data for addons hosted only on CurseForge, so the
list is a judgement call, not a measured top 100.

## WoWInterface catalogue

- Stored as a file, not in `http_cache`: the body exceeds `CACHE_MAX_BYTES`
  and the endpoint sends no validators, so `getBytes` would download it on
  every call.
- Location: `<cacheDir>/.catalog/wowi.json`, holding a projection of the
  fields listed above (about 3 MB, half the raw size). The fetch time is
  kept as a small record under the key `catalog:wowi` through
  `Http.writeRecord`.
- Refreshed when the copy is older than 24 hours or on `search --refresh`.
  Written atomically (`.tmp` then rename). If the refresh fails and a copy
  exists, use it and emit `catalog_stale` with its age; if no copy exists,
  search the other sources and report the WoWInterface failure in the result.
- `findStaleCacheDirs` and `pruneAddonCache` skip top-level cache entries
  whose name starts with `.`, so `doctor --clean` never removes the catalogue.

### Flavor mapping

`UICompatibility[].version` is a patch number. Map by major version:

| Major | Flavor |
|---|---|
| 1 | `classic` |
| 2 | `bcc` |
| 3 | `wrath` |
| 4 | `cata` |
| 5 | `mists` |
| 6 and up | `mainline` |

Forever has no known mapping yet (see "Open questions"). Until it does, every
WoWInterface entry is `unknown` for `forever`. The data is author-maintained
and often stale, so the mapping only filters and labels results; it is never
treated as verified.

## `wowget search`

```
wowget search <query...> [-t <target>]... [--flavor <flavor>] [--all-flavors]
                         [--github] [--limit <n>] [--refresh]
```

- The query is the remaining words joined by spaces. An empty query is a
  usage error.
- Flavor filter: `--flavor` if given; else the flavors of the `-t` targets;
  else the flavors of every manifest target; else none (no manifest or no
  targets). `--all-flavors` turns the filter off. A row passes when any of
  its flavors is in the filter set or its support for one of them is
  `unknown`.
- Sources: registry and WoWInterface always; GitHub only with `--github`,
  because of its rate limit.
- `--limit` defaults to 20.
- Works without a manifest or targets. Reads the manifest only for targets
  and to mark rows that are already in it.

### Matching and ranking

Normalise text by lower-casing and removing everything except letters and
digits. Each row gets a match tier against the normalised query, using its
name, its aliases (registry) and its folder names:

1. exact match
2. prefix match
3. substring match
4. every query word (split on whitespace, then normalised) is a substring

A row that matches on folder names only ranks half a tier below the same match
on its name or an alias, so an addon named after the query comes before one
that merely ships a folder with that name. GitHub rows that match none of
these were matched by GitHub on their description or topics; they are kept
after every other match. Other rows with no tier are dropped. Sort
by tier, then source rank (registry,
WoWInterface, GitHub), then popularity (WoWInterface `UIDownloadMonthly`,
GitHub stars; the registry has none and keeps file order), then name.

### De-duplication

- A WoWInterface row whose `wowi:<UID>` is a registry entry's source is
  dropped.
- A WoWInterface row whose `UIDir` set equals a registry entry's `folders`
  set (case-insensitive) is dropped; the registry entry wins.
- A GitHub row whose `github:<owner>/<repo>` is a registry entry's source is
  dropped.

### Output

Table columns: name, source, flavors (filter flavors first; `?` marks
unknown), popularity, last updated, and `*` when the source is already in the
manifest. GitHub rows show `?` for flavors because nothing about their
releases is fetched during search.

`--json` (the global flag) prints `{ "results": [...], "flavors": [...], "warnings": [...] }`.
`flavors` is the filter that was applied, or `null`; `warnings` lists sources
that failed or are stale. Each result:

```json
{
  "name": "Questie",
  "source": "github:Questie/Questie",
  "origin": "registry",
  "flavors": { "classic": "yes", "forever": "yes" },
  "description": "Quest helper for Classic",
  "downloadsMonthly": null,
  "stars": null,
  "updatedAt": null,
  "url": "https://github.com/Questie/Questie",
  "inManifest": true
}
```

### Core and CLI split

- `src/core/search/registry.ts`, `wowi-catalog.ts`, `github-search.ts`: each
  returns rows of one shared `SearchRow` type.
- `src/core/search/index.ts`: matching, ranking, de-duplication, filtering.
- `ops.search(ctx, opts)` returns `{ results, warnings }` and emits events
  for catalogue refreshes. `cli.ts` renders it.

## Bare-name `add`

`wowget add <name>` where the argument has no `:`:

1. Look it up in the registry by normalised name or alias. On a match, use
   the entry's `source`, and its `name` as the manifest name unless `--name`
   is given. Print the resolved source.
2. Otherwise fail with a `source` error that suggests
   `wowget search <name>`.

The manifest always stores the full source string, never the bare name, so a
registry change cannot alter an installed addon.

## Reconcile

`scanUnmanaged` gains a fallback after TOC metadata: when no source is found
in the TOC fields, match the folder against registry `folders`, then against
the WoWInterface catalogue's `UIDir`. A registry match is offered for
`--adopt` like a TOC match. A WoWInterface match is shown as a suggestion only
and is not adopted automatically, because folder names like `Core` or `Libs`
are not unique there. Reconcile uses the cached catalogue and does not
refresh it.

## Phases

1. Registry format, check script, CI workflow, seeded `registry/addons.toml`.
2. `search` over the registry and the WoWInterface catalogue.
3. Bare-name `add`.
4. `search --github`, reconcile fallback.

Each phase is one commit or pull request with its tests: matching and ranking
on fixed row sets, de-duplication, flavor mapping, catalogue refresh and stale
fallback with a fake fetch, registry snapshot fallback, bare-name `add` hit
and miss.

## Not in scope

- **CurseForge.** The website returns a Cloudflare interactive challenge to
  non-browser clients, including for `robots.txt`, and the download endpoint
  needs a file id that only the page or the API provides. The 3rd-party API
  terms forbid products that compete with CurseForge, caching API data and
  sharing a key (sections 2.2 and 3.1), and authors can opt out of
  third-party distribution. A CurseForge CDN URL still works through `url:`,
  but it names one version and never shows as outdated.
- **Wago.** Its API returns 401 without a developer key, and there is no
  documented search endpoint.
- **Tukui.** `api.tukui.org/v1/addons` is open but lists a handful of addons,
  and wowget has no `tukui:` source to install them. The registry covers
  ElvUI if one of the existing sources can install it; add a `tukui:` source
  only if the check script shows none can.
- Categories, screenshots, descriptions beyond one line, and any interactive
  UI.

## Open questions

- How WoWInterface marks Forever in `UICompatibility`, if it does. Check
  after the 2026-11-04 launch against an addon known to support Forever, then
  add the mapping.
- Whether the registry should move to its own repository once outside
  contributions arrive. The fetch URL is configurable, so moving it later only
  changes the default.
