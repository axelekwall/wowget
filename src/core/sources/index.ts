import { githubSource } from "./github.ts";
import type { SourceSpec } from "./parse.ts";
import type { Source } from "./types.ts";
import { urlSource } from "./url.ts";
import { wowiSource } from "./wowi.ts";

export function sourceFor(spec: SourceSpec): Source {
  if (spec.kind === "github") return githubSource(spec);
  if (spec.kind === "wowi") return wowiSource(spec);
  return urlSource(spec);
}
