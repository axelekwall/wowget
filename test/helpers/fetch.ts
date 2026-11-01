import type { FetchFn } from "../../src/core/http.ts";

export interface Recorded {
  url: string;
  headers: Headers;
}

/** A fake fetch answering from `routes` by exact URL; unknown URLs get a 404. */
export function fakeFetch(routes: Record<string, (req: Recorded) => Response>): { fetch: FetchFn; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetch: FetchFn = async (input, init) => {
    const req = { url: input, headers: new Headers(init?.headers) };
    requests.push(req);
    const route = routes[input];
    return route ? route(req) : new Response("not found", { status: 404 });
  };
  return { fetch, requests };
}

export const json = (value: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
