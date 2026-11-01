# wowget MVP specification

Scope: Milestone 1 from PLAN.md. A vertical slice: manifest, state, GitHub and
URL sources, atomic install, and the commands `init`, `add`, `remove`, `list`,
`outdated`, `update`, `install`. No TUI, no search, no WoWInterface, no Wago.

## Toolchain

- Bun 1.4.x, TypeScript, strict mode. `bun test` for tests.
- Runtime dependencies: `fflate` only. TOML parsing uses `Bun.TOML.parse`.
  Argument parsing uses `parseArgs` from `node:util`. SQLite uses `bun:sqlite`.
- Dev dependencies: `typescript`, `@types/bun`.
- Scripts: `test` (`bun test`), `typecheck` (`tsc --noEmit`),
  `build` (`bun build --compile src/cli.ts --outfile dist/wowget`).

## Layout

```
src/
  cli.ts                 entry point; the only file that writes to stdout/stderr
  core/
    paths.ts             default locations and env overrides
    manifest.ts          parse, validate, append, splice
    state.ts             bun:sqlite schema, migrations, queries
    flavor.ts            Flavor type, TOC parsing, flavor checks
    zip.ts               extraction and addon-folder normalisation
    installer.ts         download cache, atomic install/uninstall
    http.ts              fetch wrapper with ETag cache (phase 2)
    sources/
      types.ts           Source interface, Resolved release
      parse.ts           "github:owner/repo" -> {kind, ...}
      github.ts          (phase 2)
      url.ts             (phase 2)
    ops.ts               one function per command, returns data (phase 2)
    events.ts            ProgressEvent type and emitter callback
    errors.ts            WowgetError with a `code` and user-facing message
test/
  *.test.ts              mirrors src/core
  fixtures/              TOC files, release.json samples
```

Rule: nothing under `src/core` reads `process.argv` or writes to the console.
Core functions return data and accept an optional `onEvent` callback for
progress. The CLI renders. A TUI can later be a second renderer.

## Locations and overrides

| Thing | Default | Override |
|---|---|---|
| Manifest | `~/.config/wowget/wowget.toml` | `--manifest <path>` or `WOWGET_MANIFEST` |
| State db | `~/Library/Application Support/wowget/state.db` | `WOWGET_STATE_DIR` |
| Zip cache | `~/Library/Caches/wowget/` | `WOWGET_CACHE_DIR` |
| GitHub token | none | `GITHUB_TOKEN` |

Directories are created on first use.

## Manifest

```toml
[install]
path = "/Applications/World of Warcraft/_forever_/Interface/AddOns"
flavor = "forever"

[[addon]]
name = "Questie"
source = "github:Questie/Questie"

[[addon]]
name = "SomeAddon"
source = "url:https://example.com/SomeAddon.zip"
prerelease = true     # optional, GitHub only, default false
pin = "v1.2.3"        # optional, a release id for that source
```

- `name` is unique, case-insensitive. Default on `add`: the GitHub repo name,
  or the URL's last path segment without `.zip`.
- `flavor` is one of the packager flavor names: `forever`, `mainline`,
  `classic`, `bcc`, `wrath`, `cata`, `mists`. Only `forever` and `classic` need
  to work end to end in the MVP, but the type covers all.
- The manifest is parsed with `Bun.TOML.parse` and validated by hand into a
  typed `Manifest`. Unknown keys are an error with the key name.

Writing rules (the file must survive hand edits and comments):

- `addAddon` appends a blank line and a `[[addon]]` block at the end of the
  file. Only keys that differ from defaults are written.
- `removeAddon` finds the `[[addon]]` block whose `name` matches, by scanning
  lines: a block starts at a `[[addon]]` header line and ends before the next
  line that starts with `[`. It also absorbs blank lines and comment lines
  directly above the header back to the previous block's last key line, so the
  comment that introduces an addon leaves with it. Remove that range only.
- After every write, re-parse the whole file. If it fails to parse, or the
  addon set is not exactly the expected one, restore the previous contents and
  throw.
- Writes are atomic: write to `<path>.tmp` then rename.

## State (bun:sqlite)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE installs (
  id INTEGER PRIMARY KEY,
  addon TEXT NOT NULL,              -- manifest name, stored lower-case
  source TEXT NOT NULL,             -- the source string
  release_id TEXT NOT NULL,         -- source-specific id (GitHub tag, URL sha256)
  version TEXT,                     -- human version if known
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  zip_path TEXT NOT NULL,
  installed_at TEXT NOT NULL,       -- ISO 8601
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX installs_active ON installs(addon) WHERE active = 1;

CREATE TABLE install_folders (
  install_id INTEGER NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  PRIMARY KEY (install_id, folder)
);

