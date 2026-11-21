import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ApiErrorCode =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "too_large"
  | "rate_limited"
  | "upstream"
  | "internal";

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
  headers?: Record<string, string>,
) {
  return c.json(errorBody(code, message), status, headers);
}
