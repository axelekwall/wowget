export interface Env {
  DB: D1Database;
  RESOLVE_LIMITER: RateLimit;
  SEARCH_LIMITER: RateLimit;
  /** Read-only token for public GitHub data; requests go unauthenticated without it. */
  GITHUB_TOKEN?: string;
  /** Salt for the daily IP hash that keys rate limits. */
  IP_HASH_SALT?: string;
}
