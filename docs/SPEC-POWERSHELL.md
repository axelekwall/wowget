# PowerShell client

Replaces the Bun and TypeScript client. Where this file disagrees with
SPEC-MVP.md, SPEC-TARGETS-WINDOWS.md, SPEC-SEARCH.md, SPEC-REGISTRY-SUGGEST.md
or SPEC-TUI.md, this file wins. The server side is in
[SPEC-SERVICE.md](SPEC-SERVICE.md). The reasons are in PLAN.md, "Decisions
(2026-11-20)".

## Why

Windows 11 Smart App Control blocks executables that are neither signed nor
known to Microsoft's cloud reputation service. `bun build --compile` produces a
new unsigned file for every release, and Smart App Control blocked
`wowget self-update` on a Windows 11 machine in enforcement mode (Code
Integrity events 3077 and 3118, policy `VerifiedAndReputableDesktop`). A
binary built by the project cannot get past it without a code-signing
certificate, which the project does not buy.

A runtime whose vendor signs it can run the project's code as plain script
files. That principle passed on the same machine with Bun's signed `bun.exe`
running a bundled `.js` (no Code Integrity events). Every executable and DLL
in PowerShell 7's Windows package is signed by Microsoft (546 of 546 in 7.7.0,
checked 2026-11-20; phase 0 repeats the check and the Smart App Control test
for the pinned 7.6 package), and PowerShell runs on macOS and Linux from a
relocatable tarball. The terminal UI library Terminal.Gui 1.16.0 ships signed
by Microsoft inside `Microsoft.PowerShell.ConsoleGuiTools` 0.7.7.

## Goals

1. wowget installs and runs on Windows 11 with Smart App Control on, with
   nothing for the user to install first and no binary the project builds.
2. The same scripts run on Windows and macOS, and on Linux as a side effect.
3. Every command the Bun client has keeps working, with the same names and
   flags.
4. The client is small: release resolution, search, the registry and
   suggestions move to the wowget service. Local state is the manifest and
   marker files in the addon folders.
5. Formats are ones PowerShell reads natively: JSON instead of TOML, files
   instead of SQLite.

## Runtime and distribution

### Runtime

- PowerShell **7.6 LTS** (7.6.10 today), Microsoft's official archives:
  `PowerShell-<v>-win-x64.zip`, `powershell-<v>-osx-arm64.tar.gz`,
  `-osx-x64.tar.gz`, `-linux-x64.tar.gz`, `-linux-arm64.tar.gz`. The client
  moves to the next LTS line once it is out and tested.
- Each wowget release pins one runtime version in `runtime.json`, with the
  download URL and SHA-256 of every platform archive.
- The runtime is private to wowget. Nothing uses or changes a PowerShell the
  user installed, Homebrew, winget or the system PATH beyond wowget's own
  launcher.
- Windows PowerShell 5.1 is not supported. Terminal.Gui needs PowerShell 7.2
  or newer, and one language version on every platform keeps one test matrix.

### Release artifact

One platform-neutral zip per release, `wowget-<version>.zip`:

```
Wowget/               the PowerShell module (see "Code layout")
lib/                  Terminal.Gui.dll, NStack.dll and the ConsoleGuiTools
                      DLLs, vendored from the module's PowerShell Gallery
                      package, all signed by Microsoft
registry.json         snapshot of the service registry, the offline fallback
runtime.json          pinned runtime version, URLs and SHA-256 per platform
wowget.ps1            entry point
LICENSE, THIRD-PARTY-NOTICES.txt
```

The release also publishes `wowget-<version>.zip.sha256`,
`wowget-<version>.zip.sig`, `install.ps1` and `install.sh`. Nothing is
compiled and there is one artifact for every platform.

`runtime.json` inside the zip is the only place the runtime version and its
archive hashes are defined. The installers and self-update read it from the
verified zip.

### Release signature

Releases are signed so that neither the service nor a tampered download can
push code to clients:

- The release workflow signs the zip's SHA-256 with an ECDSA P-256 key
  (`ECDsa.SignHash`, DER encoding of the signature in `.sig`). The private key
  is a GitHub Actions secret used only by the release job.
- The public key is a constant in the module and in both installers.
  Self-update refuses a zip whose signature does not verify with it.
- The first install trusts the installer script fetched over HTTPS from this
  repository. Every later update is checked against the key that install put
  on disk.
