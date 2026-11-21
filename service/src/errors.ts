/** Error codes the ported source code raises; the API maps them to its own codes. */
export type ErrorCode = "source" | "flavor" | "network" | "rate_limited";

export class WowgetError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WowgetError";
    this.code = code;
  }
}
