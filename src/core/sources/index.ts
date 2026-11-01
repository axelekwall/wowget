import { githubSource } from "./github.ts";
import type { SourceSpec } from "./parse.ts";
import type { Source } from "./types.ts";
import { urlSource } from "./url.ts";

export function sourceFor(spec: SourceSpec): Source {
  return spec.kind === "github" ? githubSource(spec) : urlSource(spec);
}