- Replacing the key needs a release signed with the old key that carries the
  new one.
- `ECDsa` is built into .NET, so verification needs nothing extra.

### Layout on disk

| | Windows | macOS and Linux |
|---|---|---|
| Install root | `%LOCALAPPDATA%\wowget\` | `~/.local/share/wowget/` (`$XDG_DATA_HOME/wowget` when set) |
| Runtime | `<root>\runtime\<version>\` | `<root>/runtime/<version>/` |
| App | `<root>\app\<version>\` | `<root>/app/<version>/` |
| Active versions | `<root>\current` (one line: `<app version> <runtime version>`) | `<root>/current` |
| Launcher | `<root>\bin\wowget.cmd`, on the user PATH | `~/.local/bin/wowget` |

`WOWGET_INSTALL_DIR` overrides the install root, as today.

### Launchers

Windows, `wowget.cmd`:

```bat
@echo off
setlocal
for /f "usebackq tokens=1,2" %%a in ("%~dp0..\current") do (set "APP=%%a" & set "RT=%%b")
"%~dp0..\runtime\%RT%\pwsh.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass ^
  -File "%~dp0..\app\%APP%\wowget.ps1" %*
```

macOS and Linux, `wowget` (`sh`): reads the two words from `current` the same
way and `exec`s the runtime.

- The launchers never change after install. Both versions come from
  `current`, which self-update replaces in one atomic write, so the app and the
  runtime always switch together.
- Known costs of a `.cmd` launcher, to be measured in phase 0: Ctrl+C during a
  command makes cmd ask "Terminate batch job (Y/N)?", and cmd's own parsing
  of the arguments applies (`^`, and `%` in unquoted arguments). Quoting
  `url:` sources avoids the second. If phase 0 finds the prompt unacceptable,
  the alternatives are a `.lnk` shortcut that starts `pwsh.exe` directly for
  the TUI, and documenting Ctrl+C. A launcher executable is not one, since it
  would be an unsigned binary again.
- `-ExecutionPolicy Bypass` because the Windows default policy blocks
  unsigned `.ps1` files. It applies to this process only.
- The launcher does not change the working directory. The module finds its
  own files from `$PSScriptRoot`, and user paths are resolved against the
  directory the command was started in, as today.
- A double-click on `wowget.cmd` opens the TUI, as the TUI spec required of
  `wowget.exe`. A Start menu shortcut is not in scope.

### Installers

`install.ps1` (Windows, `irm <url> | iex`) and `install.sh` (macOS and Linux,
`curl -fsSL <url> | sh`):

1. Pick the version: `WOWGET_VERSION` when set, else the latest release from
   `GET /v1/version` on the service (see SPEC-SERVICE.md), else GitHub's
   latest release of this repository.
2. Download `wowget-<version>.zip` and its `.sig` from this repository's
   GitHub release (the URL is built from the version, never taken from the
   service) and verify the signature with the embedded public key.
3. Read `runtime.json` from the zip, download this platform's runtime archive
   from Microsoft's PowerShell release, and check its SHA-256.
4. Extract into `runtime/<version>` and `app/<version>` through a temp
   directory and a rename, write the launcher, then write `current`.
5. Windows: add `<root>\bin` to the user PATH if missing. macOS and Linux:
   print a note when `~/.local/bin` is not on PATH.
6. Remove files left by the Bun client: `bin\wowget.exe`, `bin\wowget.exe.old`,
   `bin\.wowget.exe.new-*` on Windows, and `~/.local/bin/wowget` when it is a
   Mach-O or ELF binary on macOS and Linux.

### Self-update

`wowget self-update [--check] [--force]`:

1. `GET /v1/version` for the latest version number (GitHub's latest release
   when the service is unreachable). Equal or older than the running version:
   report `current`, unless `--force`, which reinstalls the latest version.
   `--check` reports `available` or `current` and stops.
2. Download the zip and `.sig` from this repository's GitHub release, verify
   the signature (see "Release signature"), extract into `app/<new>`.
3. If the new `runtime.json` pins a runtime that is not on disk, download it
   from Microsoft's release, check its SHA-256, extract into
   `runtime/<new runtime>`.
4. Run `<new runtime> <app/new>/wowget.ps1 --version` and require the new
   version string.
5. Write `current` (`<new app> <new runtime>`) atomically. This is the
   switch: a crash before it leaves the old app on the old runtime, since the
   launcher reads both from this file.
6. The next run of any command removes app and runtime directories that are
   neither current nor the previous version.

Only data files and archives from Microsoft and from this project's releases
are written. No executable built by the project exists, so Smart App Control
has nothing to block. Scripts are not locked while they run, so the update
works while wowget runs.

### Size and speed

- First install: about 110 MB download on Windows, 70 MB on macOS. Updates
  that keep the runtime: the app zip, a few hundred KB.
- PowerShell starts in roughly 0.3–0.6 s. Every command pays it once. Measure
  in phase 0 and record the numbers here.

## Code layout

```
client/
  Wowget/
    Wowget.psd1, Wowget.psm1     module manifest and loader
    Paths.ps1                    locations, env overrides, game directory candidates
    Manifest.ps1                 read, validate, write wowget.json; TOML import
    Markers.ps1                  read and write .wowget.json markers
    Api.ps1                      wowget service client (resolve, registry, search, version, suggestions)
    Http.ps1                     one Invoke-WowgetHttp function; the only network call site
    UrlSource.ps1                url: sources
    Zip.ps1                      extraction and addon-folder normalisation
    Flavor.ps1                   flavors, TOC parsing, folderSupportsFlavor
    Installer.ps1                download cache, stage, swap, rollback, uninstall
    Ops.ps1                      one function per command, returns objects
    Reconcile.ps1, Doctor.ps1    as today, over markers
    Sync.ps1                     sharing: tokens, crypto, merge
    SelfUpdate.ps1
    Cli.ps1                      argument parsing, formatting, --json, exit codes
    Tui.ps1                      Terminal.Gui screens
  wowget.ps1                     entry point: imports the module, calls Cli
  tests/                         Pester 5 tests, mirroring the module
  install.ps1, install.sh
