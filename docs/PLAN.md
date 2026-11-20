# wowget: ideation and roadmap

`wowget` is a small CLI that installs, lists and updates
WoW addons from a declarative manifest, without CurseForge's client.

## Verdict

Feasible. The CLI part is small (download zip, extract, record what was installed,
compare versions). The only real risk is **where the addons come from**, because
CurseForge has deliberately made third-party access hard. Everything else is
plumbing.

## Facts that shape the design (verified 2026-11-01)

- **Local install.** `/Applications/World of Warcraft/` has `_forever_` (flavor
  `wowf`), `_classic_era_` and `_classic_beta_`. `_forever_/Interface/AddOns`
  does not exist yet; it appears after first launch. Forever launches 2026-11-04.
- **Forever addon identity.** TOC suffixes for Forever are `_Forever` and
  `_Camelot` (family suffix `_Mainline`). Interface number was `16001` during
  beta; the release value is not published yet. Classic Era addons do not load in
  Forever, so every addon needs a Forever-tagged build.
- **CurseForge API.** Requires an API key granted by application
  ("third-party modding services"). Authors can opt out of third-party
  distribution per project (`allowModDistribution: false`), and such files
  cannot be downloaded through the API. instawow's author notes keys are meant to
  be concealed, which is why open-source managers either proxy or ask the user
  for their own key. Scraping the website is fragile and against their terms.
- **Open sources that work without gatekeeping.**
  - GitHub releases: most big addons (Questie, WeakAuras, Details, DBM, Plater,
    Bartender, ElvUI mirror) publish via the BigWigs packager, which attaches a
    zip plus a `release.json` describing flavor/interface per file.
  - WoWInterface: JSON API (`api.mmoui.com/v3/game/WOW/filedetails/{id}.json`),
    direct downloads.
  - Wago Addons: API with a free developer key, per-flavor files.
  - Tukui: direct download for ElvUI/Tukui.
- **Prior art.** `instawow` (Python, GPL-3, CLI) already supports GitHub,
  CurseForge, WoWInterface, Tukui and Wago, keeps an install log and does
  rollbacks. WowUp is Electron with ads in the CurseForge build. Ajour is
  discontinued. Decide early whether to build or just use instawow (see
  Milestone 0).

## Product shape

Think `Brewfile` for addons, not an app store.

### Manifest (source of truth, lives in dotfiles)

```toml
# ~/.config/wowget/addons.toml
[install.forever]
path = "/Applications/World of Warcraft/_forever_/Interface/AddOns"
flavor = "forever"

[[addon]]
name = "Questie"
source = "github:Questie/Questie"

[[addon]]
name = "WeakAuras"
source = "github:WeakAuras/WeakAuras2"

[[addon]]
name = "TomTom"
source = "wowi:7032"

[[addon]]
name = "Some CF-only addon"
source = "curse:12345"
pin = "file:789012"       # optional
```

### Lock file (machine state, next to the manifest or in the AddOns dir)

Per addon: source, resolved release id (GitHub release id / CF file id / WoWI
version string), zip sha256, timestamp, and the list of top-level folders the
zip produced. The folder list is essential: one zip often creates several
addon folders (DBM, Details, ElvUI), and that is what `remove` and `update`
must delete.

### Commands

| Command | Does |
|---|---|
| `wowget add <source>` | Add to manifest, resolve, install |
| `wowget remove <name>` | Delete the folders recorded in the lock, drop from manifest |
| `wowget list` | Manifest vs lock vs disk, with status (ok, outdated, missing, unmanaged) |
| `wowget outdated` | Check every source for a newer release, no changes |
| `wowget update [name\|--all]` | Install newer releases, atomically |
| `wowget install` | Make disk match the manifest (fresh machine) |
| `wowget reconcile` | Scan AddOns for hand-installed addons, match via TOC `X-Curse-Project-ID`, `X-Wago-ID`, `X-WoWI-ID`, `X-GitHub`, offer to adopt |
| `wowget pin/unpin` | Freeze a release |
| `wowget rollback <name>` | Reinstall the previous lock entry from cache |
| `wowget doctor` | Verify paths, flavor, interface number vs installed TOCs |

