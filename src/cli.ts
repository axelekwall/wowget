#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { WowgetError } from "./core/errors.ts";
import type { ProgressEvent } from "./core/events.ts";
import { FLAVORS, isFlavor, type Flavor } from "./core/flavor.ts";
import * as ops from "./core/ops.ts";
import { manifestPath, stateDbPath } from "./core/paths.ts";
import { openState, type State } from "./core/state.ts";
import { VERSION } from "./version.ts";

const HELP = `Usage: wowget <command> [options]

Commands:
  init [--path P --flavor F --name N] [--game-dir D]
                                        create the manifest: one target for the AddOns directory P,
                                        or one per World of Warcraft version found in the game dir
  target list                           show the targets and whether their AddOns directories exist
  target add <name> --path P --flavor F add a target
  target remove <name>                  uninstall everything on a target and remove it
  add <source> [--name N] [--prerelease] [--pin ID]
                                        install an addon and add it to the manifest
  remove <name>                         uninstall an addon and drop it from the manifest
  list                                  show manifest addons and what is installed
  outdated                              check every addon for a newer release
  update [name...]                      install newer releases (all addons by default)
  install                               install manifest addons that are not installed

add, remove, list, outdated, update and install act on every target unless
filtered with -t/--target, which can be repeated. "add -t" records the targets
in the manifest; "remove -t" removes the addon from those targets only.

Sources: github:owner/repo, url:https://...
Flavors: ${FLAVORS.join(", ")}

Options:
  -t, --target <name> act on this target only (repeatable)
  --manifest <path>   manifest file (default $WOWGET_MANIFEST, else ${manifestPath(undefined, { ...process.env, WOWGET_MANIFEST: undefined })})
  --json              print the result as JSON
  --force             install over unmanaged folders and unverifiable flavors
  --verbose           show every progress step and stack traces
  -h, --help          show this help
  --version           show the version
`;

type Flag = "path" | "flavor" | "name" | "prerelease" | "pin" | "target" | "game-dir";
const FLAGS: Flag[] = ["path", "flavor", "name", "prerelease", "pin", "target", "game-dir"];

const COMMAND_FLAGS: Record<string, Flag[]> = {
  init: ["path", "flavor", "name", "game-dir"],
  "target list": [],
  "target add": ["path", "flavor"],
  "target remove": [],
  add: ["name", "prerelease", "pin", "target"],
  remove: ["target"],
  list: ["target"],
  outdated: ["target"],
  update: ["target"],
  install: ["target"],
};

const POSITIONALS: Record<string, [min: number, max: number]> = {
  init: [0, 0],
  "target list": [0, 0],
  "target add": [1, 1],
  "target remove": [1, 1],
  add: [1, 1],
  remove: [1, 1],
  list: [0, 0],
  outdated: [0, 0],
  update: [0, Infinity],
  install: [0, 0],
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
      if (event.type === "download:start") {
        write(`${event.addon}: downloading ${event.filename}`);
        openLine = true;
      } else if (event.type === "download:done" && openLine) {
        write(` (${formatBytes(event.bytes)})\n`);
        openLine = false;
      } else if (verbose && event.type !== "download:progress") {
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
          ...r.targets.map((t) => [t.name, t.flavor, `${t.path}${t.createdAddonsDir ? " (created)" : ""}`]),
        ]),
      ].join("\n");
    }
    case "target list": {
      const r = result as ops.TargetListResult;
      if (!r.targets.length) return 'No targets in the manifest. Add one with "wowget target add".';
      return table([
        ["TARGET", "FLAVOR", "PATH", "EXISTS"],
        ...r.targets.map((t) => [t.name, t.flavor, t.path, t.exists ? "yes" : "no"]),
      ]);
    }
    case "target add": {
      const r = result as ops.TargetAddResult;
      const lines = [`Added target ${r.target.name} (${r.target.flavor}) at ${r.target.path}`];
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
    case "add": {
      const r = result as ops.AddResult;
      return r.addons.map((a) => `Added ${r.name} ${a.version} to ${a.target} (${a.folders.join(", ")})`).join("\n");
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

function hasErrors(result: unknown): boolean {
  const addons = (result as { addons?: { status: string }[] }).addons;
  return Array.isArray(addons) && addons.some((a) => a.status === "error");
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
    if (values["game-dir"] === "") throw new UsageError("--game-dir must not be empty.");
    if (values.flavor !== undefined && !isFlavor(values.flavor)) {
      throw new UsageError(`Unknown flavor "${values.flavor}"; expected one of ${FLAVORS.join(", ")}.`);
    }
    const flavor = values.flavor as Flavor | undefined;

    const manifest = manifestPath(values.manifest);
    let result: unknown;
    if (key === "init") {
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
      if (values.path === undefined || flavor === undefined) throw new UsageError('"target add" needs --path and --flavor.');
      result = await ops.targetAdd({ manifestPath: manifest, name: args[0]!, path: values.path, flavor });
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
      else if (key === "add") {
        result = await ops.add({ ...base, source: args[0]!, name: values.name, prerelease: values.prerelease, pin: values.pin });
      } else if (key === "remove") result = await ops.remove({ ...base, name: args[0]! });
      else if (key === "list") result = await ops.list(base);
      else if (key === "outdated") result = await ops.outdated(base);
      else if (key === "update") result = await ops.update({ ...base, names: args });
      else result = await ops.install(base);
    }

    progress.flush();
    process.stdout.write(`${values.json ? JSON.stringify(result, null, 2) : render(key, result)}\n`);
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
