#!/usr/bin/env bun
import { realpath } from "node:fs/promises";
import { parseArgs } from "node:util";
import { WowgetError } from "./core/errors.ts";
import type { ProgressEvent } from "./core/events.ts";
import { FLAVORS, isFlavor, type Flavor } from "./core/flavor.ts";
import * as ops from "./core/ops.ts";
import { manifestPath, stateDbPath } from "./core/paths.ts";
import { selfUpdate, type SelfUpdateResult } from "./core/selfupdate.ts";
import { openState, type State } from "./core/state.ts";
import { VERSION } from "./version.ts";

const HELP = `Usage: wowget <command> [options]

Commands:
  init [--path P --flavor F --name N] [--game-dir D]
                                        create the manifest: one target for the AddOns directory P,
                                        or one per World of Warcraft version found in the game dir
  target list                           show the targets and whether their AddOns directories exist
  target add <name> (--path P | --folder D) --flavor F
                                        add a target: the AddOns directory P, or the version folder D
                                        (such as _retail_) in the game directory of each machine
  target remove <name>                  uninstall everything on a target and remove it
  search <query...> [--flavor F | --all-flavors] [--github] [--limit N] [--refresh]
                                        find addons in the registry and on WoWInterface
                                        (and GitHub with --github); filters on the targets' flavors
  add <source|name> [--name N] [--prerelease] [--pin ID]
                                        install an addon and add it to the manifest; a bare name
                                        is looked up in the addon registry
  remove <name>                         uninstall an addon and drop it from the manifest
  list                                  show manifest addons and what is installed
  outdated                              check every addon for a newer release
  update [name...]                      install newer releases (all addons by default)
  install                               install manifest addons that are not installed
  pin <name> [release]                  freeze an addon at its installed release or a given release
  unpin <name>                          remove the release pin from an addon
  rollback <name>                       reinstall the previous release of an addon from the cache
  reconcile [--adopt]                   find hand-installed addons and optionally adopt them
  doctor [--clean]                      check targets, TOC interfaces and cache health
  suggest [name...] [--print]           open a GitHub issue that proposes the manifest addons
                                        missing from the addon registry
  self-update [--check]                 replace this binary with the latest wowget release
  tui                                   open the terminal UI: see what is outdated and update by mouse or keyboard

search, add, remove, list, outdated, update, install, rollback, reconcile and doctor act on every target
unless filtered with -t/--target, which can be repeated. "add -t" records the targets
in the manifest; "remove -t" removes the addon from those targets only. Targets whose version
folder is not on this machine are skipped.

Sources: github:owner/repo, wowi:<id>, url:https://...
Flavors: ${FLAVORS.join(", ")}

Options:
  -t, --target <name> act on this target only (repeatable)
  --adopt             with reconcile: install and add matched addons to the manifest
  --clean             with doctor: remove leftover temp folders and unreferenced cache dirs
  --check             with self-update: only report whether a newer release exists;
                      with tui: only check that the terminal UI library loads
  --all-flavors       with search: do not filter on flavors
  --github            with search: also search GitHub repositories tagged wow-addon
  --limit <n>         with search: show at most n results (default 20)
  --refresh           with search: download the WoWInterface catalogue even if the copy is recent
  --print             with suggest: print the issue URL without opening a browser
  --manifest <path>   manifest file (default $WOWGET_MANIFEST, else ${manifestPath(undefined, { ...process.env, WOWGET_MANIFEST: undefined })})
  --json              print the result as JSON
  --force             install over unmanaged folders and unverifiable flavors;
                      with self-update: reinstall the latest release even if it is not newer
  --verbose           show every progress step and stack traces
  -h, --help          show this help
  --version           show the version
`;

type Flag =
  | "path"
  | "folder"
  | "flavor"
  | "name"
  | "prerelease"
  | "pin"
  | "target"
  | "game-dir"
  | "adopt"
  | "clean"
  | "check"
  | "all-flavors"
  | "github"
  | "limit"
  | "refresh"
  | "print";
const FLAGS: Flag[] = [
  "path",
  "folder",
  "flavor",
  "name",
  "prerelease",
  "pin",
  "target",
  "game-dir",
  "adopt",
  "clean",
  "check",
  "all-flavors",
  "github",
  "limit",
  "refresh",
  "print",
];

