export type ProgressEvent =
  | { type: "download:start"; addon: string; url: string; filename: string }
  | { type: "download:progress"; addon: string; received: number; total?: number }
  | { type: "download:done"; addon: string; bytes: number; sha256: string; cached: boolean }
  | { type: "extract"; addon: string }
  | { type: "verify"; addon: string; folders: string[] }
  | { type: "swap"; addon: string; folders: string[] }
  | { type: "done"; addon: string; releaseId: string; folders: string[] }
  | { type: "catalog:download"; url: string }
  | { type: "registry:stale"; message: string }
  | { type: "target:absent"; target: string; message: string };

export type OnEvent = (event: ProgressEvent) => void;
