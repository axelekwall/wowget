# PowerShell client

Replaces the Bun and TypeScript client. Where this file disagrees with
SPEC-MVP.md, SPEC-TARGETS-WINDOWS.md, SPEC-SEARCH.md, SPEC-REGISTRY-SUGGEST.md
or SPEC-TUI.md, this file wins. The rewrite retires the terminal UI.
The server side is in [SPEC-SERVICE.md](SPEC-SERVICE.md). The reasons are in PLAN.md, "Decisions
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
relocatable tarball.

## Goals

1. wowget installs and runs on Windows 11 with Smart App Control on, with
   nothing for the user to install first and no binary the project builds.
2. The same scripts run on Windows and macOS, and on Linux as a side effect.
3. Keep the existing non-TUI commands, with the same names and flags except
   where noted below. The local client is command-only.
4. The client is small: release resolution, search, the registry and
   suggestions move to the wowget service. Local state is the manifest and
   marker files in the addon folders.
5. Formats are ones PowerShell reads natively: JSON instead of TOML, files
   instead of SQLite.
6. The default workflow needs no account and uploads no inventory or install
   state. Public search and resolution receive the inputs needed for each
   request. The optional web dashboard manages an enrolled device on its next
   explicit `wowget sync`.

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
- Windows PowerShell 5.1 is not supported. One language version across
  platforms keeps one test matrix.

### Release artifact

One platform-neutral zip per release, `wowget-<version>.zip`:

```
Wowget/               the PowerShell module (see "Code layout")
registry.json         snapshot of the service registry, the offline fallback
runtime.json          pinned runtime version, URLs and SHA-256 per platform
wowget.ps1            entry point
release-public-key.txt  the release public key (see "Release signature")
launchers/            wowget.cmd and wowget.sh, which the installers copy
LICENSE, THIRD-PARTY-NOTICES.txt
```