### Core rules

- Resolve updates by **source-specific release identifier**, not by parsing
  version strings. Versions across sources are not comparable.
- Install is **atomic**: download to cache, verify hash, extract to temp, swap
  folders in, keep the previous zip for rollback.
- Never touch `WTF/` or `SavedVariables`.
- Never delete a folder the lock file did not create.
- Per-source adapters share one interface: `resolve(spec, flavor) -> Release`,
  `download(Release) -> path`. Adding a source is one file.
- Use HTTP conditional requests (ETag) and a small cache so `outdated` is cheap
  and stays under GitHub's unauthenticated rate limit (60/h). Allow an optional
  GitHub token.

## Flavor handling

Forever is new, so each source identifies it differently, and some addons will
not be tagged yet at launch. The resolver should:

1. Prefer a file tagged for the install's flavor (Forever).
2. Fall back to a file whose zip contains a `_Forever.toc` or `_Camelot.toc`
   (inspect the zip listing) or an `## Interface:` list containing the current
   Forever interface number.
3. Otherwise refuse with a clear message rather than install a Classic Era
   build that will not load.

Verify at launch: the exact flavor string the BigWigs `release.json` uses for
Forever (`forever` or `camelot`), the CurseForge game-version-type id for
Forever, and Wago's game-version id.

## Source priority

1. **GitHub releases** - open, covers most addons you want, has structured
   `release.json`. Build first.
2. **WoWInterface** - open JSON API, direct downloads. Cheap second source.
3. **Wago Addons** - free API key, good Forever coverage expected since Wago
   pushed Forever support. Third.
4. **Direct URL** - escape hatch: a zip URL, update check by ETag/Last-Modified.
   Trivial, add with (1).
5. **CurseForge** - last, behind a user-supplied key, honoring
   `allowModDistribution`. Apply for the key on day one because approval takes
   days and may be refused. If refused, the addon list decides whether that
   matters at all.

## Roadmap

### Milestone 0: Spike (half a day, do before launch)

- List the addons you actually want for Forever. Likely 5 to 15.
- For each, find where a Forever build is published. Expect GitHub for most.
- Fetch one real `release.json` and one Wago API response for a Forever addon;
  write down the flavor identifiers.
- Apply for a CurseForge API key (runs in the background).
- Try `instawow` for one hour with the same list. If it handles Forever, the
  question becomes "do I want to build this anyway". Building is still
  worthwhile for a manifest-in-dotfiles workflow, but go in knowing that.

Exit: a table of addon -> source -> Forever build available (yes/no).

### Milestone 1: MVP (one or two evenings, target launch day)

- Manifest + lock file.
- Sources: GitHub releases, direct URL.
- `add`, `remove`, `list`, `outdated`, `update`, `install`.
- Atomic install, folder tracking, hash verification.
- Single install target (`_forever_`).

Exit: your Forever addon set is installed and `wowget update` keeps it current.

### Milestone 2: Breadth (one evening)

- WoWInterface and Wago sources.
- `reconcile` for anything you installed by hand before the tool existed.
- Rollback from cached zips.
- Multiple install targets (Classic Era profile).

### Milestone 3: CurseForge (one evening, only if M0 shows you need it)

- `curse:` source with user-supplied key from env or config.
- Respect `allowModDistribution`; print the project URL for manual install
  when it is false.
- `pin`.

### Milestone 4: Nice to have

- `search` across sources (the part you said you do not need yet). Specified
  in [SPEC-SEARCH.md](SPEC-SEARCH.md): curated registry, WoWInterface
  catalogue, optional GitHub topic search.
- `doctor`, interface-number drift warnings after patches.
- Run `outdated` as a launchd job and notify.

