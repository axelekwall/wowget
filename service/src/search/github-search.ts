import { WowgetError } from "../errors.ts";
import { FLAVORS, type Flavor, type Support } from "../flavor.ts";
import { HttpStatusError, type Http } from "../http.ts";
import { parseSource } from "../sources/parse.ts";
import type { SearchRow } from "./types.ts";

interface GithubRepo {
  full_name?: string;
  name?: string;
  description?: string | null;
  stargazers_count?: number;
  pushed_at?: string | null;
  html_url?: string;
}

const PER_PAGE = 20;

export function githubSearchUrl(query: string): string {
  const q = `${query} topic:wow-addon fork:false archived:false`;
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${PER_PAGE}`;
}

/** Keeps the repository fields search reads, so cached results stay small. */
function projectSearch(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { items?: unknown }).items)) return value;
  const items = (value as { items: unknown[] }).items.map((item) => {
    if (typeof item !== "object" || item === null) return item;
    const { full_name, name, description, stargazers_count, pushed_at, html_url } = item as Record<string, unknown>;
    return { full_name, name, description, stargazers_count, pushed_at, html_url };
  });
  return { items };
}

/** Repositories tagged `wow-addon` that match `query`, most starred first. Nothing about their releases is fetched. */
export async function searchGithub(http: Http, query: string): Promise<SearchRow[]> {
  let data: { items?: GithubRepo[] };
  try {
    data = await http.getJson(githubSearchUrl(query), {
      headers: { Accept: "application/vnd.github+json" },
      project: projectSearch,
    });
  } catch (err) {
    if (err instanceof HttpStatusError && (err.status === 403 || err.status === 429)) {
      throw new WowgetError("rate_limited", "the service reached the GitHub search rate limit; try again in a minute.", {
        cause: err,
      });
    }
    throw err;
  }
  const unknown = Object.fromEntries(FLAVORS.map((f) => [f, "unknown"])) as Record<Flavor, Support>;
  const rows: SearchRow[] = [];
  for (const repo of Array.isArray(data?.items) ? data.items : []) {
    if (typeof repo?.full_name !== "string") continue;
    const source = `github:${repo.full_name}`;
    try {
      parseSource(source);
    } catch {
      continue;
    }
    const row: SearchRow = {
      name: typeof repo.name === "string" && repo.name ? repo.name : repo.full_name,
      source,
      origin: "github",
      flavors: { ...unknown },
      aliases: [],
      folders: [],
      stars: typeof repo.stargazers_count === "number" ? repo.stargazers_count : 0,
    };
    if (typeof repo.description === "string" && repo.description) row.description = repo.description;
    if (typeof repo.pushed_at === "string" && repo.pushed_at) row.updatedAt = repo.pushed_at;
    if (typeof repo.html_url === "string") row.url = repo.html_url;
    rows.push(row);
  }
  return rows;
}