```

Rules carried over from the Bun client:

- Nothing outside `Cli.ps1` and `Tui.ps1` writes to the host. Ops return
  `[pscustomobject]` results and take an optional `-OnEvent` script block for
  progress events.
- Errors are `WowgetError` exceptions (a class in the module) with a `Code`
  and a message meant for a person. Codes stay as today: `usage`, `manifest`,
  `manifest_exists`, `duplicate`, `not_found`, `network`, `rate_limited`,
  `zip`, `flavor`, `conflict`, `locked`, `source`, `io`. Service errors map
  to them: `rate_limited` to `rate_limited` (the message gives the
  `Retry-After` time), `upstream` and a per-item `flavor` or `source` result to
  `source` or `flavor` for that row, anything else to `network`.
- `Http.ps1` is the only file that calls `Invoke-WebRequest`. Tests replace
  it with a fake through a module-scoped variable, the same role `fakeFetch`
  plays today.
- No `Add-Type` with C# source: it compiles an unsigned DLL at run time, which
  Smart App Control may block. Use cmdlets and existing .NET types only.
- File writes use .NET (`[IO.File]::WriteAllText` with UTF-8 without BOM) and
  are atomic. A path that is a symlink (a manifest kept in a dotfiles
  repository) is written through, as the Bun client does: resolve the final
  target first (`[IO.FileInfo]::new(path).ResolveLinkTarget($true)`), write
  `<target>.tmp` next to the target, then `[IO.File]::Move(tmp, target,
  $true)`. The symlink itself is never replaced. On macOS and Linux the
  target's file mode is copied to the new file (`[IO.File]::GetUnixFileMode`
  and `SetUnixFileMode`).

## Locations

| Thing | Windows | macOS | Linux | Override |
|---|---|---|---|---|
| Manifest | `%APPDATA%\wowget\wowget.json` | `~/.config/wowget/wowget.json` | `$XDG_CONFIG_HOME/wowget/wowget.json` | `--manifest`, `WOWGET_MANIFEST` |
| Machine state (`link.json`, `sync-base.json`, lock file) | `%LOCALAPPDATA%\wowget\state\` | `~/Library/Application Support/wowget/` | `$XDG_STATE_HOME/wowget/` | `WOWGET_STATE_DIR` |
| Cache | `%LOCALAPPDATA%\wowget\cache\` | `~/Library/Caches/wowget/` | `$XDG_CACHE_HOME/wowget/` | `WOWGET_CACHE_DIR` |
| Game directory | as SPEC-TARGETS-WINDOWS.md | | | `WOWGET_GAME_DIR`, `--game-dir` |
| Service | `https://api.wowget.dev` (placeholder until the domain is chosen) | | | `WOWGET_API_URL` |

