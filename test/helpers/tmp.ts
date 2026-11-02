import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "bun:test";

/**
 * Returns a function that creates temp directories, all removed after each test.
 * Bun runs afterEach hooks in declaration order, and Windows cannot delete open files,
 * so call this after registering the hooks that close databases or servers.
 */
export function useTempDirs(): () => Promise<string> {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), "wowget-test-"));
    dirs.push(dir);
    return dir;
  };
}