## Stack

You have Bun/Node and Python installed, no Go or Rust. Recommendation:
**TypeScript on Bun**, compiled to a single binary with `bun build --compile`.
Reasons: matches your other projects, built-in fetch, zip handling via a small
dependency, no runtime to install on a fresh Mac. Python with `uv` is the
equal alternative and is what instawow uses, which makes borrowing their
source-adapter logic easier. Go would give the cleanest single binary but means
a new toolchain.

Shape: one package, `src/sources/{github,wowi,wago,curse,url}.ts` behind a
common interface, `src/manifest.ts`, `src/lock.ts`, `src/install.ts`,
`src/cli.ts`. Tests on the resolver and the install/lock logic with fixture
zips; sources tested against recorded responses.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| CurseForge key refused or slow | Some addons unreachable | Open sources first; `allowModDistribution` opt-outs are unreachable regardless, so the manual-install fallback is needed anyway |
| Forever flavor identifiers unknown or inconsistent across sources | Wrong build installed | Zip TOC inspection as fallback; refuse rather than guess |
| Authors slow to tag Forever at launch | Nothing to install | Not a tool problem; `url:` source lets you point at a beta build meanwhile |
| Zips with nested or multiple top-level folders | Broken installs | Normalise on extract: find folders containing a `.toc`, treat each as an addon folder |
| Release interface number changes after launch | TOC warnings in game | `doctor` reads `.build.info` and compares |
| Scope creep into a GUI/store | Never finishes | Manifest-first design keeps it a CLI; search is M4 |

## Open questions for you

- Which addons, concretely? This decides whether CurseForge is needed at all.
- One install target (Forever) or also Classic Era?
- Build it, or use instawow and spend the evenings playing? Both are defensible.

## Decisions (2026-11-01)

- **No CurseForge integration.** Milestone 3 is dropped. CurseForge-only
  addons show as unmanaged in `reconcile`; `url:` is the escape hatch.
- **Sources, in order:** GitHub releases, direct URL, WoWInterface. Wago is
  optional later (free key required, so it is not "no key").
- **GitHub specifics:** cache ETags (304s do not count against the 60/h
  unauthenticated limit); per-addon `prerelease = true` flag because the
  latest-release endpoint skips pre-releases.
- **Stack:** Bun + TypeScript, `bun build --compile`. Zip via `fflate`.
- **Architecture:** core library with no console I/O (resolve, plan, apply,
  progress events); CLI is a thin layer; a TUI (Ink or OpenTUI) can be added
  later as a second layer over the same core.
- **State:** manifest stays TOML in dotfiles (intent, pins, committed).
  `bun:sqlite` holds machine-local, rebuildable state at
  `~/Library/Application Support/wowget/state.db`: `installs`,
  `install_folders`, `http_cache`, `release_cache`. Migrations via
  `PRAGMA user_version`.
- **`add` and `remove` write the manifest.** Decided 2026-11-01. The file
  must survive hand edits, so the tool never round-trips it through
  parse/stringify (that drops comments and reorders keys). Instead:
  - `add` appends a new `[[addon]]` block as text at the end of the file.
  - `remove` and `pin` locate the target `[[addon]]` block by its byte range
    (a parser that reports positions, e.g. `toml-eslint-parser`, or a small
    line scanner over `[[addon]]` headers) and splice only that range.
  - After every write, re-parse the file and refuse the write if it no
    longer parses or the addon set is not what was expected.
  - Reading uses Bun's native TOML import or `smol-toml`.
- **Terminal UI.** Decided 2026-11-02. A TUI on OpenTUI is the first
  interface for users who do not want the commands; see
  [SPEC-TUI.md](SPEC-TUI.md). It stays a layer over the same core and
  manifest, so it is not the GUI/store in the risk table.

## Decisions (2026-11-20)