`GITHUB_TOKEN` and `WOWGET_REGISTRY_URL` are no longer read: the service
talks to GitHub with its own token, and `WOWGET_API_URL` replaces the
registry URL. `WOWGET_API_URL=off` uses the registry snapshot and fails
resolution and search with a `network` error, which tests use.

## Local state

The complete local state of a machine:

1. **The manifest**: what should be installed where. Shared between machines.
2. **Marker files** in the installed addon folders: what is installed.
3. **The cache**: downloaded zips, kept for `rollback`, and `url:` source
   validators. Rebuildable.
4. **`link.json` and `sync-base.json`**, only when sharing is set up.

There is no database. `state.db` from the Bun client is not read.

### Manifest (`wowget.json`)

```json
{
  "version": 1,
  "targets": {
    "forever": { "folder": "_forever_", "flavor": "forever" },
    "era": { "folder": "_classic_era_", "flavor": "classic" },
    "laptop": { "path": "D:\\Games\\WoW\\_retail_\\Interface\\AddOns", "flavor": "mainline" }
  },
  "addons": [
    { "name": "Questie", "source": "github:Questie/Questie" },
    { "name": "WeakAuras", "source": "github:WeakAuras/WeakAuras2", "targets": ["era"] },
    { "name": "Foo", "source": "url:https://example.com/Foo.zip", "pin": "3f2a…" },
    { "name": "Bar", "source": "github:owner/bar", "prerelease": true }
  ]
}
```

- Same fields and rules as the TOML manifest (SPEC-MVP.md and
  SPEC-TARGETS-WINDOWS.md): target names, `path` or `folder`, `flavor`, addon
  `name` unique case-insensitively, optional `targets`, `pin`, `prerelease`.
- `version` is the format version, `1`. A higher number is a `manifest` error
  that says to update wowget. Unknown keys are a `manifest` error naming the
  key, as today.
- Comments are not supported. That is the cost of a native format.
- Writes rewrite the whole file: targets in insertion order, addons in
  manifest order, keys in the order shown above, two-space indentation, LF
  line endings, a final newline. After writing, the file is read back and must
  equal what was meant; otherwise the previous file is restored and the write
  fails, as today.
- The manifest is small (well under 64 KB), which the sharing service relies
  on.

### TOML import

The first command converts a TOML manifest when either:

- the manifest path, from `--manifest`, `WOWGET_MANIFEST` or the default,
  ends in `.toml`; or
- the default path (`wowget.json`) does not exist and `wowget.toml` exists in
  the same directory.

The reader accepts every TOML 1.0 document `Bun.TOML.parse` accepts that holds
the manifest's value types, since users may have edited the file by hand:

- basic and literal strings, single-line and multi-line, with every escape TOML
  defines;
- integers, floats and booleans (read, then rejected by validation where the
  manifest wants a string, as today);
- arrays over several lines with trailing commas, inline tables, dotted and
  quoted keys, standard tables and arrays of tables, comments.

Dates and times are a `manifest` error naming the line, since no manifest key
takes one. The reader is a separate file (`TomlImport.ps1`) used only here,
tested against every TOML file in the repository's test fixtures and against
the TOML test suite's valid cases for the types above.

Conversion:

- Resolves symlinks first and writes `wowget.json` next to the resolved TOML
  file, so a manifest kept in a dotfiles repository is converted inside that
  repository. The TOML file is left untouched.
- When the TOML path was a symlink, also creates a `wowget.json` symlink next
  to that link, pointing at the new file, on macOS and Linux. On Windows,
  where creating a symlink needs Developer Mode or administrator rights, it
  prints the path to point `WOWGET_MANIFEST` at instead.
- When `--manifest` or `WOWGET_MANIFEST` named the `.toml` file, the command
  runs on the converted manifest and tells the user to point the flag or
  variable at the `.json` file from now on.
- Prints that comments were dropped and that the old file can be deleted.

### Markers (`.wowget.json`)

wowget writes one marker into every addon folder it installs:

