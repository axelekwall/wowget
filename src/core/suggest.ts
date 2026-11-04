import { parseSource } from "./sources/parse.ts";

/** The new-issue page of the registry suggestion form. */
export const SUGGEST_ISSUE_URL = "https://github.com/axelekwall/wowget/issues/new";
export const SUGGEST_TEMPLATE = "registry-addon.yml";
/** GitHub rejects longer URLs. */
export const MAX_ISSUE_URL_LENGTH = 8000;

export interface Suggestion {
  source: string;
  name?: string;
}

/**
 * A source string for comparing registry and manifest entries: GitHub owner and repo are
 * case-insensitive. Unparseable strings compare as they are.
 */
export function sourceKey(source: string): string {
  try {
    const spec = parseSource(source);
    if (spec.kind === "github") return `github:${spec.owner}/${spec.repo}`.toLowerCase();
    return spec.raw;
  } catch {
    return source;
  }
}

/** One line of the issue form's addons field. */
export function suggestionLine({ source, name }: Suggestion): string {
  return name ? `${source} ${name}` : source;
}

/** The new-issue URL with the addons field prefilled, one line per suggestion. */
export function suggestIssueUrl(suggestions: Suggestion[]): string {
  const params = new URLSearchParams({
    template: SUGGEST_TEMPLATE,
    title: `Registry: add ${suggestions.map((s) => s.name ?? s.source).join(", ")}`.slice(0, 200),
    addons: suggestions.map(suggestionLine).join("\n"),
  });
  return `${SUGGEST_ISSUE_URL}?${params}`;
}

/**
 * Suggestions from the issue form's addons field: `<source>` or `<source> <name>` per line.
 * Blank lines, `#` comments, code fences and GitHub's "_No response_" are ignored.
 */
export function parseSuggestionLines(text: string): Suggestion[] {
  const out: Suggestion[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("```") || line === "_No response_") continue;
    const match = /^(\S+)(?:\s+(.+))?$/.exec(line)!;
    const name = match[2]?.trim();
    out.push(name ? { source: match[1]!, name } : { source: match[1]! });
  }
  return out;
}

/** The `### Addons` section of an issue form body, or the whole body when it has none. */
export function addonsSection(body: string): string {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+addons\s*$/i.test(l.trim()));
  if (start === -1) return body;
  const rest = lines.slice(start + 1);
  // A "#" line inside the fenced field is a comment, not the next heading.
  let fenced = false;
  const end = rest.findIndex((l) => {
    if (l.trim().startsWith("```")) fenced = !fenced;
    return !fenced && /^#{1,6}\s/.test(l.trim());
  });
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}
