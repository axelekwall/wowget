import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Env as ServiceEnv } from "../src/env.ts";

declare global {
  namespace Cloudflare {
    interface Env extends ServiceEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