const COMMAND_FLAGS: Record<string, Flag[]> = {
  init: ["path", "flavor", "name", "game-dir"],
  "target list": [],
  "target add": ["path", "folder", "flavor"],
  "target remove": [],
  search: ["target", "flavor", "all-flavors", "github", "limit", "refresh"],
  add: ["name", "prerelease", "pin", "target"],
  remove: ["target"],
  list: ["target"],
  outdated: ["target"],
  update: ["target"],
  install: ["target"],
  pin: [],
  unpin: [],
  rollback: ["target"],
  reconcile: ["target", "adopt"],
  doctor: ["target", "clean"],
  "self-update": ["check"],
  suggest: ["print"],
  tui: ["check"],
};

const POSITIONALS: Record<string, [min: number, max: number]> = {
  init: [0, 0],
  "target list": [0, 0],
  "target add": [1, 1],
  "target remove": [1, 1],
  search: [1, Infinity],
  add: [1, 1],
  remove: [1, 1],
  list: [0, 0],
  outdated: [0, 0],
  update: [0, Infinity],
  install: [0, 0],
  pin: [1, 2],
  unpin: [1, 1],
  rollback: [1, 1],
  reconcile: [0, 0],
  doctor: [0, 0],
  "self-update": [0, 0],
  suggest: [0, Infinity],
  tui: [0, 0],
};

class UsageError extends Error {}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        manifest: { type: "string" },
        json: { type: "boolean" },
        force: { type: "boolean" },
        verbose: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
        path: { type: "string" },
        flavor: { type: "string" },
        name: { type: "string" },
        prerelease: { type: "boolean" },
        pin: { type: "string" },
        target: { type: "string", short: "t", multiple: true },
        "game-dir": { type: "string" },
        folder: { type: "string" },
        adopt: { type: "boolean" },
        clean: { type: "boolean" },
        check: { type: "boolean" },
        "all-flavors": { type: "boolean" },
        github: { type: "boolean" },
        limit: { type: "string" },
        refresh: { type: "boolean" },
        print: { type: "boolean" },
      },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Writes progress to stderr: one line per download, every step with --verbose. */
function progressRenderer(verbose: boolean) {
  let openLine = false;
  const write = (text: string) => process.stderr.write(text);
  return {
    onEvent(event: ProgressEvent) {
      if (event.type === "catalog:download") {
        this.flush();
        write("Downloading the WoWInterface addon list\n");
      } else if (event.type === "registry:stale") {
        this.flush();
        write(`wowget: warning: ${event.message}\n`);
      } else if (event.type === "target:absent") {
        this.flush();
        write(`wowget: ${event.message}\n`);
      } else if (event.type === "download:start") {
        this.flush();
        write(`${event.addon}: downloading ${event.filename}`);
        openLine = true;
      } else if (event.type === "download:done" && openLine) {
        write(` (${formatBytes(event.bytes)})\n`);
        openLine = false;
      } else if (verbose && "addon" in event && event.type !== "download:progress") {
        this.flush();
        const detail = "folders" in event ? ` ${event.folders.join(", ")}` : "";
        write(`${event.addon}: ${event.type}${detail}\n`);
      }
    },
    flush() {
      if (openLine) write("\n");
      openLine = false;
    },
  };
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  "))
    .join("\n");
}

function renderUpdate(result: ops.UpdateResult): string {
  if (!result.addons.length) return "No addons in the manifest.";
  return table(
    result.addons.map((a) => {
      switch (a.status) {
        case "current":
          return [a.name, a.target, "current", a.version];
        case "updated":
          return [a.name, a.target, "updated", `${a.from} -> ${a.to}`];
        case "installed":
          return [a.name, a.target, "installed", a.version];
        case "repaired":
          return [a.name, a.target, "repaired", `${a.version} reinstalled`];
        case "skipped":
          return [a.name, a.target, "skipped", `${a.version} already installed`];
        case "error":
          return [a.name, a.target, "error", a.error];
      }
    }),
  );
}

function renderRemoved(rows: ops.RemoveEntry[]): string[] {
  return rows.map((r) => {
    if (!r.wasInstalled) return `  ${r.target}: was not installed`;
    return `  ${r.target}: removed${r.removedFolders.length ? ` ${r.removedFolders.join(", ")}` : ""}`;
  });
}

