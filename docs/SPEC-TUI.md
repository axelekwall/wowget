# Terminal UI

Extends SPEC-MVP.md, SPEC-TARGETS-WINDOWS.md and SPEC-SEARCH.md. Scope: a
full-screen terminal UI over the existing core, for users who do not want to
learn the commands. The CLI stays as it is.

## Goals

1. Running `wowget` with no arguments in a terminal opens the TUI. On Windows,
   double-clicking `wowget.exe` does the same.
2. Every common task works by mouse and by keyboard: see what is installed
   and outdated per target, update, add through search, remove, pin and unpin.
3. A first run without a manifest walks through `init` instead of printing
   help.
4. The TUI calls the same `src/core` functions as the CLI. No logic moves into
   the UI layer.
5. Release binaries keep building from one Linux runner.

## Spike (checked 2026-11-02)

Library: `@opentui/core` 0.8.1, Bun 1.4.4. The spike rendered a bordered box
with a text label in OpenTUI's headless test renderer, sent a mouse click
through its mock mouse, and checked that the click handler ran and the next
frame showed the new text. Script in the appendix.

### How OpenTUI loads its native library

`@opentui/core` is TypeScript over a native library (Zig, with Yoga layout and
a decode-only FFmpeg) loaded through `bun:ffi`. The library ships in one
optional package per platform, `@opentui/core-<os>-<arch>`, each holding
`libopentui.dylib`, `libopentui.so` or `opentui.dll` (6.6 MB on darwin-arm64,
8.9 MB on win32-x64). The core picks the package with `process.platform` and
`process.arch` and imports the library `with { type: "file" }`, so
`bun build --compile` embeds it. `OTUI_ASSET_ROOT` overrides the path at
runtime.

### Results

| Check | Result |
|---|---|
| Run from source, darwin-arm64 | OK |
| Cross-compile with only the host's native package installed | Fails for every other target: `Could not resolve: "@opentui/core-darwin-x64"` (and win32-x64, linux-x64). Bun folds `process.platform`/`process.arch` per `--target`, so only the target's package is needed, but it must be on disk. |
| `bun install --os='*' --cpu='*'` | Installs all nine native packages. `bun.lock` records all of them, and `bun install --frozen-lockfile` with and without the flags both pass on that lockfile. |
| Compile darwin-arm64, darwin-x64, windows-x64 from one darwin-arm64 host after that | All three build |
| Run compiled darwin-arm64 binary | OK |
| Run compiled darwin-x64 binary (Rosetta) | OK |
| Run compiled windows-x64 binary | Not run (no Windows machine). The exe contains `opentui.dll`. Covered by the CI checks below. |
| Real terminal: mouse, resize, animation | Not tested. The spike used the headless renderer only. |

Binary size, spike binary compared with today's `wowget` built for the same
target:

| Target | wowget today | With OpenTUI | Added |
|---|---|---|---|
| darwin-arm64 | 89.3 MB | 102.8 MB | +13.5 MB |
| darwin-x64 | 98.3 MB | 112.5 MB | +14.2 MB |
| windows-x64 | 115.4 MB | 131.1 MB | +15.7 MB |

### Licensing

OpenTUI is MIT. The native packages are `MIT AND LGPL-2.1-or-later`: the
library statically links a decode-only FFmpeg 9.0.2 (LGPL; GPL and nonfree
parts disabled), plus libwebp, lcms2, zlib, stb, wuffs and Ghostty code
under their own permissive licences. Each package carries the licence files.
Before the first release with the TUI:

