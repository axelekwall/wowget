#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { WowgetError } from "./core/errors.ts";
import type { ProgressEvent } from "./core/events.ts";
import { FLAVORS, isFlavor } from "./core/flavor.ts";
import * as ops from "./core/ops.ts";
import { manifestPath, stateDbPath } from "./core/paths.ts";
import { openState, type State } from "./core/state.ts";

const HELP = `Usage: wowget <command> [options]

Commands:
  init [--path P] [--flavor F]          create the manifest
  add <source> [--name N] [--prerelease] [--pin ID]
                                        install an addon and add it to the manifest
  remove <name>                         uninstall an addon and drop it from the manifest
  list                                  show manifest addons and what is installed
  outdated                              check every addon for a newer release
  update [name...]                      install newer releases (all addons by default)
  install                               install manifest addons that are not installed

Sources: github:owner/repo, url:https://...
Flavors: ${FLAVORS.join(", ")}

Options:
  --manifest <path>   manifest file (default ~/.config/wowget/wowget.toml, or $WOWGET_MANIFEST)
  --json              print the result as JSON
  --force             install over unmanaged folders and unverifiable flavors
  --verbose           show every progress step and stack traces
  -h, --help          show this help
`;

const COMMAND_FLAGS: Record<string, string[]> = {
  init: ["path", "flavor"],
  add: ["name", "prerelease", "pin"],
  remove: [],
  list: [],
  outdated: [],
  update: [],
  install: [],
};

const POSITIONALS: Record<string, [min: number, max: number]> = {
  init: [0, 0],
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
        path: { type: "string" },
        flavor: { type: "string" },
        name: { type: "string" },
        prerelease: { type: "boolean" },
        pin: { type: "string" },
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
          return [a.name, "current", a.version];
        case "updated":
          return [a.name, "updated", `${a.from} -> ${a.to}`];
        case "installed":
          return [a.name, "installed", a.version];
        case "skipped":
          return [a.name, "skipped", `${a.version} already installed`];
        case "error":
          return [a.name, "error", a.error];
      }
    }),
  );
}

function render(command: string, result: unknown): string {
  switch (command) {
    case "init": {
      const r = result as ops.InitResult;
      const lines = [`Created ${r.manifestPath}`, `  path:   ${r.install.path}`, `  flavor: ${r.install.flavor}`];
      if (r.createdAddonsDir) lines.push(`Created ${r.install.path}`);
      return lines.join("\n");
    }
    case "add": {
      const r = result as ops.AddResult;
      return `Added ${r.name} ${r.version} (${r.folders.join(", ")})`;
    }
    case "remove": {
      const r = result as ops.RemoveResult;
      if (!r.wasInstalled) return `Removed ${r.name} from the manifest (it was not installed)`;
      return `Removed ${r.name}${r.removedFolders.length ? ` (${r.removedFolders.join(", ")})` : ""}`;
    }
    case "list": {
      const r = result as ops.ListResult;
      if (!r.addons.length) return "No addons in the manifest.";
      return table([
        ["NAME", "VERSION", "STATUS", "SOURCE"],
        ...r.addons.map((a) => [
          a.name,
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
        ["NAME", "INSTALLED", "LATEST", "STATUS"],
        ...r.addons.map((a) => {
          switch (a.status) {
            case "current":
              return [a.name, a.version, a.version, "current"];
            case "outdated":
              return [a.name, a.installed, a.latest, "outdated"];
            case "not installed":
              return [a.name, "-", a.latest, "not installed"];
            case "error":
              return [a.name, "-", "-", `error: ${a.error}`];
          }
        }),
      ]);
    }
    default:
      return renderUpdate(result as ops.UpdateResult);
  }
}

function hasErrors(result: unknown): boolean {
  const addons = (result as { addons?: { status: string }[] }).addons;
  return Array.isArray(addons) && addons.some((a) => a.status === "error");
}

async function main(argv: string[]): Promise<number> {
  let verbose = argv.includes("--verbose");
  let progress = progressRenderer(verbose);
  let state: State | undefined;
  try {
    const { values, positionals } = parse(argv);
    verbose = values.verbose ?? false;
    progress = progressRenderer(verbose);
    const [command, ...args] = positionals;
    if (values.help || !command) {
      (command || values.help ? process.stdout : process.stderr).write(HELP);
      return values.help ? 0 : 2;
    }
    const allowed = COMMAND_FLAGS[command];
    const arity = POSITIONALS[command];
    if (!allowed || !arity) throw new UsageError(`Unknown command "${command}". Run "wowget --help".`);
    for (const flag of ["path", "flavor", "name", "prerelease", "pin"] as const) {
      if (values[flag] !== undefined && !allowed.includes(flag)) {
        throw new UsageError(`--${flag} is not an option of "${command}".`);
      }
    }
    if (args.length < arity[0] || args.length > arity[1]) {
      throw new UsageError(`Wrong number of arguments for "${command}". Run "wowget --help".`);
    }
    if (values.flavor !== undefined && !isFlavor(values.flavor)) {
      throw new UsageError(`Unknown flavor "${values.flavor}"; expected one of ${FLAVORS.join(", ")}.`);
    }

    const manifest = manifestPath(values.manifest);
    let result: unknown;
    if (command === "init") {
      result = await ops.init({ manifestPath: manifest, path: values.path, flavor: values.flavor as ops.InitOptions["flavor"] });
    } else {
      state = openState(stateDbPath());
      const base: ops.OpsOptions = { manifestPath: manifest, state, force: values.force, onEvent: (e) => progress.onEvent(e) };
      if (command === "add") {
        result = await ops.add({ ...base, source: args[0]!, name: values.name, prerelease: values.prerelease, pin: values.pin });
      } else if (command === "remove") result = await ops.remove({ ...base, name: args[0]! });
      else if (command === "list") result = await ops.list(base);
      else if (command === "outdated") result = await ops.outdated(base);
      else if (command === "update") result = await ops.update({ ...base, names: args });
      else result = await ops.install(base);
    }

    progress.flush();
    process.stdout.write(`${values.json ? JSON.stringify(result, null, 2) : render(command, result)}\n`);
    return hasErrors(result) ? 1 : 0;
  } catch (err) {
    progress.flush();
    if (err instanceof UsageError || (err instanceof WowgetError && err.code === "usage")) {
      process.stderr.write(`wowget: ${err.message}\n`);
      return 2;
    }
    if (err instanceof WowgetError) {
      process.stderr.write(`wowget: ${err.message}\n`);
      if (verbose && err.stack) process.stderr.write(`${err.stack}\n`);
      return 1;
    }
    const text = err instanceof Error ? err.message : String(err);
    process.stderr.write(`wowget: unexpected error: ${text}\n`);
    if (verbose && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    else process.stderr.write("Run again with --verbose for details.\n");
    return 1;
  } finally {
    state?.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