function render(command: string, result: unknown): string {
  switch (command) {
    case "init": {
      const r = result as ops.InitResult;
      return [
        `Created ${r.manifestPath}`,
        table([
          ["TARGET", "FLAVOR", "PATH"],
          ...r.targets.map((t) => [t.name, t.flavor, `${t.path}${t.createdAddonsDir ? " (created)" : ""}${t.folder ? ` (folder ${t.folder})` : ""}`]),
        ]),
      ].join("\n");
    }
    case "target list": {
      const r = result as ops.TargetListResult;
      if (!r.targets.length) return 'No targets in the manifest. Add one with "wowget target add".';
      return table([
        ["TARGET", "FLAVOR", "PATH", "EXISTS"],
        ...r.targets.map((t) => [
          t.name,
          t.flavor,
          t.path === null ? `${t.folder} (not on this machine)` : `${t.path}${t.folder ? ` (folder ${t.folder})` : ""}`,
          t.exists ? "yes" : "no",
        ]),
      ]);
    }
    case "target add": {
      const r = result as ops.TargetAddResult;
      const where = r.target.path ?? `${r.target.folder}, which is not on this machine`;
      const lines = [`Added target ${r.target.name} (${r.target.flavor}) at ${where}`];
      if (r.createdAddonsDir) lines.push(`Created ${r.target.path}`);
      return lines.join("\n");
    }
    case "target remove": {
      const r = result as ops.TargetRemoveResult;
      const lines = [`Removed target ${r.name}`];
      for (const a of r.addons) lines.push(`  uninstalled ${a.name}${a.removedFolders.length ? ` (${a.removedFolders.join(", ")})` : ""}`);
      for (const name of r.removedAddons) lines.push(`  removed ${name} from the manifest (it had no other target)`);
      return lines.join("\n");
    }
    case "search": {
      const r = result as ops.SearchResult;
      if (!r.results.length) {
        return r.flavors ? `No addons found for ${r.flavors.join(", ")}; --all-flavors searches every flavor.` : "No addons found.";
      }
      // The "*" column only appears when a result is already in the manifest.
      const marked = r.results.some((a) => a.inManifest);
      return table([
        [...(marked ? [""] : []), "NAME", "SOURCE", "FLAVORS", "POPULARITY", "UPDATED"],
        ...r.results.map((a) => [
          ...(marked ? [a.inManifest ? "*" : ""] : []),
          a.name,
          a.source,
          // Nothing about a GitHub result's releases is known, so it gets a single "?".
          a.origin === "github"
            ? "?"
            : Object.entries(a.flavors)
                .map(([f, support]) => (support === "unknown" ? `${f}?` : f))
                .join(" ") || "?",
          a.downloadsMonthly !== null ? `${a.downloadsMonthly}/month` : a.stars !== null ? `${a.stars} stars` : "",
          a.updatedAt?.slice(0, 10) ?? "",
        ]),
      ]);
    }
    case "add": {
      const r = result as ops.AddResult;
      const lines = r.addons.map((a) => `Added ${r.name} ${a.version} to ${a.target} (${a.folders.join(", ")})`);
      if (r.registryName !== undefined) lines.unshift(`Using ${r.source} for "${r.registryName}" from the addon registry`);
      return lines.join("\n");
    }
    case "remove": {
      const r = result as ops.RemoveResult;
      const head = r.removedEntry
        ? `Removed ${r.name}`
        : `Removed ${r.name} from ${r.addons.map((a) => a.target).join(", ")}; still on ${r.remainingTargets!.join(", ")}`;
      return [head, ...renderRemoved(r.addons)].join("\n");
    }
    case "list": {
      const r = result as ops.ListResult;
      if (!r.addons.length) return "No addons in the manifest.";
      return table([
        ["NAME", "TARGET", "VERSION", "STATUS", "SOURCE"],
        ...r.addons.map((a) => [
          a.name,
          a.target,
          a.version ?? "-",
          a.status === "missing" ? `missing (${a.missingFolders.join(", ")})` : a.status,
          a.source,
        ]),
      ]);
    }
    case "outdated": {
      const r = result as ops.OutdatedResult;
      if (!r.addons.length) return "No addons in the manifest.";
      return table([
        ["NAME", "TARGET", "INSTALLED", "LATEST", "STATUS"],
        ...r.addons.map((a) => {
          switch (a.status) {
            case "current":
              return [a.name, a.target, a.version, a.version, "current"];
            case "outdated":
              return [a.name, a.target, a.installed, a.latest, "outdated"];
            case "not installed":
              return [a.name, a.target, "-", a.latest, "not installed"];
            case "missing":
              return [a.name, a.target, a.installed, a.latest, `missing (${a.missingFolders.join(", ")})`];
            case "error":
              return [a.name, a.target, "-", "-", `error: ${a.error}`];
          }
        }),
      ]);
    }
    case "pin": {
      const r = result as ops.PinResult;
      const lines = r.addons.map((a) => `Installed ${r.name} ${a.version} on ${a.target} (${a.folders.join(", ")})`);
      lines.push(`Pinned ${r.name} to ${r.pin}`);
      return lines.join("\n");
    }
    case "unpin": {
      const r = result as ops.UnpinResult;
      return r.previousPin !== undefined ? `Unpinned ${r.name} (was ${r.previousPin})` : `${r.name} was not pinned`;
    }
    case "rollback": {
      const r = result as ops.RollbackResult;
      const lines = r.addons.map(
        (a) => `Rolled back ${a.name} on ${a.target}: ${a.from ?? "none"} -> ${a.to} (${a.folders.join(", ")})`,
      );
      if (r.pinned !== undefined) {
        lines.push(`Pinned ${r.name} to ${r.pinned}; run "wowget unpin ${r.name}" to resume updates.`);
      } else {
        const why = r.notPinned === "partial" ? "the rollback did not cover all its targets" : "its targets are on different releases";
        lines.push(`${r.name} was not pinned because ${why}; the next update reinstalls the newer release.`);
      }
      return lines.join("\n");
    }
    case "reconcile": {
      const r = result as ops.ReconcileResult;
      if (!r.addons.length) return "No unmanaged addon folders found.";
      return table([
        ["NAME", "TARGET", "VERSION", "STATUS", "SOURCE", "FOLDERS"],
        ...r.addons.map((a) => [
          a.name,
          a.target,
          a.version ?? "-",
          a.status === "error" ? `error: ${a.error}` : a.status,
          a.source ?? (a.suggestions ? `maybe ${a.suggestions.join(", ")}` : "-"),
          a.folders.join(", "),
        ]),
      ]);
    }
    case "doctor": {
      const r = result as ops.DoctorResult;
      const lines = [
        table([
          ["TARGET", "FLAVOR", "CLIENT", "EXISTS", "PATH"],
          ...r.targets.map((t) => [
            t.name,
            t.flavor,
            t.clientInterface !== undefined ? `${t.clientInterface} (${t.clientVersion})` : "-",
            t.exists ? "yes" : "no",
            t.path,
          ]),
        ]),
      ];
      for (const path of r.cleaned) lines.push(`Cleaned ${path}`);
      if (!r.issues.length) lines.push("No issues found.");
      else for (const issue of r.issues) lines.push(`Issue [${issue.kind}]: ${issue.message}`);
      return lines.join("\n");
    }
    case "suggest": {
      const r = result as ops.SuggestResult;
      if (!r.addons.length) return "No addons in the manifest.";
      const status = (a: ops.SuggestEntry) =>
        a.status === "listed"
          ? `in the registry${a.registryName !== a.name ? ` as ${a.registryName}` : ""}`
          : a.status === "url"
            ? "url: sources cannot be in the registry"
            : "not in the registry";
      const lines = [table([["NAME", "SOURCE", "STATUS"], ...r.addons.map((a) => [a.name, a.source, status(a)])])];
      if (r.url) {
        const count = r.addons.filter((a) => a.status === "suggested").length;
        const what = count === 1 ? "the addon" : `the ${count} addons`;
        lines.push("", `Submit this issue to suggest ${what} for the registry; a bot checks them and opens a pull request:`, r.url);
      } else {
        lines.push("", "Nothing to suggest.");
      }
      return lines.join("\n");
    }
    case "self-update": {
      const r = result as SelfUpdateResult;
      if (r.status === "updated") return `Updated wowget ${r.current} -> ${r.latest} at ${r.path}`;
      if (r.status === "available") return `wowget ${r.latest} is available (installed: ${r.current}); run "wowget self-update" to install it.`;
      return `wowget ${r.current} is up to date (latest release: ${r.latest}).`;
    }
    default:
      return renderUpdate(result as ops.UpdateResult);
  }
}