`client/build-release.ps1 -Version <v>` builds the zip, its `.sha256` and
`.sig`, and the installers with the public key filled in. `registry.json` is
the service's `/v1/registry` response passed with `-RegistryJson`, or else
built from `registry/addons.toml` in the same document shape (its `version` a
content hash, as the service's is). The launchers ship in the verified zip so
that the installers stay small and carry no copy of them.

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
- The public key is defined once, in `client/release-public-key.txt` (base64
  SubjectPublicKeyInfo). The build script copies it into the zip, where the
  module reads it from the app directory, and fills it into both installers.
  Self-update refuses a zip whose signature does not verify with it. Until the
  maintainer creates the key, the file holds a placeholder, and the build
  script refuses to build. The build script also refuses a signing key that
  does not belong to that public key.
- `install.ps1` runs in Windows PowerShell 5.1, whose .NET Framework lacks
  `ImportSubjectPublicKeyInfo`, so it verifies through CNG (`ECDsaCng` with
  the key as an `ECCPUBLICBLOB` and the DER signature converted to r||s).
  `install.sh` verifies with `openssl dgst -sha256 -verify`, so it needs
  `openssl`, as well as `curl`, `unzip` and `tar`.
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

`WOWGET_INSTALL_DIR` overrides the install root. For the Bun client it named
the directory of the binary, so the installers also remove a Bun binary found
directly in it. Self-update and the installers also write `<root>/previous`
with the line `current` held before a switch to another app version; the
clean-up keeps the versions both name. It runs only while the command holds
the write lock, and it keeps directories changed in the last hour, since an
installer (which takes no lock) may be about to switch to them. It also
removes the `.update-*` and `.install-*` directories that interrupted runs
left in the root.

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
way and `exec`s the runtime. The install root is written into it at install
time, since `~/.local/bin` is outside the root. On Linux it sets
`DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` when no `libicuuc.so*` is found in
the usual library directories and the variable is not set already.

- The launchers never change after install. Both versions come from
  `current`, which self-update replaces in one atomic write, so the app and the
  runtime always switch together.
- Known costs of a `.cmd` launcher, to be measured in phase 0: Ctrl+C during a
  command makes cmd ask "Terminate batch job (Y/N)?", and cmd's own parsing
  of the arguments applies (`^`, and `%` in unquoted arguments). Quoting
  `url:` sources avoids the second. If phase 0 finds the prompt unacceptable,
  document it or revisit the launcher in phase 0 within the signed-runtime
  requirement.
- `-ExecutionPolicy Bypass` because the Windows default policy blocks
  unsigned `.ps1` files. It applies to this process only.
- The launcher does not change the working directory. The module finds its
  own files from `$PSScriptRoot`, and user paths are resolved against the
  directory the command was started in, as today.

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
7. Explain that installation and normal use need no account or inventory
   upload. Explain that if the user later enrolls a device, explicit sync
   contributes public addon IDs to the catalogue by default. Show how to
   opt out during install or later. The installer accepts
   `WOWGET_CATALOGUE_CONTRIBUTIONS=off` to save an opt-out before enrollment.

Implementation notes:

- The opt-out is `<state>/contributions.json`,
  `{ "version": 1, "catalogueContributions": "off" }`, in the machine state
  directory of "Locations" (`WOWGET_STATE_DIR` when set). Phase 4 reads it.
- `install.sh` sets `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` for its own run of
  the runtime when libicu is missing, and says so.
- The Bun client's `~/.local/bin/wowget` is replaced by the launcher, which is
  written to the same path; the installer reports it when the old file was a
  Mach-O or ELF binary.
- `WOWGET_DOWNLOAD_BASE` and `WOWGET_RUNTIME_BASE` fetch the release files and
  the runtime archive from another URL or a local directory (`file:` URLs);
  the signature and the SHA-256 are checked all the same, so they weaken
  nothing. `WOWGET_SKIP_PATH=1` leaves PATH alone. The smoke test
  (`client/tests/smoke-install.ps1`, in CI on all three platforms) uses them
  to install a release signed with a throwaway key from local files into a
  temporary root, then runs `wowget --version` and help through the launcher
  and checks that a tampered zip is refused. On Windows it runs `install.ps1`
  in Windows PowerShell 5.1, as `irm | iex` does.

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

Implementation notes: tar.gz runtimes are extracted with `System.Formats.Tar`,
which keeps file modes; the release download hosts are those of "Sources"
without WoWInterface. A development copy (version `0.0.0-dev`) or a module not
under `<root>/app/<version>/` refuses to self-update with a `usage` error.

Only data files and archives from Microsoft and from this project's releases
are written. No executable built by the project exists, so Smart App Control
has nothing to block. Scripts are not locked while they run, so the update
works while wowget runs.

### Size and speed

- First install: about 110 MB download on Windows (the 7.6.10 `win-x64` zip
  is 109.6 MB), 70 MB on macOS (68.1 MB for `osx-arm64`). Updates that keep
  the runtime: the app zip, a few hundred KB.
- Startup, measured in phase 0 on Windows 11 (see "Phase 0 results"): a
  `wowget --version` round trip through `wowget.cmd`, which imports the module,
  takes 0.40–0.44 s warm (median 0.41–0.42 s over 10 runs) and 0.46 s for
  the first run of a session. The very first start after extraction took
  2.2 s. A bare `pwsh -NoProfile -Command 'exit 0'` takes 0.19 s, so cmd,
  the script and the module import add about 0.22 s. Every command pays this
  once.

## Code layout

```
client/
  Wowget/
    Wowget.psd1, Wowget.psm1     module manifest and loader
    Errors.ps1                   the WowgetError class and its codes
    Fs.ps1                       atomic writes through symlinks, JSON text, the lock
    Paths.ps1                    locations, env overrides, game directory detection
    Manifest.ps1                 read, validate, write wowget.json
    TomlImport.ps1               one-time TOML manifest conversion
    Migrate.ps1                  first start after the Bun client: TOML import and adoption
    Markers.ps1                  read and write .wowget.json markers
    Api.ps1                      wowget service client (resolve, registry)
    Http.ps1                     one Invoke-WowgetHttp function; the only network call site
    UrlSource.ps1                url: sources
    Zip.ps1                      extraction and addon-folder normalisation
    Flavor.ps1                   flavors, TOC parsing, folderSupportsFlavor
    Installer.ps1                download cache, stage, swap, rollback, uninstall
    Ops.ps1                      one function per command, returns objects
    Search.ps1                   search over /v1/search, and suggest
    Reconcile.ps1, Doctor.ps1    as today, over markers
    Sync.ps1                     explicit device sync and operation receipts
    DeviceAuth.ps1               browser approval and local device credential
    SelfUpdate.ps1
    Cli.ps1                      argument parsing, formatting, --json, exit codes
  wowget.ps1                     entry point: imports the module, calls Cli
  runtime.json                   pinned runtime version, URLs and SHA-256 per platform
  tests/                         Pester 5 tests, mirroring the module; run.ps1 runs them
                                 (and PSScriptAnalyzer with -Lint)
  install.ps1, install.sh
  launchers/                     wowget.cmd and wowget.sh
  build-release.ps1              builds the release zip, checksum, signature and installers
  release-public-key.txt         the release public key
```

`Errors.ps1` and `Fs.ps1` are not in the first plan: the error class must load
before every file that throws it, and the write and lock helpers are shared by
the manifest, the markers and the url: source records. `Migrate.ps1` and
`Search.ps1` keep the first start and the two service-backed commands out of
`Ops.ps1`, which holds the commands of phase 1. `/v1/version` is read by
`SelfUpdate.ps1`, its only user.

Rules carried over from the Bun client:

- Nothing outside `Cli.ps1` writes to the host. Ops return
  `[pscustomobject]` results and take an optional `-OnEvent` script block for
  progress events.
- Errors are `WowgetError` exceptions (a class in the module) with a `Code`
  and a message meant for a person. Codes stay as today: `usage`, `manifest`,
  `manifest_exists`, `duplicate`, `not_found`, `network`, `rate_limited`,
  `zip`, `flavor`, `conflict`, `locked`, `source`, `io`. Service errors map
  to them: `rate_limited` to `rate_limited` (the message gives the
  `Retry-After` time), `upstream` and a per-item `flavor` or `source` result to
  `source` or `flavor` for that row, anything else to `network`. A per-item
  `not_found` or `bad_request` (an unknown repository or pin) is also `source`
  for that row, since it says nothing about the network.
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
| Machine state (device sync metadata, target ID map, contribution setting, operation receipts, lock file) | `%LOCALAPPDATA%\wowget\state\` | `~/Library/Application Support/wowget/` | `$XDG_STATE_HOME/wowget/` | `WOWGET_STATE_DIR` |
| Cache | `%LOCALAPPDATA%\wowget\cache\` | `~/Library/Caches/wowget/` | `$XDG_CACHE_HOME/wowget/` | `WOWGET_CACHE_DIR` |
| Game directory | as SPEC-TARGETS-WINDOWS.md | | | `WOWGET_GAME_DIR`, `--game-dir` |
| Service | `https://api.wowget.dev` (placeholder until the domain is chosen) | | | `WOWGET_API_URL` |

The machine state directory holds `sync.json` (enrollment, the map from
manifest target names to opaque device-local target IDs, the last report
revision) and `contributions.json` (the catalogue contribution setting,
including an opt-out saved by the installer before enrollment). Neither holds
the device credential; see "Data sent by sync".

`GITHUB_TOKEN` and `WOWGET_REGISTRY_URL` are no longer read: the service
talks to GitHub with its own token, and `WOWGET_API_URL` replaces the
registry URL. `WOWGET_API_URL=off` uses the registry snapshot and fails
resolution and search with a `network` error, which tests use.

## Local state

The complete local state of a machine:

1. **The manifest**: what should be installed on this machine. Dotfiles and
   portable targets still work independently of hosted sync.
2. **Marker files** in the installed addon folders: what is installed.
3. **The cache**: downloaded zips, kept for `rollback`, and `url:` source
   validators. Rebuildable.
4. **Device credential and sync metadata**, only when device sync is enabled.
   Credentials stay outside the manifest and dotfiles.

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

Implementation notes:

- The reader is tested against the 188 valid TOML 1.0.0 cases of
  toml-lang/toml-test that hold no date or time (copied into
  `client/tests/toml-test` with its MIT licence) and against
  `registry/addons.toml`, the only TOML file in the repository; the test
  fixtures hold none. Of the suite's 430 invalid cases without dates, it
  accepts two, both a byte order mark after the start of the file.
- The TOML layout (`[targets.<name>]`, `[[addon]]`) is mapped to the JSON one
  and goes through the JSON manifest's validation, so errors name JSON-style
  positions (`addon #2.name`) prefixed with the TOML file. A manifest with the
  old `[install]` table is a `manifest` error saying to run `wowget init`.
- The JSON file takes the TOML file's name: `wowget.toml` becomes
  `wowget.json`, and a `--manifest` file `addons.toml` becomes `addons.json`.
- A `wowget.json` that already exists next to the resolved TOML file (another
  machine converted the shared file) is used as it is, and the symlink next to
  the link is still created.

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
  its zip in the cache. One level of history, as `rollback` uses today. A
  reinstall of the same release (a repair) keeps the marker's `previous`.
- Folders without a marker are unmanaged: `reconcile` lists them, `update`
  and `remove` never touch them. Folders starting with `Blizzard_` are
  ignored.
- A marker that does not parse counts as no marker, and `doctor` reports it.
- A marker naming an addon that the manifest does not have on that target is
  **orphaned**: the addon was removed while that target was not on this
  machine, or through an externally edited manifest. `doctor` reports it as
  an issue (`orphan_marker`), naming the folders. `remove <name> -t <target>`
  also accepts such a name and deletes its folders. Nothing deletes them
  without being asked. `remove` and `target remove` on a target not on this
  machine therefore change only the manifest, with a `target:absent` event;
  there is no state row to forget.
- WoW ignores files in addon folders it does not know. Copying an addon
  folder to another machine carries its marker, which is correct.

### Lock

Commands that write take an exclusive lock on `<state>/wowget.lock`
(`[IO.File]::Open` with `FileShare.None`), so two wowget processes never
install at once. A second process waits up to 10 seconds, then fails with a
`locked` error naming the lock file. Every command except `list`,
`target list`, help and `--version` takes it; `outdated` does because
url: sources write the cache.

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

Each cache path segment (the addon name in lower case, the release id, the
filename) must be a valid file name on every platform. A segment is used as it
is when it already is one. Otherwise `<>:"/\|?*`, control characters and
trailing dots and spaces become `_`, reserved Windows device names (`CON`,
`PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with any extension) get a
`_` prefix, and `-` plus the first 6 hex digits of the original's SHA-256 is
appended. The hash keeps names that differ only in those characters (`A?B`,
`A*B`) in separate directories, so pruning one addon's cache never touches
another's. The Bun client replaced only `/`, `\`, `:` and NUL, which is why
adoption recovers release ids instead of trusting directory names.

## Commands

For the non-TUI commands, names, flags, outputs and exit codes stay as the Bun
client's, except:

| Command | Change |
|---|---|
| `init`, `target *` | Write JSON. Otherwise unchanged. |
| `add <source \| name>` | Bare names resolve against the service registry (snapshot when offline). `add wowi:<id>` without `--name` takes the name of the registry entry with that source, else `wowi-<id>`, since the service does not return the WoWInterface title. |
| `list` | Reads markers. |
| `outdated`, `update`, `install` | One `/v1/resolve` request per batch instead of per-addon lookups. |
| `pin`, `unpin`, `rollback` | Pins in the manifest as today; rollback reinstalls `previous` from the cache. `pin <name>` without a release on an install whose marker says `releaseId: "unknown"` is a `usage` error asking for a release or an `update` first. |
| `search` | `GET /v1/search`. `--github` stays. `--refresh` is accepted and ignored with a note, since the catalogue lives on the service. `--limit` is at most 50, the service's cap; more is a `usage` error. Rows are marked `inManifest` by comparing sources case-insensitively, as today. |
| `suggest [name...]` | Until the service's suggestion queue exists (service phase 3), unchanged: opens the prefilled GitHub issue of SPEC-REGISTRY-SUGGEST.md. Afterwards it sends the manifest addons the registry lacks to `POST /v1/suggestions` and prints the result, with no browser and no GitHub account; `--print` lists what would be sent and sends nothing. |
| `reconcile [--adopt]` | Unmanaged folders (no marker) are grouped and matched as today: registry `folders`, then TOC IDs (`X-GitHub`, `X-GitHub-Repo`, `X-Repository`, `X-Website`, `X-WoWI-ID`, and the `X-Curse-*` fields that only mark an addon as CurseForge). Matching runs on the device using the registry snapshot and local TOC IDs. Unmanaged folder names stay local, so the old WoWInterface catalogue-based guess is dropped. `--adopt` writes markers. A group with no source whose TOCs carry `X-Curse-*` fields gets `curseforge: true` and shows "CurseForge only". `--adopt` installs the latest release over the folders, as today, so the markers name a real release; it needs the service. |
| `doctor [--clean]` | Adds marker checks: unparseable markers, an install whose folders disagree, orphaned markers. Keeps the `portable_target` hints. `--clean` prunes the cache. The issue kinds are `invalid_marker`, `marker_mismatch` (folders of one addon whose markers name different releases, sources or folder lists) and `orphan_marker` (with `folders`). `missing_cached_zip` is not reported for `releaseId: "unknown"`, which names no zip. `stale_cache` covers release directories that no marker on a target on this machine names as current or previous. |
| `self-update [--check] [--force]` | See "Self-update". |
| `login` | Approve this device in the browser and enable optional sync. |
| `sync` | Fetch and apply queued changes for this device and report results. |
| `logout` | Revoke this device credential and clear local sync state. |
| `migrate` | New. Runs the TOML import and the marker adoption below on request. Also runs by itself on first start. Its result: `manifestPath`, `converted` (`from`, `to`, `written`), `notes`, `adopted` (`name`, `target`, `how`: `cache` or `fallback`, `releaseId`, `version`, `folders`, `previous`), `skipped`, `conflicts` and `unmarked` (per target). |

Running `wowget` without arguments prints command help. `--json` keeps the
result shapes. Fields that came from state rows come from markers now;
`installedAt` keeps its meaning.

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
   2. **Identify the installed archive by content, per target.** A candidate
      matches when its folders all exist on the target without a marker and
      every file the zip extracts into them exists on disk with the same
      SHA-256. Releases of one addon usually produce the same folder set, so
      folder names alone cannot tell the active release from the previous
      one; file contents can, since WoW writes saved variables to `WTF/`, not
      into addon folders. Each target is checked on its own, because targets
      of different flavors can have different releases installed. Exactly one
      matching candidate is adopted. None, or more than one with identical
      files, goes to step 4.
   3. **Recover the release id.** The Bun client's cache directory name is
      the release id with `/`, `\`, `:` and NUL replaced by `_`, so it is not
      always the id itself.
      - `url:` sources: the release id is the zip's SHA-256, computed.
      - `github:` and `wowi:` sources: resolve the source with
        `pin` set to the directory name, and with the manifest's `pin` when
        the addon has one. A result whose download has the cached zip's
        filename and checksum gives the release id.
      - Otherwise (no match, or the service unreachable) the marker gets
        `releaseId: "unknown"`, with the identified folders and SHA-256, so
        only the version label is missing and the next `update` writes a real
        marker.

      Write markers with the folder list and the zip's SHA-256. Set
      `previous` to another cached release of the addon when one exists, with
      its release id recovered the same way, so `rollback` keeps working.
   4. With no identified archive (the cache was cleaned, files were changed
      by hand, or two cached zips are identical), fall back to the folders a
      registry entry or a resolve of the source names, and write markers with
      `releaseId: "unknown"`. `outdated` reports such addons as `outdated`,
      and the next `update` reinstalls them and writes a real marker. Folders
      an older release used and the current one does not are not found this
      way; step 5 shows them.
   5. A folder two addons would claim is left without a marker and reported.
   Pins are kept, since they live in the manifest.
3. Rollback history beyond the cached `previous` zip is lost, because it lived
   in `state.db`.
4. The result lists what was converted and adopted, and how (cache or
   fallback), and then, per target, every folder still without a marker, so
   leftovers of older releases are visible and `reconcile` can handle them.
   `migrate --json` prints it.

Implementation notes:

- "First start" is per machine: adoption runs by itself when
  `<state>/migration.json` does not exist and either a TOML manifest is being
  converted or the Bun client's `state.db` exists (its existence is checked;
  it is never read). A finished adoption writes `migration.json`. The TOML
  import runs whenever its conditions hold. The automatic run takes the write
  lock, also before `list`, reports on stderr so that `--json` output stays as
  it is, and does not run before `migrate`, `self-update`, help or
  `--version`. A failed TOML import stops the command; a failed adoption is a
  warning that names `wowget migrate`.
- Cached zips are looked for under the Bun client's addon directory name
  (`/`, `\`, `:` and NUL replaced by `_`) and this client's. A recovered
  release id whose cache path differs from where the Bun client put the zip
  (the sanitising rules differ, see "Installer") moves the zip to the path
  this client computes, so `rollback` and cache pruning find it.
- Release id recovery also asks for the latest release when the addon is not
  pinned: a directory name the Bun client had to change (a tag such as
  `bundle/v1.2`) resolves to nothing, while the installed release is often
  still the latest one. Every recovery needs a matching filename and a
  matching checksum (SHA-256 or MD5); a result with neither checksum leaves
  the id `unknown`, since assets without a version in their name would
  otherwise match any release.
- Identification is by the SHA-256 of every file the zip extracts into its
  folders; extra files on disk, such as the marker, do not count against it.
  So a release that only adds files to an older one matches where the older
  one is installed too: of several matches, the one whose files include all
  the others' is taken, and only matches that no single one covers go to
  step 4.
- `previous` is the newest other cached release, and only when its release id
  is recovered: `rollback` finds the zip by its release id, which `unknown`
  does not name.
- The fallback of step 4 takes the registry entry's folders that are on the
  target without a marker, else the folder set of the newest cached zip when
  all of its folders are there (files changed by hand). A resolve adds no
  folders the registry does not have, since the service takes them from it,
  so it is not asked. Fallback markers have `filename: "unknown"` and no
  `sha256`.
- An addon with no folders found on a target is listed under `skipped`, as is
  one whose folders are all claimed by another addon too. When a claimed
  folder is dropped from a cache-identified install, the rest is adopted as a
  fallback, since its folders no longer match the archive.

## Optional device sync

The normal CLI workflow uses the manifest, markers and public API. Account
credentials are used only for the authenticated device endpoints. Public
resolution gets source, flavor and the requested channel or pin. Public search
gets its query and filters. Normal commands never enroll a device, publish an
inventory or sync implicitly.

- `wowget login` explains what sync sends, then starts the browser approval
  flow. The CLI prints the verification address and short confirmation code
  so the user can also open the page manually. The browser shows the code
  and the chosen device label before approval. Enrollment stores a revocable,
  device-scoped credential without uploading the inventory. The first
  explicit sync sends the initial report.
- Web add and remove operations edit the manifest this device uses. When that
  manifest is shared with other machines (a symlink into a dotfiles
  repository, or `WOWGET_MANIFEST` pointing outside the default location),
  those edits reach the other machines once the shared file is committed or
  synced. `wowget login` detects both cases and says so before approval, and
  `wowget sync` repeats it in its summary when it changed a shared manifest.
- `wowget sync` fetches pending operations for the enrolled device, takes the
  existing write lock while inspecting and changing local state, and applies
  operations through the same command logic as a local add, remove or
  update. It reports each result and the latest eligible inventory. A
  failed sync leaves normal local commands available.
- `wowget logout` revokes the credential and clears local enrollment state.
  If the service is unreachable, local logout still works and tells the user
  how to revoke the device in the dashboard. The local manifest, cache and
  installed addons remain usable. Removing a device in the dashboard also
  removes its hosted inventory and pending operations.

### Applying web changes

The local manifest is the authority for what this machine should install.
The service keeps the last report and versioned intents for specific targets
and addons. An add or remove is an edit to the desired list. An update is a
one-time operation with the same flavor and pin behavior as local
`wowget update`. Only public GitHub and WoWInterface sources are eligible.

Each operation has a stable ID and the relevant target and addon
preconditions from the last report. The CLI compares those against the
current manifest and markers before acting. A queued update for an addon
removed locally is skipped as a conflict. A changed source, pin or target
that affects an operation also produces a conflict. An unrelated local
change does not block the operation. An already satisfied add or remove
returns a successful no-op after checking for conflicts. File ownership
checks still apply, and sync never forces a takeover.

Store an operation record locally before applying it, and record the
outcome before acknowledging it to the service. After interruption, inspect
the manifest and markers against the recorded operation and intended result,
acknowledge work already completed, and retry only what can be applied safely.
An ambiguous outcome is reported for the user to resolve locally. A locked
folder is a retryable failure. Report stable result codes and affected
public addon IDs, rather than raw error output that can contain local paths.

### Local sync summary

Every `wowget sync` ends with a compact summary grouped by target. Show
the action and outcome on each line and old and new versions when known.
Include pending or retryable failures and conflicts, and say when there
are no changes. Local diagnostics can use the same messages as normal
commands. Only bounded result codes go to the service.

```text
Classic Era
  + Questie       installed 11.4.2
  ~ TomTom        3.8.2 -> 3.8.3
  - Bagnon        removed
  ! Details       update skipped (changed locally)
  ! WeakAuras     update pending (game has files locked)

1 added, 1 updated, 1 removed, 1 conflict, 1 pending
```

Use ASCII markers and optional PowerShell terminal color for interactive
output. Redirected output and `NO_COLOR` use plain text. `--json` emits
the same outcomes as data without formatting. Keep the summary in normal
terminal scrollback with no full-screen or interactive UI and no new
rendering dependency.

[tui-cs/clet](https://github.com/tui-cs/clet) provides interactive terminal
prompts and includes a non-interactive Markdown renderer (`clet md --cat`).
That renderer is an option for richer summaries if needed later. Revisit
packaging before adopting it: the upstream README currently describes its
direct-download Windows binaries as unsigned, and wowget's normal install
must work without an extra prerequisite.

### Data sent by sync

Send a user-chosen device label, target names and flavors, public addon
identifiers, desired membership, installed versions, opaque state revisions
for sync preconditions, and sync result codes.
Use opaque device-local target IDs so a queued operation refers to a
specific target even when display names change. Keep absolute paths, raw
logs, manifests, credentials and all direct URL sources local. The service
can read the synced fields and the dashboard labels them with the device's
last report time.

Catalogue contribution is a separate per-device setting. Its default
for enrolled devices is on. During browser approval, show the setting
before the user approves the device and respect any earlier installer
opt-out. The dashboard can change the setting at any time. A device
submits public addon IDs only after an explicit sync and only when the
current setting allows it. Use a separate public request without a sync
credential or device fields. If the setting cannot be read, skip the
contribution. Changing it never affects the ability to sync.
`wowget suggest` remains an explicit account-free alternative.

Store the device credential outside the manifest, with built-in storage only
(no `Add-Type` with C# source):

- Windows: `ConvertFrom-SecureString` without a key, which encrypts with DPAPI
  for the current user, written to `<state>/credential` with a current-user
  ACL.
- macOS: the Keychain through the built-in `security add-generic-password`
  and `find-generic-password` commands, with service name `wowget`.
- Linux: `<state>/credential` with mode 0600.

Keep tokens out of URLs, logs, and command output.

## Tests and CI

- Pester 5 and PSScriptAnalyzer, installed in CI only.
- CI runs tests on Linux, Windows and macOS with the pinned PowerShell from
  `runtime.json`. Tests use explicit temp directories and a fake HTTP
  layer. Live tests require `WOWGET_LIVE_TESTS=1`.
- Installer smoke checks run the real launchers in temp roots and verify
  `wowget --version` and help output.
- Sync tests cover local edits since the last report, retries after an
  interrupted acknowledgement, device revocation, partial failure,
  redaction of private fields, contribution opt-out at install and enrollment,
  normal CLI use without credentials, and sync summary output in interactive,
  redirected and JSON modes.

## Phases

0. **Prototype**, before any port. On Windows 11 with Smart App Control
   enabled and on macOS, check the pinned runtime and its signatures, the
   real launchers (including startup time, Ctrl+C and URL argument
   quoting), dot-sourced modules, signed release verification, archive
   download and extraction, markers and JSON manifest handling. Check Code
   Integrity events on Windows and record the results.
1. **Core CLI** against a development deployment of the service (service
   phase 1): manifest, markers, installer, `url:` sources, and every command
   that resolves. Include TOML import and marker adoption. It runs beside the
   Bun client with its own install root and `WOWGET_API_URL`.
2. **Search** against service phase 2. `suggest` keeps the GitHub issue flow.
3. **Account-free release**: new signed packages and installers, the switch
   from the Bun client, README and AGENTS.md updated.

### Phase 0 results (2026-11-21)

A Windows 11 machine, driven from WSL2, with Smart App Control on and enforcing
(`VerifiedAndReputablePolicyState` 1, `SmartAppControlState` On). macOS was
not tested in this run.

- **Runtime.** `PowerShell-7.6.10-win-x64.zip` (7.6.10 is the current 7.6
  tag) matched the SHA-256 in the release asset's digest and in
  `hashes.sha256`. Of its 658 files, 517 are executables and DLLs (2 `.exe`,
  515 `.dll`), and `Get-AuthenticodeSignature` reports all 517 as `Valid`
  (signers: .NET 410, Microsoft Corporation 63, Microsoft 3rd Party
  Application Component 34, Microsoft Windows 7, .NET DAC 3). The archive was
  downloaded without a Mark of the Web, as `install.ps1` will download it.
- **Launcher.** The `wowget.cmd` above, unchanged, ran `wowget.ps1`, which
  imported a module made of dot-sourced `.ps1` files. The script ran in
  `FullLanguage` mode, so Smart App Control does not put unsigned scripts
  in Constrained Language mode.
- **Download.** `Invoke-WebRequest -MaximumRedirection 0
  -SkipHttpErrorCheck` returns the 3xx response but also writes a
  non-terminating "maximum redirection count" error, so the client calls it
  with `-ErrorAction SilentlyContinue -ErrorVariable` and fails only when no
  response came back. A GitHub release asset redirected once, from
  `github.com` to `release-assets.githubusercontent.com`; a WoWInterface
  download (`cdn.wowinterface.com/downloads/getfile.php`) answered 200
  directly. A host outside the allowlist was refused before any request.
  The allowlist keeps `objects.githubusercontent.com`, GitHub's earlier
  asset host.
- **Extraction, markers, manifest.** `System.IO.Compression.ZipFile` extracted
  a 142-entry addon zip. A marker and a JSON manifest were written through
  `[IO.File]::WriteAllText` with UTF-8 without BOM and `[IO.File]::Move`, and
  read back with `ConvertFrom-Json`. `ConvertTo-Json` writes CRLF on Windows,
  so the manifest writer normalises to LF.
- **Release signature.** A zip signed with a throwaway P-256 key
  (`ECDsa.SignHash`, DER) verified with `ECDsa.VerifyHash` and the public key
  as base64 SubjectPublicKeyInfo; a different file with the same signature
  did not.
- **Code Integrity.** The `Microsoft-Windows-CodeIntegrity/Operational` log
  had no events of any id (so none of 3033, 3034, 3076, 3077, 3089, 3118,
  3119) between the start of the test and its end, which covered the
  extraction, the signature check and every launcher run.
- **Arguments.** Results through `wowget.cmd`:

  | Argument | From `cmd.exe` | From PowerShell 5.1 and 7.6 |
  |---|---|---|
  | `url:https://x.test/a%20b.zip`, unquoted or quoted | unchanged | unchanged |
  | `100%` | unchanged | unchanged |
  | `%OS%` (a defined variable), unquoted or quoted | expanded to `Windows_NT` | expanded to `Windows_NT` |
  | `a^b`, unquoted | `^` dropped | `^` dropped |
  | `"a^b"`, quoted | unchanged | `^` dropped |
  | `a?x=1&y=2`, quoted | unchanged | cut at `&`, cmd then runs `y` |

  The launcher itself does not re-expand `%` in `%*`; the expansion and the
  `^` and `&` handling come from the `cmd /c` that runs any `.cmd` file,
  which PowerShell also uses and to which it passes arguments without spaces
  unquoted. `%XX` escapes are safe unless they spell a defined variable
  between two `%`. From PowerShell, an argument with `&` or `^` survives when
  wrapped in double quotes inside single quotes
  (`'"url:https://x.test/a?x=1&y=2"'`) or after `--%`. The README written in
  phase 3 documents this for `url:` sources with query strings.
- **Ctrl+C.** Not tested: the "Terminate batch job (Y/N)?" prompt needs an
  interactive console, which this run did not have.
- **Linux.** The `linux-x64` runtime aborts at start without libicu.
  `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` makes it run, so `install.sh` and the
  `sh` launcher are to set it when libicu is missing.

Phases 0 to 3 are the vertical slice: feature parity with the Bun client
except the TUI, with no accounts, sync or admin interface. It also produces
the measurements the open service decisions need.

4. **Optional device sync** with `login`, `sync`, `logout`, dashboard
   integration, and catalogue contributions with a separate opt-out.

## Not in scope

- A terminal UI or desktop GUI.
- Windows PowerShell 5.1.
- Signing the scripts. Validate launch behavior under Smart App Control in
  phase 0.
- Keeping the Bun client beside the PowerShell client after the switch.
- Background sync, shared manifest tokens, or remote execution outside a
  user's explicit `wowget sync`.

## Open questions

- Whether to ship a final Bun release that directs users to the new
  installer. On affected Windows machines, Smart App Control may block a
  Bun self-update before it can show that message.
