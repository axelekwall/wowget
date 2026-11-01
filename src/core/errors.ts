export type ErrorCode =
  | "usage"
  | "manifest"
  | "manifest_exists"
  | "not_found"
  | "duplicate"
  | "source"
  | "flavor"
  | "conflict"
  | "zip"
  | "network"
  | "rate_limited"
  | "io";

export class WowgetError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WowgetError";
    this.code = code;
  }
}