/** Holding directories that could not be deleted, from the rows of an add, remove or update-style result. */
function leftoverDirs(result: unknown): { name: string; target: string; dir: string }[] {
  const addons = (result as { addons?: { name: string; target: string; leftoverDir?: string }[] }).addons;
  if (!Array.isArray(addons)) return [];
  return addons.flatMap((e) => (e.leftoverDir ? [{ name: e.name, target: e.target, dir: e.leftoverDir }] : []));
}

/** Source notes from the rows of a result, once per distinct addon and message. */
function notes(result: unknown): { name: string; note: string }[] {
  const addons = (result as { addons?: { name: string; note?: string }[] }).addons;
  if (!Array.isArray(addons)) return [];
  const seen = new Set<string>();
  return addons.flatMap((e) => {
    if (!e.note || seen.has(`${e.name}\0${e.note}`)) return [];
    seen.add(`${e.name}\0${e.note}`);
    return [{ name: e.name, note: e.note }];
  });
}

function warnings(result: unknown): string[] {
  const list = (result as { warnings?: unknown }).warnings;
  return Array.isArray(list) ? list.filter((w): w is string => typeof w === "string") : [];
}

function hasErrors(result: unknown): boolean {
  const r = result as { addons?: { status: string }[]; issues?: unknown[] };
  if (Array.isArray(r.addons) && r.addons.some((a) => a.status === "error")) return true;
  if (Array.isArray(r.issues) && r.issues.length > 0) return true;
  return false;
}