- ship those notices with the release. Done: `build:release` writes a
  `THIRD-PARTY-NOTICES.txt` asset from every bundled package (read from
  Bun's build metafile, plus their dependencies) and from each target's
  native package (`LICENSE*`, `PATENTS-LIBWEBP`, `AUTHORS-LIBWEBP`,
  `FFMPEG-SOURCE.md`);
- confirm that `OTUI_ASSET_ROOT`, which lets a user load their own build of
  the native library, meets LGPL-2.1's replacement requirement for a library
  embedded in a single-file binary. Still open.

## Library choice

OpenTUI with its React renderer, `@opentui/react` (React 19).

- Mouse events (down, up, move, drag, scroll) on any renderable, flexbox
  layout through Yoga, and a timeline API for animation, all built in.
- Built for Bun, which wowget already uses.
- Ink was the other candidate in PLAN.md. It has no mouse support of its own.
- React over the imperative core API because the views are lists and forms
  driven by state that changes while operations run.
- Pin exact versions (`0.8.2`, not `^0.8.2`). OpenTUI is pre-1.0.
- `@opentui/react` imports React DevTools and connects to it on localhost when
  `DEV=true` is set, which keeps the process running. The bundle cannot leave
  the module out (Bun hoists the import), so `cli.ts` deletes `DEV` from the
  environment before it loads the TUI.

## Entry and dispatch

- `wowget` with no command, when stdin and stdout are both TTYs, opens the
  TUI. Without a TTY it keeps today's behaviour (help on stderr, exit 2), so
  scripts are unaffected.
- `wowget tui` opens it explicitly, with the usual `--manifest` flag.
- `wowget tui --check` loads the native library, prints `ok <platform>-<arch>`
  and exits 0. CI and the release verify job use it.
- `cli.ts` loads the TUI with a dynamic `import()`, so plain commands do not
  evaluate OpenTUI.
- Quitting (`q`, `Ctrl+C`, or the window's close button) destroys the renderer,
  which restores the terminal, then closes the state database.

## Screens

### First run

When the manifest does not exist: show the WoW installs `init` would add (one
row per detected flavor, with its path), each with a checkbox, and a "Create"
button. When none are detected, offer a path field and a flavor choice (the
`--path`/`--flavor` form of `init`). Then go to the main screen.

### Main

- **Target tabs** across the top, plus an "All" tab. Click or `1`–`9`.
- **Addon table**: name, installed version, latest version, status (ok,
  outdated, missing, not installed, error), pinned marker. Scrolls with the
  wheel. Click selects a row, shift-click or `space` adds rows to the
  selection.
- **Action bar**: Update all, Update selected, Add, Remove, Pin, Unpin,
  Rollback, Refresh. Buttons that do not apply to the selection are disabled.
  Every button has a key, shown on the button.
- **Status line**: the current operation and its progress, or the last
  result.

On open the table fills from `list()` (no network), then `outdated()` runs and
fills in the latest versions. Rows waiting for a result show a spinner.

### Add

A search field over `search()` from SPEC-SEARCH.md. Results show name, source,
flavors and description in the order `search()` returns them, mark rows
already in the manifest (`inManifest`), and show the result's `warnings` in
the status line. Choosing a result shows target
checkboxes (default: all targets whose flavor the result supports), then
installs with progress. A field for a raw source string (`github:`, `wowi:`,
`url:`) covers what search does not find.

### Confirmations

Remove and rollback ask first, naming the addon and the targets. Update does
not.

### Progress

`ProgressEvent`s from the core drive a per-addon progress bar (bytes when the
total is known, otherwise a spinner) and the status line. Errors stay on the
row until the next refresh, with the error message on hover and in the status
line when selected.

## Core and TUI split

- The TUI lives in `src/tui/` and imports only from `src/core`. No console I/O
  in the core changes.
- One operation at a time, the update check included: the action buttons are
  disabled while one runs. An `outdated` result that landed after an update
  would show the versions from before it, so reads do not run alongside
  writes. `search` will be the exception, since it does not touch rows.
- Update calls go one target at a time with the chosen names, because
  `ProgressEvent`s name the addon but not the target.
- No core changes: every row shows a spinner while `outdated` runs, so it
  needs no events.
- Windows `locked` errors (WoW is running) show the core's message on the row.

## Animation

Kept small: spinners on rows waiting on the network, download progress bars
(repainted at most every 50 ms), and a short highlight on a row whose status
changed. No animation runs when nothing is happening, so an idle TUI uses no
CPU.

## Build and CI

- `release.yml` build job: `bun install --frozen-lockfile --os='*' --cpu='*'
  --libc='*'`, so every target's native package is present on the Linux
  runner. `--libc='*'` is needed because the core chooses between its glibc
  and musl Linux packages from `OPENTUI_LIBC` at runtime, so Bun has to
  resolve both whenever it bundles for Linux (the notices step bundles for
  the host), and a glibc host otherwise skips the musl packages.
- `release.yml` verify job (macOS and Windows): after installing, run
  `wowget tui --check`. This is the first run of a compiled Windows binary
  with OpenTUI.
- `ci.yml`: the check job installs with `--libc='*'` for the same reason, so
  `bun run build` works on Linux. Each OS still gets only its own native
  packages. The TUI tests below run on all three OSes from source.
- `ci.yml` adds a `release-build` job on `ubuntu-latest` that installs with
  `--os='*' --cpu='*' --libc='*'` and runs `bun run build:release` with
  `WOWGET_VERSION=0.0.0-ci`, so a missing native package fails the PR, not
  the release. A `release-smoke` job then runs the cross-compiled
  darwin-arm64 and windows-x64 binaries on their own runners with
  `--version` and `tui --check`, so a Windows binary that cannot load its
  native library fails before anything is published.

## Tests

- Screen tests with `@opentui/core/testing` (`createTestRenderer`, mock keys
  and mouse, `captureCharFrame`): first run, main table from a fixture
  manifest and state, an update run through fake fetch, the add flow, remove
  confirmation. They use the same fixtures and fake fetch as the ops tests.
- Assert on visible text and on the resulting manifest and state, not on
  frame snapshots, which break on every layout change.
- `tui --check` in CI as above.

## Phases

1. **Plumbing.** Dependencies, `tui` command with `--check`, release and CI
   changes, licence notices. Ship it with an empty screen that quits.
2. **Main screen.** Tabs, table, `list` and `outdated`, update all and update
   selected with progress.
3. **Manage.** Add with search, remove, pin, unpin, rollback, confirmations.
4. **First run.** The `init` flow and the no-argument entry.

The no-argument entry lands last so that `wowget` alone keeps printing help
until the TUI covers first run.

## Not in scope

- `reconcile`, `doctor`, `target add/remove` and `self-update` in the TUI.
  They stay CLI commands.
- Editing the manifest in the TUI beyond what the listed actions write.
- Themes and settings.
- A GUI outside the terminal, and an in-game addon.

## Open questions

- Does the LGPL replacement path via `OTUI_ASSET_ROOT` hold for an embedded
  library, or does the release need the native library as a separate file?
- Is +14 to +16 MB per binary acceptable, or should the TUI be a separate
  download?
- On Windows 11 the default console is Windows Terminal, which reports mouse
  events. Is the legacy console host worth testing?

## Appendix: spike script

Run from a checkout with `bun add @opentui/core@0.8.1` and
`bun install --os='*' --cpu='*'`, then
`bun build --compile --target=<target> tui-spike.ts --outfile <out>`.

```ts
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

const { renderer, mockMouse, renderOnce, captureCharFrame, dispose } = await createTestRenderer({ width: 30, height: 5 });

const label = new TextRenderable(renderer, { id: "label", content: "clicks: 0" });
let clicks = 0;
const box = new BoxRenderable(renderer, {
  id: "box",
  width: 20,
  height: 3,
  border: true,
  onMouseDown: () => {
    clicks++;
    label.content = `clicks: ${clicks}`;
  },
});
box.add(label);
renderer.root.add(box);

await renderOnce();
await mockMouse.click(5, 1);
await renderOnce();
const frame = captureCharFrame();
await dispose();

console.log(frame);
console.log(`${process.platform}-${process.arch} ${clicks === 1 && frame.includes("clicks: 1") ? "OK" : "FAIL"}`);
process.exit(clicks === 1 ? 0 : 1);
```