These replace the **Stack**, **State** and manifest-writing decisions of
2026-11-01, the OpenTUI choice of 2026-11-02, and the registry file and issue
flow of SPEC-SEARCH.md and SPEC-REGISTRY-SUGGEST.md. Details in
[SPEC-POWERSHELL.md](SPEC-POWERSHELL.md) and [SPEC-SERVICE.md](SPEC-SERVICE.md).

- **Why the stack changes.** Windows 11 Smart App Control blocked
  `wowget self-update` on a machine in enforcement mode: the compiled Bun
  binary is a new unsigned file on every release, and Smart App Control only
  runs executables that are signed or known to Microsoft's reputation service.
  Paying for code signing is ruled out. Running the project's code as scripts
  on a runtime its vendor signs passed the same check (Bun's signed `bun.exe`
  with a bundled `.js`, zero Code Integrity events, 2026-11-20). Phase 0 of
  SPEC-POWERSHELL.md repeats the test with the pinned PowerShell.
- **Runtime: PowerShell 7 LTS, shipped privately on every platform.** Chosen
  over Node, Python, Java and Bun because Windows is the main platform,
  PowerShell is Microsoft's own and every binary in the checked Windows
  package is signed by Microsoft. Users install nothing first. The costs
  include about 110 MB for the first Windows download and slower startup.
  Keeping one PowerShell version gives the client one test matrix.
- **Command-only client.** Retire OpenTUI and drop the planned Terminal.Gui
  port. Use a compact, Git-style summary for an explicit sync, with
  optional terminal color and structured JSON output.
- **Formats: JSON for the manifest, marker files for state.** `wowget.json`
  replaces `wowget.toml`; comments in the manifest are no longer possible. A
  `.wowget.json` marker in every installed addon folder replaces `state.db`,
  so the manifest, the markers and a rebuildable cache are the whole local
  state. The TOML manifest is converted once; `state.db` is not migrated
  (rollback history is lost).
- **A wowget service.** Release resolution, search, the registry and
  registry suggestions move to a Cloudflare Worker in this repository. The
  client depends on it for resolution and search, with no fallback that talks
  to GitHub or WoWInterface directly; `url:` sources stay in the client. The
  registry moves from `registry/addons.toml` to the service database, managed
  through a private admin interface behind Cloudflare Access. Suggestions go
  to a queue there instead of GitHub issues.
- **Account-free by default.** The CLI uses public search and resolution
  and keeps its inventory local. Reconciliation uses local metadata and
  the registry snapshot. Dotfiles keep working through `WOWGET_MANIFEST`.
- **Public web catalogue and optional dashboard.** Anyone can browse and
  search. Users can create a passkey account without an email address or
  phone number, save a recovery code, and approve each device in the browser
  with `wowget login`. The dashboard shows last reported versions per device
  and lets users queue add, remove and update operations. The local CLI
  applies them only during an explicit `wowget sync` and reports the outcome.
  The service can read the limited fields synced for this feature.
- **Catalogue contributions.** During installation and device approval,
  explain that enrolled devices contribute public addon IDs on explicit
  sync by default and show how to opt out. Validate candidates and publish
  verified public metadata in batches, without linking it to contributors.
  Deliberate `wowget suggest` submissions remain available without accounts.
- **Service operations on Cloudflare.** Cron Triggers and D1 run catalogue
  imports, registry and suggestion verification, and housekeeping. GitHub
  Actions handles development, deployment and releases. Benchmark the
  full catalogue and representative ZIP work in phase 0. Use Workers
  Paid if the full jobs cannot run reliably within Free limits.
- **Release order.** Ship the account-free CLI with public search and
  resolution before the dashboard and device sync.
- **Signed releases.** The project signs each release zip with its own ECDSA
  key, and clients verify it before updating. This is not Authenticode and
  does not involve Windows; it stops the service, or a tampered download, from
  pushing code to clients.
- **One public repository** for client and service. The service's defences do
  not depend on its code being private; secrets live in Cloudflare and GitHub.