```json
{
  "version": 1,
  "addon": "Questie",
  "source": "github:Questie/Questie",
  "releaseId": "v11.4.2",
  "addonVersion": "11.4.2",
  "filename": "Questie-v11.4.2.zip",
  "sha256": "9c1f…",
  "folders": ["Questie", "QuestieDB", "QuestieTrace"],
  "installedAt": "2026-11-20T10:00:00Z",
  "previous": { "releaseId": "v11.4.1", "addonVersion": "11.4.1", "filename": "Questie-v11.4.1.zip", "sha256": "77ab…" }
}
```

- Every folder of an install carries the same marker, listing all of the
  install's folders.
- A folder belongs to the addon its marker names. The `target` is implied by
  the AddOns directory the folder is in, so the manifest's target names do not
  appear in markers.
- `list` reads the markers of each target's AddOns directory. No network.
- An install is **missing** folders when a folder in its `folders` list is
  absent or carries a marker for another addon.
- A forced install that takes over another addon's folder rewrites that
  folder's marker. The other addon then counts the folder as missing, which
  matches today's "displaced" rule.
- `previous` holds the install that this one replaced, so `rollback` can find
  its zip in the cache. One level of history, as `rollback` uses today.
- Folders without a marker are unmanaged: `reconcile` lists them, `update`
  and `remove` never touch them. Folders starting with `Blizzard_` are
  ignored.
- A marker that does not parse counts as no marker, and `doctor` reports it.
- A marker naming an addon that the manifest does not have on that target is
  **orphaned**: the addon was removed while that target was not on this
  machine, or on another machine of a shared manifest. `doctor` reports it as
  an issue (`orphan_marker`), naming the folders. `remove <name> -t <target>`
  also accepts such a name and deletes its folders. Nothing deletes them
  without being asked.
- WoW ignores files in addon folders it does not know. Copying an addon
  folder to another machine carries its marker, which is correct.

### Lock

Commands that write take an exclusive lock on `<state>/wowget.lock`
(`[IO.File]::Open` with `FileShare.None`), so two wowget processes never
install at once. A second process waits up to 10 seconds, then fails with a
`locked` error naming the lock file.

## Sources

| Source | Resolved by | Downloaded by |
|---|---|---|
| `github:<owner>/<repo>` | service `POST /v1/resolve` | client, from the URL the service returns |
| `wowi:<id>` | service `POST /v1/resolve` | client |
| `url:<https url>` | client | client |

- The client sends every `github:` and `wowi:` row of a command to
  `/v1/resolve` in one request (split into batches of the size the service
  allows), with the flavor of each row's target, `prerelease` and `pin`.
- A download URL from the service must be `https` and on an allowed host:
  `github.com`, `objects.githubusercontent.com`,
  `release-assets.githubusercontent.com`, `cdn.wowinterface.com` (the exact
  list is fixed in phase 0 from real responses). Anything else is a `source`
  error, and nothing is downloaded.
- Downloads follow redirects by hand (`-MaximumRedirection 0`, at most 5
  hops), and every hop must be `https` on an allowed host.
- The client verifies the `sha256` or `md5` the service returns, as today.
  When the service returns neither, the client records the SHA-256 it
  computed.
- `url:` sources behave as today (SPEC-MVP.md, "URL"): the release id is the
  file's SHA-256, validators are kept in `<cache>/http/<sha1 of url>.json`.
- The service being unreachable is a `network` error for `github:` and
  `wowi:` rows only. `url:` rows and every command that does not resolve
  (`list`, `remove`, `pin` with an explicit release, `doctor`, `reconcile`
  with the registry snapshot) keep working.
- The client removes duplicate items (same source, flavor, `prerelease` and
  `pin`) before sending, so two targets of one flavor cost one item.

## Installer

The steps of SPEC-MVP.md, "Installer", with markers in place of state rows:

1. Download into `<cache>/<addon>/<releaseId>/<filename>`, verify.
2. Extract into `<AddOns>/.wowget-tmp-<random>/` with
   `System.IO.Compression.ZipFile`, rejecting absolute paths and `..`.
3. Normalise to addon folders (unchanged rules).
4. Flavor check per folder unless the service returned `flavorVerified`.
5. Ownership check through markers.
6. Write the marker into every new folder, then swap folders in with the
   rollback and locked-file handling of today.
7. Remove folders of the previous install that are not in the new set.