CREATE TABLE http_cache (
  url TEXT PRIMARY KEY,
  etag TEXT,
  last_modified TEXT,
  body BLOB NOT NULL,
  fetched_at TEXT NOT NULL
);
```

`PRAGMA user_version` holds the schema version, starting at 1. `openState()`
runs migrations in order. Expose a small typed API, not raw SQL from callers:
`getActiveInstall(addon)`, `listActiveInstalls()`, `recordInstall(...)` (inserts
the row and its folders, deactivates the previous active row, in one
transaction), `deactivateInstall(addon)`, `folderOwner(folder)`,
`getCache(url)`, `putCache(url, ...)`.

## Flavor and TOC

- `Flavor` union as listed above. Family: `forever` and `mainline` are
  Mainline-family; the rest are Classic-family.
- TOC suffixes that may satisfy a flavor, in priority order: the flavor's own
  suffixes, then its family suffix, then none:
  - forever: `_Forever`, `_Camelot`; family `_Mainline`
  - mainline: `_Mainline`, `_Standard`
  - classic: `_Vanilla`; family `_Classic`
  - others: their own suffix; family `_Classic`
  Both `_` and `-` separators are accepted.
- Interface number ranges: forever `16000..16999`, classic `11000..11999`,
  bcc `20000..29999`, wrath `30000..39999`, cata `40000..49999`,
  mists `50000..59999`, mainline `>= 100000`.
- `parseToc(text)` returns `{ interface: number[], title?, version?, fields }`.
  `## Interface:` may be a comma-separated list. Also read
  `## Interface-<Type>:` lines into `fields`.
- `folderSupportsFlavor(dir, flavor)` returns `"yes" | "no" | "unknown"`:
  `yes` if a TOC with the flavor's own suffix exists. Otherwise family-suffixed
  and unsuffixed TOCs, and `## Interface-<Type>:` lines (counted as a TOC with
  that suffix), decide by their interface lists: `yes` if one lists an
  interface in the flavor's range, `unknown` if one has no interface list,
  else `no`. A TOC whose whole stem equals the folder name is unsuffixed
  (`BigWigs_Classic/BigWigs_Classic.toc`).

## Zip handling

- Use `fflate` (`unzipSync` or the streaming API). Reject entries with
  absolute paths or `..` segments.
- After extraction into a temp directory, normalise to a set of addon folders:
  a directory is an addon folder when it directly contains a `.toc` whose full
  stem, or base name before a flavor suffix, equals the directory name. Look
  at the top level first; if the top level is a single directory that is not an addon
  folder, descend one level. Error if nothing qualifies.
- Return the list of addon folder names and their paths.

## Installer

`install({ addon, resolved, zipBytesOrPath, targetDir, flavor, force, state, onEvent })`:

1. Download goes through the cache dir: `<cache>/<addon>/<releaseId>/<filename>`.
   Skip the download if the file exists, is a readable zip, and the sha256
   matches when a hash is known; a cached file that is not a readable zip is
   deleted and fetched again. Compute sha256 after download, and store only
   readable zips. A body shorter than its Content-Length is a network error.
2. Extract into `<targetDir>/.wowget-tmp-<random>/` so the final move is a
   rename on the same filesystem. Always remove the temp dir on exit.
3. Normalise to addon folders.
4. Flavor check per folder unless `resolved.flavorVerified` is true: `no`
   fails with a clear error; `unknown` fails unless `force`.
5. Ownership check: for each folder, if `<targetDir>/<folder>` exists and is
   not owned by this addon's active install, fail unless `force`.
6. Swap: for each folder, rename the existing one to
   `<targetDir>/.wowget-old-<random>/<folder>`, rename the new one in. If any
   rename fails, move the old ones back before rethrowing; if a folder cannot
   be moved back, keep the old directory and name it in the error. Remove the old set
   after success. Also remove folders from the previous active install that
   are not in the new set.
7. `state.recordInstall(...)`, which also removes the folders from any other
   active install, so a forced takeover leaves one owner.

`uninstall({ addon, targetDir, state })` removes the active install's folders
if they exist and calls `deactivateInstall`. Missing folders are not an error.

Emit events: `download:start/progress/done`, `extract`, `verify`, `swap`,
`done`, each with the addon name.

## Sources

```ts
interface Resolved {
  source: string;          // the manifest source string
  releaseId: string;       // GitHub: tag_name. URL: sha256 of the file.
  version: string;         // GitHub: release.json version, else tag_name, without a leading "v". URL: first 12 hex of sha256.
  filename: string;
  downloadUrl: string;
  publishedAt?: string;
  flavorVerified: boolean; // true when the source metadata named the flavor
  localPath?: string;      // URL source: already-downloaded file in the cache
}

interface Source {
  kind: "github" | "url";
  resolve(ctx: { flavor: Flavor; prerelease: boolean; pin?: string; http: Http; cacheDir: string }): Promise<Resolved>;
}
```

