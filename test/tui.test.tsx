import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { zipSync } from "fflate";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as ops from "../src/core/ops.ts";
import { openState, type State } from "../src/core/state.ts";
import { App, type TuiContext } from "../src/tui/app.tsx";
import { useTempDirs } from "./helpers/tmp.ts";

const text = (s: string) => new TextEncoder().encode(s);

let state: State | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let ui: TestRendererSetup | undefined;
afterEach(async () => {
  await ui?.dispose();
  ui = undefined;
  state?.close();
  state = undefined;
  server?.stop(true);
  server = undefined;
});

const tempDir = useTempDirs();

/** Serves `/<Name>.zip` from `files[name]`, honouring If-None-Match like a real host. */
function serve(files: Record<string, Record<string, string>>) {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const name = new URL(req.url).pathname.replace(/^\/|\.zip$/g, "");
      const content = files[name];
      if (!content) return new Response("not found", { status: 404 });
      const zip = zipSync(Object.fromEntries(Object.entries(content).map(([k, v]) => [k, text(v)])), {
        mtime: new Date("2026-01-01T00:00:00Z"),
      });
      const etag = `"${Bun.hash(zip).toString(16)}"`;
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
      return new Response(zip, { headers: { etag } });
    },
  });
  return `http://localhost:${server.port}`;
}

const addon = (name: string, version: number) => ({
  [`${name}/${name}_Forever.toc`]: `## Version: ${version}\n`,
  [`${name}/core.lua`]: `v${version}`,
});

/** A manifest with targets "forever" and "era" (both flavor forever) and the given addons installed on both. */
async function setup(names: string[]) {
  const root = await tempDir();
  state = openState(join(root, "state", "state.db"));
  const manifestPath = join(root, "config", "wowget.toml");
  const ctx: TuiContext = { manifestPath, state, cacheDir: join(root, "cache"), env: {}, version: "test" };
  const files: Record<string, Record<string, string>> = Object.fromEntries(names.map((n) => [n, addon(n, 1)]));
  const base = serve(files);
  await ops.init({ manifestPath, path: join(root, "forever"), name: "forever" });
  await ops.targetAdd({ manifestPath, name: "era", path: join(root, "era"), flavor: "forever" });
  for (const name of names) await ops.add({ ...ctx, source: `url:${base}/${name}.zip` });
  return { root, ctx, files };
}

async function open(ctx: TuiContext, onQuit = () => {}) {
  // Mounted without act(): the app's state changes come from real network and disk work,
  // so React schedules them itself and frames are polled in real time.
  const setup = await createTestRenderer({ width: 100, height: 20 });
  ui = setup;
  createRoot(setup.renderer).render(<App ctx={ctx} onQuit={onQuit} />);
  const waitForFrame = async (predicate: (frame: string) => boolean, timeoutMs = 3_000): Promise<string> => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      if (predicate(frame)) return frame;
      if (Date.now() > end) throw new Error(`Timed out; last frame:\n${frame}`);
      await Bun.sleep(10);
    }
  };
  return { ...setup, waitForFrame };
}

/** Screen position of the first occurrence of `needle` in a captured frame. */
function locate(frame: string, needle: string): { x: number; y: number } {
  const lines = frame.split("\n");
  const y = lines.findIndex((l) => l.includes(needle));
  if (y < 0) throw new Error(`"${needle}" is not on screen:\n${frame}`);
  return { x: lines[y]!.indexOf(needle), y };
}

const lineWith = (frame: string, needle: string) => frame.split("\n").find((l) => l.includes(needle)) ?? "";