Uninstall removes the folders whose marker names the addon. Cache pruning keeps
the zips named by current markers and their `previous` entries.

## Commands

Names, flags, outputs and exit codes stay as the Bun client's, except:

| Command | Change |
|---|---|
| `init`, `target *` | Write JSON. Otherwise unchanged. |
| `add <source \| name>` | Bare names resolve against the service registry (snapshot when offline). |
| `list` | Reads markers. |
| `outdated`, `update`, `install` | One `/v1/resolve` request per batch instead of per-addon lookups. |
| `pin`, `unpin`, `rollback` | Pins in the manifest as today; rollback reinstalls `previous` from the cache. `pin <name>` without a release on an install whose marker says `releaseId: "unknown"` is a `usage` error asking for a release or an `update` first. |
| `search` | `GET /v1/search`. `--github` stays. `--refresh` is accepted and ignored with a note, since the catalogue lives on the service. |
| `suggest [name...]` | Sends the manifest addons the registry lacks to `POST /v1/suggestions` and prints the result. No browser, no GitHub account. `--print` lists what would be sent and sends nothing. |
| `reconcile [--adopt]` | Unmanaged folders (no marker) are grouped and matched as today: registry `folders`, then TOC IDs (`X-GitHub`, `X-GitHub-Repo`, `X-Repository`, `X-Website`, `X-WoWI-ID`, and the `X-Curse-*` fields that only mark an addon as CurseForge). The WoWInterface catalogue match moves to `POST /v1/identify` on the service; offline, reconcile uses the registry snapshot and TOC IDs only and says so. `--adopt` writes markers. |
| `doctor [--clean]` | Adds marker checks: unparseable markers, an install whose folders disagree, orphaned markers. Keeps the `portable_target` hints. `--clean` prunes the cache. |
| `self-update [--check] [--force]` | See "Self-update". |
| `link …` | New, see "Sharing". |
| `migrate` | New. Runs the TOML import and the marker adoption below on request. Also runs by itself on first start. |
| `tui` | Terminal.Gui, see below. |

`--json` keeps the result shapes. Fields that came from state rows come from
markers now; `installedAt` keeps its meaning.

Kept unchanged, though not repeated above: global `--manifest`, `--json`,
`--force`, `--verbose`; repeatable `--target`/`-t` on the commands that take
it today; `--force` installing a folder whose flavor check is `unknown` and
taking over a folder another addon owns; `target:absent` events for targets
not on this machine; exit codes 0, 1 and 2.

### First start after the Bun client

1. TOML import (above).
2. Adoption, for every manifest addon on every target on this machine. The
   new client cannot read `state.db`, which recorded the exact folders, so it
   uses the download cache instead. The Bun client keeps the zips of every
   target's active and previous install there, in the layout the new client
   keeps (`<cache>/<addon, lower-case>/<release id>/<zip>`, same cache
   directory on each platform).
   1. For each cached release of the addon, list the addon folders its zip
      produces, with the installer's normalisation.
   2. Take the cached release whose folders all exist on the target without a
      marker. With several, take the one with the most folders, then the
      newest zip. Write markers with that release id (the cache directory's
      name), the zip's SHA-256 and its folder list, so the install is exact
      and needs no reinstall. Set `previous` to the next newest other cached
      release, so `rollback` keeps working.
   3. With no matching cached release (the cache was cleaned, or the folders
      differ), fall back to the folders a registry entry or a resolve of the
      source names, and write markers with `releaseId: "unknown"`. `outdated`
      reports such addons as `outdated`, and the next `update` reinstalls them
      and writes a real marker. Folders an older release used and the current
      one does not are not found this way; step 4 shows them.
   4. A folder two addons would claim is left without a marker and reported.
   Pins are kept, since they live in the manifest.
3. Rollback history beyond the cached `previous` zip is lost, because it lived
   in `state.db`.
4. The result lists what was converted and adopted, and how (cache or
   fallback), and then, per target, every folder still without a marker, so
   leftovers of older releases are visible and `reconcile` can handle them.
   `migrate --json` prints it.

## Terminal UI

- Terminal.Gui 1.16 from the vendored ConsoleGuiTools DLLs, loaded with
  `Add-Type -Path` on those signed files (loading, not compiling).
- Screens and behaviour as SPEC-TUI.md: first run, target tabs (`TabView`),
  the addon table (`TableView`, multi-select, mouse), action keys in a
  `StatusBar`, add through search, confirmations, progress, the error of the
  row under the cursor.
