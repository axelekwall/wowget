// The TUI's table model: one row per (addon, target), merged from list, outdated and update results.
import type { ListEntry, OutdatedEntry, UpdateEntry } from "../core/ops.ts";

export type RowStatus = "ok" | "outdated" | "not installed" | "missing" | "error";

/** What the TUI is doing to a row right now. */
export type Activity =
  | { kind: "checking" }
  | { kind: "queued" }
  | { kind: "downloading"; received: number; total?: number }
  | { kind: "installing" };

export interface Row {
  key: string;
  name: string;
  target: string;
  installed: string | null;
  /** Null until outdated has answered for the row. */
  latest: string | null;
  status: RowStatus;
  error?: string;
  pinned: boolean;
  activity?: Activity;
}

export const rowKey = (name: string, target: string) => `${name.toLowerCase()}\0${target}`;

export function fromList(entries: ListEntry[], pinned: Set<string>): Row[] {
  return entries.map((e) => ({
    key: rowKey(e.name, e.target),
    name: e.name,
    target: e.target,
    installed: e.version,
    latest: null,
    status: e.status,
    pinned: pinned.has(e.name.toLowerCase()),
  }));
}

export function applyOutdated(rows: Row[], entries: OutdatedEntry[]): Row[] {
  const byKey = new Map(entries.map((e) => [rowKey(e.name, e.target), e]));
  return rows.map((row) => {
    const e = byKey.get(row.key);
    if (!e) return row;
    const next: Row = { ...row, activity: undefined, error: undefined };
    switch (e.status) {
      case "current":
        return { ...next, installed: e.version, latest: e.version, status: "ok" };
      case "outdated":
        return { ...next, installed: e.installed, latest: e.latest, status: "outdated" };
      case "not installed":
        return { ...next, installed: null, latest: e.latest, status: "not installed" };
      case "missing":
        return { ...next, installed: e.installed, latest: e.latest, status: "missing" };
      case "error":
        return { ...next, status: "error", error: e.error };
    }
  });
}

/** Rows an update result touched, with the keys whose status changed. */
export function applyUpdate(rows: Row[], entries: UpdateEntry[]): { rows: Row[]; changed: Set<string> } {
  const byKey = new Map(entries.map((e) => [rowKey(e.name, e.target), e]));
  const changed = new Set<string>();
  const next = rows.map((row) => {
    const e = byKey.get(row.key);
    if (!e) return row;
    const base: Row = { ...row, activity: undefined, error: undefined };
    let updated: Row;
    switch (e.status) {
      case "current":
      case "skipped":
        updated = { ...base, installed: e.version, latest: row.latest ?? e.version, status: row.status === "outdated" ? "outdated" : "ok" };
        break;
      case "updated":
        updated = { ...base, installed: e.to, latest: e.to, status: "ok" };
        break;
      case "installed":
      case "repaired":
        updated = { ...base, installed: e.version, latest: e.version, status: "ok" };
        break;
      case "error":
        updated = { ...base, status: "error", error: e.error };
        break;
    }
    if (updated.status !== row.status || updated.installed !== row.installed) changed.add(row.key);
    return updated;
  });
  return { rows: next, changed };
}

/** Manifest names per target, in row order, so each update call covers exactly the chosen rows. */
export function namesByTarget(rows: Row[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const names = out.get(row.target) ?? [];
    if (!names.includes(row.name)) names.push(row.name);
    out.set(row.target, names);
  }
  return out;
}

export function setActivity(rows: Row[], keys: Set<string>, activity: Activity | undefined): Row[] {
  return rows.map((row) => (keys.has(row.key) ? { ...row, activity } : row));
}

export interface UpdateSummary {
  updated: number;
  installed: number;
  current: number;
  errors: number;
}

export function summarise(entries: UpdateEntry[]): UpdateSummary {
  const s: UpdateSummary = { updated: 0, installed: 0, current: 0, errors: 0 };
  for (const e of entries) {
    if (e.status === "updated") s.updated++;
    else if (e.status === "installed" || e.status === "repaired") s.installed++;
    else if (e.status === "error") s.errors++;
    else s.current++;
  }
  return s;
}

export function describeSummary(s: UpdateSummary): string {
  const parts: string[] = [];
  if (s.updated) parts.push(`${s.updated} updated`);
  if (s.installed) parts.push(`${s.installed} installed`);
  if (s.current) parts.push(`${s.current} already current`);
  if (s.errors) parts.push(`${s.errors} failed`);
  return parts.length ? parts.join(", ") : "Nothing to update";
}
