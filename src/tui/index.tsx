import { createCliRenderer, resolveRenderLib } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App, type TuiContext } from "./app.tsx";

export async function runTui(ctx: TuiContext): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
  createRoot(renderer).render(<App ctx={ctx} onQuit={() => renderer.destroy()} />);
  await renderer.closed;
}

/** Loads the native library and returns the platform it was loaded for; throws when it cannot load. */
export function checkTui(): string {
  resolveRenderLib();
  return `${process.platform}-${process.arch}`;
}