- Add, remove, pin, unpin and rollback, which SPEC-TUI.md planned as its next
  phase, come with the port, since Terminal.Gui has dialogs and text fields.
- Threading: Terminal.Gui runs its main loop on the PowerShell thread. Network
  work (`outdated`, `update`, search) runs in a separate runspace started with
  `[runspacefactory]::CreateRunspace()` and the module imported, and posts
  results back with `[Terminal.Gui.Application]::MainLoop.Invoke(...)`. A
  script block must never run on a thread without a runspace; event handlers
  stay on the main loop. Phase 0 proves this pattern.
- One operation at a time, as SPEC-TUI.md.
- `wowget tui --check` loads Terminal.Gui, prints `ok <os>-<arch>` and exits 0.
- Running `wowget` without a command in an interactive terminal opens the TUI,
  as today.

## Sharing

Commands over the link protocol in SPEC-SERVICE.md, "Links".

| Command | Behaviour |
|---|---|
| `link create` | Fails if a link exists. Uploads the manifest and prints the write token and the read-only token. Writes `link.json` and `sync-base.json`. Warns about `path` targets (see below) and suggests `target portable`. |
| `link join <token>` | Downloads the shared manifest. With no local manifest, writes it. With one, shows the difference and asks to replace or merge (`--replace`, `--merge` for scripts). Writes `link.json` and `sync-base.json`. |
| `link sync` | Pulls, merges and, on a read-write link, pushes. The other commands do the same implicitly (below). |
| `link status` | The link id (not the secret), read-only or read-write, the remote version, the time of the last pull and push, and local changes not yet pushed. |
| `link leave` | Deletes `link.json` and `sync-base.json`. The remote copy stays for the other machines. |
| `link rotate` | Read-write links only. Creates a new link with the current manifest, deletes the old one, prints the new tokens. Every other machine must join again. |

### When sync runs

- `add`, `remove`, `target add`, `target remove`, `target portable`, `pin`,
  `unpin`, `outdated`, `update`, `install` and `tui` sync first when the last
  pull is more than 5 minutes old. They already use the network. `list`,
  `doctor`, `reconcile` and `search` never sync, so `list` stays offline.
- Commands that change the manifest sync again after the change, so the
  change is pushed.
- Sync takes the write lock, since it may write the manifest.
- A sync that cannot reach the service warns once and the command goes on with
  the local manifest. Unpushed changes are pushed by the next sync.

### Sync on a read-write link

1. `GET` the link. Decrypt, and check that `seq` equals the returned version
   and is not lower than `remoteVersion` in `link.json`; otherwise stop with a
   `conflict` error that says the service returned an older copy.
2. Three-way merge of base (`sync-base.json`), local (the manifest file, which
   includes hand edits) and remote.
3. Write the merged manifest locally if it differs from local.
4. If the merged manifest differs from remote, `PUT` it with `If-Match` on the
   remote version and `seq` = remote version + 1. On `412`, start again from
   step 1, at most twice, then fail with a `conflict` error.
5. Write `sync-base.json` (the merged manifest) and update `link.json`.

### Sync on a read-only link

The remote copy replaces the local manifest; there is no merge. Commands that
change the manifest (`add`, `remove`, `target *`, `pin`, `unpin`) are a
`usage` error that names the link as read-only and points at `link leave`.
`update` and `install` work, since they do not change the manifest.

### Merge rules

- Addons are matched by name (case-insensitive), targets by name. An entry is
  compared as a whole: name, source, `targets`, `pin`, `prerelease` for an
  addon; `path` or `folder`, and `flavor` for a target.
- Changed on one side only: take that side. Changed the same way on both: take
  it once. Added on one side: add it. Removed on one side and unchanged on the
  other: remove it.
- Changed differently on both sides, or removed on one side and changed on the
  other: a conflict. The CLI asks which side to keep. With `--json` or without
  a terminal the command fails with a `conflict` error listing them, and
  nothing is written.
- Order: remote's order, then addons and targets added locally in their local
  order.
- The merged manifest must validate (for example, no addon may name a removed
  target) before it is written or pushed; otherwise it is a `conflict` error.

### Targets on linked machines

