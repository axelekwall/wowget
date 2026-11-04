import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProgressEvent } from "../core/events.ts";
import { readManifest } from "../core/manifest.ts";
import * as ops from "../core/ops.ts";
import {
  applyOutdated,
  applyUpdate,
  describeSummary,
  fromList,
  namesByTarget,
  rowKey,
  setActivity,
  summarise,
  type Activity,
  type Row,
} from "./rows.ts";

export type TuiContext = Omit<ops.OpsOptions, "targets" | "force" | "onEvent"> & { version: string };

const COLOR = {
  text: "#c0caf5",
  dim: "#737aa2",
  accent: "#7aa2f7",
  onAccent: "#1a1b26",
  ok: "#9ece6a",
  warn: "#e0af68",
  error: "#f7768e",
  selected: "#bb9af7",
  cursorBg: "#2f3549",
  flashBg: "#2e3b2a",
  buttonBg: "#292e42",
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FLASH_MS = 1200;
/** Progress events can arrive per network chunk; the row repaints at most this often. */
const PROGRESS_MS = 50;

type Tone = "info" | "ok" | "warn" | "error";
interface Message {
  text: string;
  tone: Tone;
}

const toneColor = (tone: Tone) =>
  tone === "ok" ? COLOR.ok : tone === "warn" ? COLOR.warn : tone === "error" ? COLOR.error : COLOR.dim;

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function progressBar(received: number, total: number | undefined, width: number): string {
  if (!total) return `${(received / 1024 / 1024).toFixed(1)} MB`;
  const ratio = Math.min(1, received / total);
  const filled = Math.round(ratio * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${Math.round(ratio * 100)}%`;
}

function statusCell(row: Row, frame: string): { text: string; color: string } {
  const activity: Activity | undefined = row.activity;
  if (activity?.kind === "checking") return { text: `${frame} checking`, color: COLOR.dim };
  if (activity?.kind === "queued") return { text: "· queued", color: COLOR.dim };
  if (activity?.kind === "downloading") return { text: progressBar(activity.received, activity.total, 10), color: COLOR.accent };
  if (activity?.kind === "installing") return { text: `${frame} installing`, color: COLOR.accent };
  const pin = row.pinned ? " · pinned" : "";
  switch (row.status) {
    case "ok":
      return { text: `ok${pin}`, color: COLOR.ok };
    case "outdated":
      return { text: `outdated${pin}`, color: COLOR.warn };
    case "not installed":
      return { text: `not installed${pin}`, color: COLOR.warn };
    case "missing":
      return { text: `missing${pin}`, color: COLOR.error };
    case "error":
      return { text: "error", color: COLOR.error };
  }
}

function Button(props: { label: string; hotkey: string; disabled?: boolean; onPress: () => void }) {
  const [hover, setHover] = useState(false);
  const active = hover && !props.disabled;
  return (
    <box
      height={1}
      paddingLeft={1}
      paddingRight={1}
      marginRight={1}
      backgroundColor={active ? COLOR.accent : COLOR.buttonBg}
      onMouseDown={(e: MouseEvent) => {
        if (e.button === 0 && !props.disabled) props.onPress();
      }}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      <text>
        <span fg={props.disabled ? COLOR.dim : active ? COLOR.onAccent : COLOR.accent}>{props.hotkey}</span>
        <span fg={props.disabled ? COLOR.dim : active ? COLOR.onAccent : COLOR.text}>{` ${props.label}`}</span>
      </text>
    </box>
  );
}

function Tab(props: { label: string; active: boolean; onPress: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <box
      height={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.active ? COLOR.accent : hover ? COLOR.buttonBg : undefined}
      onMouseDown={(e: MouseEvent) => {
        if (e.button === 0) props.onPress();
      }}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      <text fg={props.active ? COLOR.onAccent : COLOR.text}>{props.label}</text>
    </box>
  );
}

export function App({ ctx, onQuit }: { ctx: TuiContext; onQuit: () => void }) {
  const { width } = useTerminalDimensions();
  const rowsRef = useRef<Row[]>([]);
  const [rows, setRowsState] = useState<Row[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [tab, setTab] = useState(0);
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<null | "checking" | "updating">(null);
  const [message, setMessage] = useState<Message>({ text: "Loading", tone: "info" });
  const [manifestMissing, setManifestMissing] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [frame, setFrame] = useState(0);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const forceQuit = useRef(false);
  const scroll = useRef<ScrollBoxRenderable>(null);

  // Every row change goes through here so async handlers never work on a stale copy.
  const mutateRows = useCallback((fn: (rows: Row[]) => Row[]) => {
    rowsRef.current = fn(rowsRef.current);
    setRowsState(rowsRef.current);
  }, []);

  const visible = tab === 0 ? rows : rows.filter((r) => r.target === targets[tab - 1]);
  const current = visible[Math.min(cursor, visible.length - 1)];
  // Keys can arrive faster than renders, and the keyboard handler is the one from the last render,
  // so moves and toggles go through a ref instead of the rendered cursor.
  const moveCursor = (to: (c: number) => number) => {
    cursorRef.current = Math.max(0, Math.min(visible.length - 1, to(cursorRef.current)));
    setCursor(cursorRef.current);
  };
  const animating = rows.some((r) => r.activity && r.activity.kind !== "queued");

  useEffect(() => {
    if (!animating) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(timer);
  }, [animating]);

  useEffect(() => {
    if (!flash.size) return;
    const timer = setTimeout(() => setFlash(new Set()), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  useEffect(() => {
    if (cursor >= visible.length && visible.length) moveCursor(() => visible.length - 1);
  }, [cursor, visible.length]);

  useEffect(() => {
    scroll.current?.scrollChildIntoView(`row-${cursor}`);
  }, [cursor]);

  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    if (!(await Bun.file(ctx.manifestPath).exists())) {
      setManifestMissing(true);
      setMessage({ text: `No manifest at ${ctx.manifestPath}`, tone: "warn" });
      return;
    }
    setBusy("checking");
    busyRef.current = "checking";
    try {
      const manifest = await readManifest(ctx.manifestPath);
      const pinned = new Set(manifest.addons.filter((a) => a.pin !== undefined).map((a) => a.name.toLowerCase()));
      const listed = await ops.list(ctx);
      setTargets(listed.targets.map((t) => t.name));
      mutateRows(() => fromList(listed.addons, pinned).map((r) => ({ ...r, activity: { kind: "checking" } })));
      setMessage({ text: "Checking for updates", tone: "info" });
      const result = await ops.outdated(ctx);
      mutateRows((rs) => applyOutdated(rs, result.addons));
      const behind = rowsRef.current.filter((r) => r.status !== "ok").length;
      const errors = rowsRef.current.filter((r) => r.status === "error").length;
      setMessage(
        errors
          ? { text: `${errors} addon${errors === 1 ? "" : "s"} could not be checked`, tone: "error" }
          : behind
            ? { text: `${behind} addon${behind === 1 ? " needs" : "s need"} an update`, tone: "warn" }
            : { text: "Everything is up to date", tone: "ok" },
      );
    } catch (err) {
      mutateRows((rs) => rs.map((r) => ({ ...r, activity: undefined })));
      setMessage({ text: errorText(err), tone: "error" });
    } finally {
      setBusy(null);
      busyRef.current = null;
    }
  }, [ctx, mutateRows]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runUpdate = useCallback(
    async (chosen: Row[]) => {
      if (busyRef.current || !chosen.length) return;
      setBusy("updating");
      busyRef.current = "updating";
      const keys = new Set(chosen.map((r) => r.key));
      mutateRows((rs) => setActivity(rs, keys, { kind: "queued" }));
      setMessage({ text: `Updating ${chosen.length} addon${chosen.length === 1 ? "" : "s"}`, tone: "info" });
      const lastPaint = new Map<string, number>();
      const results: ops.UpdateEntry[] = [];
      try {
        for (const [target, names] of namesByTarget(chosen)) {
          const onEvent = (e: ProgressEvent) => {
            if (e.type === "registry:stale") return setMessage({ text: e.message, tone: "warn" });
            if (!("addon" in e)) return;
            const key = rowKey(e.addon, target);
            let activity: Activity | undefined;
            if (e.type === "download:start") activity = { kind: "downloading", received: 0 };
            else if (e.type === "download:progress") {
              const now = performance.now();
              if (now - (lastPaint.get(key) ?? 0) < PROGRESS_MS) return;
              lastPaint.set(key, now);
              activity = { kind: "downloading", received: e.received, total: e.total };
            } else if (e.type === "extract" || e.type === "verify" || e.type === "swap") activity = { kind: "installing" };
            if (activity) mutateRows((rs) => setActivity(rs, new Set([key]), activity));
          };
          const result = await ops.update({ ...ctx, targets: [target], names, onEvent });
          results.push(...result.addons);
          let changed = new Set<string>();
          mutateRows((rs) => {
            const applied = applyUpdate(rs, result.addons);
            changed = applied.changed;
            return applied.rows;
          });
          if (changed.size) setFlash(changed);
        }
        const summary = summarise(results);
        const notes = results.flatMap((r) =>
          r.status !== "error" && "leftoverDir" in r && r.leftoverDir
            ? [`could not delete ${r.leftoverDir}; remove it by hand`]
            : [],
        );
        setMessage({
          text: [describeSummary(summary), ...notes].join("; "),
          tone: summary.errors ? "error" : notes.length ? "warn" : "ok",
        });
      } catch (err) {
        setMessage({ text: errorText(err), tone: "error" });
      } finally {
        mutateRows((rs) => setActivity(rs, keys, undefined));
        setSelected(new Set());
        setBusy(null);
        busyRef.current = null;
      }
    },
    [ctx, mutateRows],
  );

  const updateAll = () => void runUpdate(visible);
  const updateSelected = () => {
    const chosen = visible.filter((r) => selected.has(r.key));
    const row = visible[cursorRef.current];
    void runUpdate(chosen.length ? chosen : row ? [row] : []);
  };
  const quit = () => {
    if (busyRef.current === "updating" && !forceQuit.current) {
      forceQuit.current = true;
      setMessage({ text: "An update is running. Quit again to stop it midway, or wait for it to finish.", tone: "warn" });
      return;
    }
    onQuit();
  };
  const toggle = (key: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const switchTab = (index: number) => {
    setTab(index);
    cursorRef.current = 0;
    setCursor(0);
  };

  useKeyboard((key) => {
    const page = 10;
    if (key.name === "q" || (key.ctrl && key.name === "c")) quit();
    else if (key.name === "up" || key.name === "k") moveCursor((c) => c - 1);
    else if (key.name === "down" || key.name === "j") moveCursor((c) => c + 1);
    else if (key.name === "pageup") moveCursor((c) => c - page);
    else if (key.name === "pagedown") moveCursor((c) => c + page);
    else if (key.name === "home") moveCursor(() => 0);
    else if (key.name === "end") moveCursor(() => visible.length - 1);
    else if (key.name === "space") {
      const row = visible[cursorRef.current];
      if (row) toggle(row.key);
    }
    else if (key.name === "escape") setSelected(new Set());
    else if (key.name === "tab") switchTab((tab + (key.shift ? targets.length : 1)) % (targets.length + 1));
    else if (/^[1-9]$/.test(key.name) && Number(key.name) <= targets.length + 1) switchTab(Number(key.name) - 1);
    else if (key.name === "u" && (key.shift || key.sequence === "U")) updateAll();
    else if (key.name === "u") updateSelected();
    else if (key.name === "r") void refresh();
  });

  const showTarget = tab === 0 && targets.length > 1;
  const targetWidth = showTarget ? Math.max(6, ...targets.map((t) => t.length)) + 2 : 0;
  const versionWidth = 16;
  const statusWidth = 22;
  // Two for the cursor marker, one for the scroll bar.
  const nameWidth = Math.max(10, width - 3 - targetWidth - 2 * versionWidth - statusWidth);
  const spinner = SPINNER[frame]!;
  const focusRow = rows.find((r) => r.key === hovered) ?? current;
  const status: Message =
    focusRow?.status === "error" && focusRow.error && !focusRow.activity
      ? { text: `${focusRow.name} (${focusRow.target}): ${focusRow.error}`, tone: "error" }
      : message;
  const outdatedCount = rows.filter((r) => r.status === "outdated" || r.status === "not installed" || r.status === "missing").length;

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
        <text>
          <span fg={COLOR.accent}>wowget</span>
          <span fg={COLOR.dim}>{` ${ctx.version}`}</span>
        </text>
        <box flexGrow={1} />
        <text fg={COLOR.dim}>{fit(ctx.manifestPath, Math.max(0, width - 20))}</text>
      </box>

      <box flexDirection="row" height={1} marginTop={1} paddingLeft={1}>
        {["All", ...targets].map((label, i) => (
          <Tab key={label} label={`${i + 1} ${label}`} active={tab === i} onPress={() => switchTab(i)} />
        ))}
        <box flexGrow={1} />
        {outdatedCount > 0 && <text fg={COLOR.warn}>{`${outdatedCount} to update `}</text>}
      </box>

      <box height={1} marginTop={1}>
        <text fg={COLOR.dim}>
          {`  ${fit("NAME", nameWidth)}${showTarget ? fit("TARGET", targetWidth) : ""}${fit("INSTALLED", versionWidth)}${fit("LATEST", versionWidth)}STATUS`}
        </text>
      </box>

      <scrollbox ref={scroll} flexGrow={1}>
        {manifestMissing ? (
          <text fg={COLOR.text}>
            {`  No manifest yet. Run "wowget init" to find your World of Warcraft installs, then open wowget again.`}
          </text>
        ) : !visible.length && !busy ? (
          <text fg={COLOR.text}>{`  No addons here yet. Add one with "wowget add <name>".`}</text>
        ) : (
          visible.map((row, i) => {
            const isCursor = i === cursor;
            const isSelected = selected.has(row.key);
            const cell = statusCell(row, spinner);
            return (
              <box
                key={row.key}
                id={`row-${i}`}
                height={1}
                backgroundColor={flash.has(row.key) ? COLOR.flashBg : isCursor ? COLOR.cursorBg : undefined}
                onMouseDown={(e: MouseEvent) => {
                  if (e.button !== 0) return;
                  if (e.modifiers.shift) toggle(row.key);
                  moveCursor(() => i);
                }}
                onMouseOver={() => setHovered(row.key)}
                onMouseOut={() => setHovered((h) => (h === row.key ? null : h))}
              >
                <text>
                  <span fg={COLOR.selected}>{isSelected ? "● " : isCursor ? "› " : "  "}</span>
                  <span fg={isSelected ? COLOR.selected : COLOR.text}>{fit(row.name, nameWidth)}</span>
                  {showTarget && <span fg={COLOR.dim}>{fit(row.target, targetWidth)}</span>}
                  <span fg={COLOR.text}>{fit(row.installed ?? "-", versionWidth)}</span>
                  <span fg={row.status === "outdated" ? COLOR.warn : COLOR.text}>{fit(row.latest ?? "", versionWidth)}</span>
                  <span fg={cell.color}>{fit(cell.text, statusWidth)}</span>
                </text>
              </box>
            );
          })
        )}
      </scrollbox>

      <box flexDirection="row" height={1} paddingLeft={1}>
        <Button hotkey="U" label="Update all" disabled={!!busy || !visible.length} onPress={updateAll} />
        <Button
          hotkey="u"
          label={selected.size ? `Update ${selected.size} selected` : "Update"}
          disabled={!!busy || !current}
          onPress={updateSelected}
        />
        <Button hotkey="r" label="Refresh" disabled={!!busy} onPress={() => void refresh()} />
        <box flexGrow={1} />
        <Button hotkey="q" label="Quit" onPress={quit} />
      </box>

      <box height={1} paddingLeft={1} marginTop={1}>
        <text fg={toneColor(status.tone)}>
          {fit(`${busy ? `${spinner} ` : ""}${status.text}`, Math.max(0, width - 2))}
        </text>
      </box>
    </box>
  );
}