describe("tui main screen", () => {
  test("lists each addon per target and marks the outdated ones", async () => {
    const { ctx, files } = await setup(["Alpha", "Beta"]);
    files.Alpha = addon("Alpha", 2);
    const { waitForFrame } = await open(ctx);

    const frame = await waitForFrame((f) => f.includes("need an update"));
    expect(lineWith(frame, "Alpha").match(/outdated/g)).toHaveLength(1);
    expect(frame.split("\n").filter((l) => /Alpha\s+(forever|era)\s.*outdated/.test(l))).toHaveLength(2);
    expect(frame.split("\n").filter((l) => /Beta\s+(forever|era)\s.*ok/.test(l))).toHaveLength(2);
    expect(frame).toContain("2 addons need an update");
  });

  test("U updates every visible row and reports the result", async () => {
    const { root, ctx, files } = await setup(["Alpha"]);
    files.Alpha = addon("Alpha", 2);
    const { waitForFrame, mockInput } = await open(ctx);
    await waitForFrame((f) => f.includes("need an update"));

    mockInput.pressKey("U", { shift: true });
    const frame = await waitForFrame((f) => f.includes("2 updated"));
    expect(frame).not.toContain("outdated");
    for (const target of ["forever", "era"]) {
      expect(await readFile(join(root, target, "Alpha", "core.lua"), "utf8")).toBe("v2");
    }
  });

  test("clicking a tab and then Update updates only that target", async () => {
    const { root, ctx, files } = await setup(["Alpha"]);
    files.Alpha = addon("Alpha", 2);
    const { waitForFrame, mockMouse } = await open(ctx);
    let frame = await waitForFrame((f) => f.includes("need an update"));

    const tab = locate(frame, "3 era");
    await mockMouse.click(tab.x + 1, tab.y);
    frame = await waitForFrame((f) => !f.includes("TARGET"));
    const button = locate(frame, "u Update");
    await mockMouse.click(button.x + 1, button.y);
    await waitForFrame((f) => f.includes("1 updated"));

    expect(await readFile(join(root, "era", "Alpha", "core.lua"), "utf8")).toBe("v2");
    expect(await readFile(join(root, "forever", "Alpha", "core.lua"), "utf8")).toBe("v1");
  });

  test("space selects rows and u updates only the selection", async () => {
    const { root, ctx, files } = await setup(["Alpha", "Beta"]);
    files.Alpha = addon("Alpha", 2);
    files.Beta = addon("Beta", 2);
    const { waitForFrame, mockInput } = await open(ctx);
    await waitForFrame((f) => f.includes("need an update"));

    // Rows are Alpha/era, Alpha/forever, Beta/era, Beta/forever.
    mockInput.pressKey(" ");
    mockInput.pressKey("ARROW_DOWN");
    mockInput.pressKey("ARROW_DOWN");
    mockInput.pressKey("ARROW_DOWN");
    mockInput.pressKey(" ");
    await waitForFrame((f) => f.includes("Update 2 selected"));
    mockInput.pressKey("u");
    await waitForFrame((f) => f.includes("2 updated"));

    expect(await readFile(join(root, "era", "Alpha", "core.lua"), "utf8")).toBe("v2");
    expect(await readFile(join(root, "forever", "Beta", "core.lua"), "utf8")).toBe("v2");
    expect(await readFile(join(root, "forever", "Alpha", "core.lua"), "utf8")).toBe("v1");
    expect(await readFile(join(root, "era", "Beta", "core.lua"), "utf8")).toBe("v1");
  });

  test("a failing addon shows its error when the cursor is on it", async () => {
    const { ctx, files } = await setup(["Alpha"]);
    delete files.Alpha;
    const { waitForFrame, mockInput } = await open(ctx);

    const frame = await waitForFrame((f) => f.includes("Alpha (era):"));
    expect(lineWith(frame, "Alpha (era):")).toContain("HTTP 404");
    expect(frame.split("\n").filter((l) => /Alpha\s+(forever|era)\s.*error/.test(l))).toHaveLength(2);
    mockInput.pressKey("ARROW_DOWN");
    await waitForFrame((f) => f.includes("Alpha (forever): GET"));
  });

  test("without a manifest it says how to create one", async () => {
    const root = await tempDir();
    state = openState(join(root, "state.db"));
    const { waitForFrame } = await open({ manifestPath: join(root, "none.toml"), state, env: {}, version: "test" });
    expect(await waitForFrame((f) => f.includes("No manifest yet"))).toContain('Run "wowget init"');
  });

  test("q quits when nothing is running", async () => {
    const { ctx } = await setup([]);
    let quits = 0;
    const { waitForFrame, mockInput } = await open(ctx, () => quits++);
    await waitForFrame((f) => f.includes("Everything is up to date"));
    mockInput.pressKey("q");
    expect(quits).toBe(1);
  });
});