A shared manifest is meant to hold `folder` targets. A `path` target from
another machine usually names a directory that does not exist here, so on a
linked machine a `path` target whose directory does not exist counts as not on
this machine, with the same `target:absent` behaviour as a folder target.
Unlinked machines keep today's rule.

### Gone links

A `404` from the service means the link was rotated on another machine or
deleted after 12 months without use. The command warns once, `link status`
shows the link as gone, and nothing more is synced until `link join` with a new
token or `link leave`.

### Files and limits

`link.json`:

```json
{ "version": 1, "token": "wg1-rw-…", "linkId": "…", "remoteVersion": 7, "pulledAt": "…", "pushedAt": "…" }
```

- Written with permissions for the current user only (`chmod 600` on macOS
  and Linux; an ACL with only the current user on Windows). It never goes into
  the manifest, which may live in a public dotfiles repository.
- The manifest JSON may be at most 40 KB to be shared, so the encrypted and
  base64url-encoded envelope stays under the service's 64 KB limit. A larger
  manifest is a `usage` error on push.
- The crypto uses `System.Security.Cryptography.HKDF`, `AesGcm` (constructed
  with a 16-byte tag size) and `RandomNumberGenerator` from .NET, which
  PowerShell 7.6 runs on. Phase 0 checks `AesGcm.IsSupported` on macOS. The
  shared test vectors in `test-vectors/` fix every byte (see SPEC-SERVICE.md).

## Tests and CI

- Pester 5 and PSScriptAnalyzer, installed in CI only; they are not shipped.
- CI runs the tests on `ubuntu-latest`, `windows-latest` and `macos-latest`,
  each with the pinned PowerShell from `runtime.json`, not the runner's.
- Test rules carry over: `TestDrive:` or temp directories passed explicitly,
  never the real manifest, cache or AddOns folders; the fake
  `Invoke-WowgetHttp` instead of the network; live tests only with
  `WOWGET_LIVE_TESTS=1`.
- A smoke job on `windows-latest` runs the release zip through `install.ps1`
  into a temp root and runs `wowget --version` and `wowget tui --check`.
- The sharing crypto has fixed test vectors shared with the service tests, so
  both sides agree byte for byte.

## Phases

0. **Prototype**, before any port. On a Windows 11 machine with Smart App
   Control on, and on macOS:
   - the pinned 7.6 runtime from Microsoft's archive, with every binary's
     signature checked;
   - started through the real `wowget.cmd` and `sh` launchers, with Ctrl+C and
     quoted and unquoted `url:` arguments tried;
   - a module made of dot-sourced `.ps1` files;
   - a zip download following redirects through the host allowlist, extraction,
     markers and a JSON manifest;
   - Terminal.Gui loaded with `Add-Type -Path` and a table filled from a
     background runspace;
   - an `AesGcm` and `HKDF` round trip against the test vectors, and an
     `ECDsa` signature check.

   Check the Code Integrity log on Windows. Measure start-up time. Exit: no
   Smart App Control event, the TUI threading works, the numbers recorded
   here.
1. **Core and CLI** with `url:` sources and the service's `/v1/resolve`,
   `/v1/registry` and `/v1/version`: every command except `search`,
   `suggest`, `link` and `tui`. TOML import and adoption.
2. **Search and suggestions** against the service.
3. **TUI.**
4. **Sharing.**
5. **Switch**: release as `1.0.0` (`feat!`), installers replaced, the Bun
   client and its build removed from the repository, README and AGENTS.md
   rewritten.

## Not in scope

- A graphical UI outside the terminal.
- Windows PowerShell 5.1.
- Signing the scripts. Smart App Control does not restrict an unsigned local
  `.ps1` (it ran in FullLanguage mode in the 2026-11-20 test), and the
  launcher passes `-ExecutionPolicy Bypass`.
- Keeping the Bun client working beside the PowerShell client after the
  switch.

## Open questions

- Terminal.Gui 1.16 is the maintenance line. Moving to v2 needs either a new
  ConsoleGuiTools release or a signed Terminal.Gui v2 DLL from NuGet. Check
  the v2 package's signature before phase 3.
- Smart App Control evaluation of `Add-Type -Path` on the vendored DLLs: they
  are signed, but the prototype must show no event.
- Whether the old Bun binaries should get a last release that tells users to
  reinstall with the new installer. They cannot update themselves on machines
  where Smart App Control blocks them anyway.