/** Opens `url` in the default browser; false when the opener is missing or fails. */
async function openUrl(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  try {
    const proc = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function main(argv: string[]): Promise<number> {
  let verbose = argv.includes("--verbose");
  let json = argv.includes("--json");
  let progress = progressRenderer(verbose);
  let state: State | undefined;
  try {
    const { values, positionals } = parse(argv);
    verbose = values.verbose ?? false;
    json = values.json ?? false;
    progress = progressRenderer(verbose);
    const [command, ...rest] = positionals;
    if (values.version) {
      process.stdout.write(`wowget ${VERSION}\n`);
      return 0;
    }
    if (values.help || !command) {
      (command || values.help ? process.stdout : process.stderr).write(HELP);
      return values.help ? 0 : 2;
    }
    let key = command;
    let args = rest;
    if (command === "target") {
      const sub = rest[0];
      if (!sub) throw new UsageError('"target" needs a subcommand: list, add or remove.');
      key = `target ${sub}`;
      args = rest.slice(1);
    }
    const allowed = COMMAND_FLAGS[key];
    const arity = POSITIONALS[key];
    if (!allowed || !arity) throw new UsageError(`Unknown command "${key}". Run "wowget --help".`);
    for (const flag of FLAGS) {
      if (values[flag] !== undefined && !allowed.includes(flag)) {
        throw new UsageError(`--${flag} is not an option of "${key}".`);
      }
    }
    if (args.length < arity[0] || args.length > arity[1]) {
      throw new UsageError(`Wrong number of arguments for "${key}". Run "wowget --help".`);
    }
    if (values.path === "") throw new UsageError("--path must not be empty.");
    if (values.folder === "") throw new UsageError("--folder must not be empty.");
    if (values["game-dir"] === "") throw new UsageError("--game-dir must not be empty.");
    if (values.flavor !== undefined && !isFlavor(values.flavor)) {
      throw new UsageError(`Unknown flavor "${values.flavor}"; expected one of ${FLAVORS.join(", ")}.`);
    }
    const flavor = values.flavor as Flavor | undefined;
    let limit: number | undefined;
    if (values.limit !== undefined) {
      limit = /^[1-9][0-9]*$/.test(values.limit) ? Number(values.limit) : NaN;
      if (!Number.isSafeInteger(limit)) throw new UsageError("--limit must be a positive whole number.");
    }

    const manifest = manifestPath(values.manifest);
    if (key === "tui") {
      // @opentui/react connects to React DevTools on localhost when DEV=true is set at import,
      // which would keep wowget running; nothing else here reads DEV.
      delete process.env.DEV;
      // Imported on demand so the other commands never load the native UI library.
      const tui = await import("./tui/index.tsx");
      if (values.check) {
        process.stdout.write(`ok ${tui.checkTui()}\n`);
        return 0;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new UsageError('"tui" needs an interactive terminal.');
      state = openState(stateDbPath());
      await tui.runTui({ manifestPath: manifest, state, version: VERSION });
      return 0;
    }
    let result: unknown;
    if (key === "self-update") {
      result = await selfUpdate({
        currentVersion: VERSION,
        execPath: await realpath(process.execPath),
        check: values.check,
        force: values.force,
        onDownload: (asset, version) => process.stderr.write(`Downloading ${asset} ${version}\n`),
      });
    } else if (key === "init") {
      result = await ops.init({
        manifestPath: manifest,
        path: values.path,
        flavor,
        name: values.name,
        gameDir: values["game-dir"],
      });
    } else if (key === "target list") {
      result = await ops.targetList({ manifestPath: manifest });
    } else if (key === "target add") {
      if ((values.path === undefined) === (values.folder === undefined) || flavor === undefined) {
        throw new UsageError('"target add" needs --flavor and either --path or --folder.');
      }
      result = await ops.targetAdd({ manifestPath: manifest, name: args[0]!, path: values.path, folder: values.folder, flavor });
    } else if (key === "unpin") {
      result = await ops.unpin({ manifestPath: manifest, name: args[0]! });
    } else {
      state = openState(stateDbPath());
      const base: ops.OpsOptions = {
        manifestPath: manifest,
        state,
        targets: values.target,
        force: values.force,
        onEvent: (e) => progress.onEvent(e),
      };
      if (key === "target remove") result = await ops.targetRemove({ ...base, name: args[0]! });
      else if (key === "search") {
        result = await ops.search({
          ...base,
          query: args.join(" "),
          flavor,
          allFlavors: values["all-flavors"],
          github: values.github,
          limit,
          refresh: values.refresh,
        });
      }
      else if (key === "add") {
        result = await ops.add({ ...base, source: args[0]!, name: values.name, prerelease: values.prerelease, pin: values.pin });
      } else if (key === "remove") result = await ops.remove({ ...base, name: args[0]! });
      else if (key === "list") result = await ops.list(base);
      else if (key === "outdated") result = await ops.outdated(base);
      else if (key === "update") result = await ops.update({ ...base, names: args });
      else if (key === "pin") result = await ops.pin({ ...base, name: args[0]!, pin: args[1] });
      else if (key === "rollback") result = await ops.rollback({ ...base, name: args[0]! });
      else if (key === "reconcile") result = await ops.reconcile({ ...base, adopt: values.adopt });
      else if (key === "doctor") result = await ops.doctor({ ...base, clean: values.clean });
      else if (key === "suggest") result = await ops.suggest({ ...base, names: args });
      else result = await ops.install(base);
    }

    progress.flush();
    process.stdout.write(`${values.json ? JSON.stringify(result, null, 2) : render(key, result)}\n`);
    for (const { name, note } of notes(result)) process.stderr.write(`wowget: note: ${name}: ${note}\n`);
    if (!values.json) for (const warning of warnings(result)) process.stderr.write(`wowget: warning: ${warning}\n`);
    if (key === "suggest" && !values.print && !values.json) {
      const url = (result as ops.SuggestResult).url;
      if (url && !(await openUrl(url))) process.stderr.write("wowget: warning: could not open a browser; open the URL above.\n");
    }
    for (const { name, target, dir } of leftoverDirs(result)) {
      process.stderr.write(
        `wowget: warning: ${name} (${target}): could not delete the old folders moved to ${dir}; remove it by hand.\n`,
      );
    }
    return hasErrors(result) ? 1 : 0;
  } catch (err) {
    progress.flush();
    const usage = err instanceof UsageError || (err instanceof WowgetError && err.code === "usage");
    const text = err instanceof Error ? err.message : String(err);
    if (json) {
      const code = usage ? "usage" : err instanceof WowgetError ? err.code : "unexpected";
      process.stdout.write(`${JSON.stringify({ error: { code, message: text } }, null, 2)}\n`);
      if (verbose && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
      return usage ? 2 : 1;
    }
    if (usage) {
      process.stderr.write(`wowget: ${text}\n`);
      return 2;
    }
    if (err instanceof WowgetError) {
      process.stderr.write(`wowget: ${text}\n`);
      if (verbose && err.stack) process.stderr.write(`${err.stack}\n`);
      return 1;
    }
    process.stderr.write(`wowget: unexpected error: ${text}\n`);
    if (verbose && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    else process.stderr.write("Run again with --verbose for details.\n");
    return 1;
  } finally {
    state?.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