`parseSource("github:owner/repo")` and `parseSource("url:https://...")`.
Anything else is an error naming the supported forms.

### GitHub

- `GET https://api.github.com/repos/{owner}/{repo}/releases?per_page=30`, with
  `Accept: application/vnd.github+json` and `Authorization: Bearer $GITHUB_TOKEN`
  when set. Do not use `/releases/latest`; it hides pre-releases.
- Skip drafts. Skip pre-releases unless `prerelease` is true. If `pin` is set,
  pick the release whose `tag_name` equals it, else error.
- If the release has a `release.json` asset, fetch it. Its shape is
  `{ releases: [{ filename, nolib, metadata: [{ flavor, interface }] }] }`
  (extra keys exist and are ignored). Choose the entry whose `metadata` includes
  the wanted flavor, preferring `nolib: false`. Match the entry's `filename`
  to the asset with that name. `flavorVerified = true`.
- Without `release.json`: consider assets ending in `.zip`. One zip: use it
  with `flavorVerified = false`. Several: prefer a filename containing the
  flavor name (case-insensitive; for forever also accept `camelot`), else
  error listing the asset names.
- If the chosen release has no usable zip, error with the release URL.
- 403 or 429 with a rate-limit header: error that says to set `GITHUB_TOKEN`.

### URL

- `GET` the URL with the cache's ETag as `If-None-Match`. On 304 reuse the
  cached file. Otherwise save the body to the cache dir under
  `<cache>/<addon>/<sha256>/<filename>` and store the ETag.
- `releaseId` is the sha256. `flavorVerified = false`.

### Http (ETag cache)

`http.getJson(url)` and `http.getBytes(url)`: look up `http_cache`, send
`If-None-Match`, on 304 return the cached body, on 200 store it. Only cache
bodies under 5 MB; larger responses bypass the cache. The implementation takes
a `fetch` function in its constructor so tests inject a fake.

## Commands (ops.ts, each returns a result object)

| Command | Behaviour |
|---|---|
| `init [--path P] [--flavor F]` | Create the manifest. Default path: the first existing of `/Applications/World of Warcraft/_forever_/Interface/AddOns` (creating `Interface/AddOns` if `_forever_` exists). Error if the manifest exists. |
| `add <source> [--name N] [--prerelease] [--pin ID]` | Error if the name exists. Resolve, install, then append to the manifest. If install fails nothing is written. |
| `remove <name>` | Uninstall, then splice from the manifest. Unknown name is an error. |
| `list` | No network. For each manifest addon: name, source, installed version or `not installed`, and status `ok`, `missing` (recorded folders absent on disk), or `not installed`. |
| `outdated` | For each addon: resolve and compare `releaseId` with the active install. Report `current`, `outdated` (with both versions), `not installed`, or `error` (with the message, and keep going). |
| `update [name...]` | Resolve and install when the release differs; no names means all. Pinned addons update only to the pin. Report per addon. |
| `install` | Install every manifest addon that has no active install. Skip the rest. |

Global flags: `--manifest <path>`, `--json`, `--force`, `--verbose`. Exit code
0 on success, 1 on any error, 2 on usage errors. `--json` prints the result
object; otherwise a compact aligned table or one line per addon.

Errors reach the CLI as `WowgetError` with a `code` and a message meant for a
person. Unexpected errors print the stack only with `--verbose`.

## Tests

- Manifest: parse valid file; unknown key error; append then re-parse; remove
  preserves comments and other blocks; remove the only addon; remove unknown
  name throws and leaves the file untouched.
- Flavor: TOC parsing with a list of interfaces; `folderSupportsFlavor` for
  suffixed, unsuffixed-with-interface, unsuffixed-without, and wrong-flavor.
- Zip: flat zip with two addon folders; nested single-dir zip; zip with no TOC
  errors; path traversal rejected. Build fixture zips in the test with
  `fflate.zipSync`.
- Installer: fresh install, update replaces folders and drops a removed
  folder, ownership conflict fails without force, uninstall. All against temp
  dirs and a temp state db, with a fake resolved release pointing at a local
  zip.
- State: migrations run once; `recordInstall` deactivates the previous row.
- GitHub source: fake fetch returning recorded JSON for releases and
  `release.json`; cases: release.json with forever; multiple zips without
  release.json; prerelease skipped and included; pin; rate-limited response.
- URL source: 200 then 304 path.
- Ops: `add` then `list` then `remove` end to end with the URL source served
  from a local `Bun.serve` on port 0.
- One opt-in live test, skipped unless `WOWGET_LIVE_TESTS=1`, resolving
  `github:Questie/Questie` for forever.

Cover the obvious cases. No change-detector tests. No mocks of the modules
under test; fake only the network and the file locations.
