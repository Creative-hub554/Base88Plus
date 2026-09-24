"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BuilderUIMessage, FileUpdate } from "@/lib/types";
import { choose, notify, ToastHost } from "./toast";

interface WorkspaceFile {
  path: string;
  content: string;
}

/** Devices shown side by side in the multi-device preview (null = fluid). */
const MULTI_DEVICES = [
  { id: "desktop", label: "Desktop", width: null, icon: "🖥" },
  { id: "tablet", label: "Tablet", width: 768, icon: "▭" },
  { id: "mobile", label: "Mobile", width: 390, icon: "▯" },
];

const SUGGESTIONS = [
  "Make it fully responsive — check 390px and 768px widths",
  "Polish the design: better typography, spacing, and hover states",
  "Add smooth scroll-reveal animations",
];

/** Snapshot summary shape returned by the snapshots API (newest first). */
interface SnapshotSummary {
  messageId: string;
  savedAt: string;
  files: string[];
  /** Local assets this snapshot's HTML references but lacks. */
  missing?: string[];
}

/** 1280px-wide page scaled to fit the ~280px card ⇒ ≈0.22. */
const THUMB_SCALE = 0.22;

/**
 * Per-turn undo: a Restore button on assistant turns that produced files
 * (and have a server-persisted snapshot). Restoring swaps the workspace to
 * that generation's exact state via the snapshots API and refreshes files
 * + preview. The restore availability set is loaded by the parent —
 * snapshot existence is SERVER state, the client never guesses it.
 */
/**
 * Version-health line inside a restore tooltip, so the user sees a
 * version's health BEFORE restoring it: ✓ complete, ⚠ missing assets
 * with no better alternative (restoring ships 404s), or 🛠 missing but a
 * complete version exists to switch to (same `suggest` semantics as the
 * pin/publish surfaces: newest complete snapshot by savedAt).
 */
function VersionHealthBadge({
  testPrefix,
  messageId,
  missing,
  suggestId,
}: {
  testPrefix: string;
  messageId: string;
  missing?: string[];
  suggestId?: string | null;
}) {
  const ok = (missing?.length ?? 0) === 0;
  const fixable = !ok && !!suggestId;
  return (
    <span
      data-testid={`${testPrefix}-health-${messageId}`}
      className={`mb-1 block font-medium ${
        ok
          ? "text-emerald-400"
          : fixable
            ? "text-amber-300"
            : "text-red-400"
      }`}
    >
      {ok
        ? "✓ Complete — safe to restore"
        : fixable
          ? `🛠 Missing: ${missing!.join(", ")} — a complete version exists (${suggestId}) — switch to it instead`
          : `⚠ Missing: ${missing!.join(", ")} — restoring ships 404s for them`}
    </span>
  );
}

/**
 * Shared 🛠 fix → pin → publish offer so a successful repair recovers in
 * ONE flow from EITHER surface (publish-panel rows and the history
 * cards): a COMPLETE fix resolves with the generated files → confirm pins
 * the now-complete version through the shared parent handler, then a
 * second confirm publishes immediately so the public page serves the
 * repaired version without a trip to the Publish panel. A failed or
 * partial fix resolves nothing → no offers (pinning would just 409
 * again). onPublish is optional: surfaces without a publish path keep
 * the pin-only behavior.
 */
async function fixThenOfferPin(
  onFix: (messageId: string) =>
    string[] | null | void | Promise<string[] | null | void>,
  onTogglePin: (messageId: string, pinned: boolean) => void | Promise<void>,
  onPublish: (() => boolean | void | Promise<boolean | void>) | undefined,
  messageId: string,
) {
  const fixed = await onFix(messageId);
  if (!fixed?.length) return;
  const pinIt = await choose(
    `Fixed: ${fixed.join(", ")}.\n\nPin this now-complete version? Publishing will ship it.`,
    [
      { value: "confirm", label: "📌 Pin it", primary: true },
      { value: "cancel", label: "Not now" },
    ],
  );
  if (pinIt !== "confirm") return;
  await onTogglePin(messageId, false);
  if (!onPublish) return;
  const publishIt = await choose(
    "Pinned. Publish it now? The public page will immediately serve the repaired version.",
    [
      { value: "confirm", label: "🚀 Publish now", primary: true },
      { value: "cancel", label: "Later" },
    ],
  );
  if (publishIt !== "confirm") return;
  const ok = await onPublish();
  if (ok === false) {
    notify("Publish failed — open the Publish panel and try again.", "danger");
  }
}

/** Exported for component tests (same seam as MessageBubble). */
export function RestoreTurnButton({
  messageId,
  onRestore,
  onHover,
  diff,
  disabled,
  missing,
  suggestId,
}: {
  messageId: string;
  onRestore: (messageId: string) => void;
  /** Fetch (and cache) the snapshot-vs-workspace diff on first hover/focus. */
  onHover?: () => void;
  /** Diff summary; undefined = not yet fetched, null = unavailable. */
  diff?: { added: string[]; removed: string[]; modified: string[] } | null;
  disabled?: boolean;
  /** Assets this snapshot's HTML references but lacks (health badge). */
  missing?: string[];
  /** Newest complete snapshot id, when one exists (the 🛠 alternative). */
  suggestId?: string | null;
}) {
  const hasChanges =
    !!diff &&
    (diff.added.length > 0 ||
      diff.removed.length > 0 ||
      diff.modified.length > 0);
  return (
    <span className="group relative mt-1.5 inline-block">
      <button
        type="button"
        data-testid={`restore-${messageId}`}
        disabled={disabled}
        onClick={() => onRestore(messageId)}
        onMouseEnter={() => onHover?.()}
        onFocus={() => onHover?.()}
        className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
      >
        ↩ Restore this version
      </button>
      {diff && (
        <span
          data-testid={`restore-diff-${messageId}`}
          className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5 hidden w-max max-w-[300px] rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-left text-[11px] leading-relaxed text-neutral-300 shadow-xl group-hover:block group-focus-within:block"
        >
          <VersionHealthBadge
            testPrefix="restore"
            messageId={messageId}
            missing={missing}
            suggestId={suggestId}
          />
          {hasChanges ? (
            <>
              <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-neutral-500">
                Restoring will:
              </span>
              {diff.added.map((p) => (
                <span key={`a-${p}`} className="block text-emerald-400">
                  + {p}
                </span>
              ))}
              {diff.removed.map((p) => (
                <span key={`r-${p}`} className="block text-rose-400">
                  − {p}
                </span>
              ))}
              {diff.modified.map((p) => (
                <span key={`m-${p}`} className="block text-amber-400">
                  ~ {p}
                </span>
              ))}
            </>
          ) : (
            <span className="text-neutral-500">
              Workspace already matches this version
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * Version history panel: a visual card per turn snapshot with a live,
 * scaled-down iframe of that generation's workspace (same technique as
 * the /new gallery's template thumbnails), served from the immutable
 * snapshot folder. Clicking a card restores that version; hovering loads
 * the same diff tooltip as the chat's Restore buttons.
 */
export function VersionHistoryPanel({
  projectId,
  refreshKey,
  busy,
  onRestore,
  onFork,
  onFix,
  fixingId,
  onLoadDiff,
  diffs,
  pinnedId,
  onTogglePin,
  onPublish,
}: {
  projectId: string;
  /** Bumps thumbnails when the snapshot set changes. */
  refreshKey: number;
  busy: boolean;
  onRestore: (messageId: string) => void;
  /** Fork the snapshot into a new project ("restore as copy"). */
  onFork: (messageId: string) => void;
  /** Regenerate a snapshot's missing assets in place. A COMPLETE fix
   *  resolves with the generated files → the card then offers to pin the
   *  now-complete version (the same one-flow recovery the publish
   *  panel's rows offer). */
  onFix: (messageId: string) =>
    string[] | null | void | Promise<string[] | null | void>;
  /** The snapshot a fix is currently regenerating — that card's 🛠 spins. */
  fixingId?: string | null;
  onLoadDiff: (messageId: string) => void;
  /** The currently pinned best version (publish source), if any. */
  pinnedId: string | null;
  onTogglePin: (messageId: string, pinned: boolean) => void | Promise<void>;
  /** Publish-now path for the fix-then-pin recovery's final offer
   *  (the parent's publishNow, which also re-syncs the Publish
   *  button's status); omit to keep the pin-only offer. */
  onPublish?: () => boolean | void | Promise<boolean | void>;
  diffs: Record<
    string,
    { added: string[]; removed: string[]; modified: string[] } | null
  >;
}) {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/snapshots`)
      .then((r) => (r.ok ? r.json() : { snapshots: [] }))
      .then((d) => {
        if (!cancelled) setSnapshots(d.snapshots as SnapshotSummary[]);
      })
      .catch(() => {
        if (!cancelled) setSnapshots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  // The 🛠 alternative for this panel's own tooltips: the most recent
  // COMPLETE snapshot (same semantics as the pin/publish 409s' suggest).
  const suggestComplete = useMemo(() => {
    const newest = [...(snapshots ?? [])].sort(
      (a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt),
    );
    return newest.find((s) => (s.missing?.length ?? 0) === 0)?.messageId ?? null;
  }, [snapshots]);

  if (snapshots === null || snapshots.length === 0) return null;
  return (
    <div className="border-t border-neutral-800">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <h4 className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">
          Version history ({snapshots.length})
        </h4>
        <span className="text-[10px] text-neutral-600">
          {pinnedId
            ? "📌 pinned version is what publish ships"
            : "click a card to restore"}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 px-3 pb-3">
        {snapshots.map((s) => {
          const hasIndex = s.files.includes("index.html");
          const thumbUrl = hasIndex
            ? `/api/projects/${projectId}/snapshots/${s.messageId}/files/index.html?v=${encodeURIComponent(s.savedAt)}`
            : null;
          const diff = diffs[s.messageId];
          const isPinned = pinnedId === s.messageId;
          const changed =
            !!diff &&
            diff.added.length + diff.removed.length + diff.modified.length > 0;
          return (
            <div
              key={s.messageId}
              className="group relative overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/60 transition hover:border-neutral-600"
            >
              <button
                type="button"
                data-testid={`history-card-${s.messageId}`}
                disabled={busy}
                onMouseEnter={() => onLoadDiff(s.messageId)}
                onFocus={() => onLoadDiff(s.messageId)}
                onClick={() => onRestore(s.messageId)}
                className="block w-full cursor-pointer text-left disabled:cursor-not-allowed"
                title={
                  hasIndex
                    ? `Restore this version (${s.files.length} file${s.files.length === 1 ? "" : "s"})`
                    : "No index.html in this snapshot"
                }
              >
                <div className="relative h-[72px] w-full overflow-hidden bg-white">
                  {thumbUrl ? (
                    <div
                      className="pointer-events-none absolute left-0 top-0 w-[1280px] origin-top-left"
                      style={{ transform: `scale(${THUMB_SCALE})` }}
                    >
                      <iframe
                        src={thumbUrl}
                        title={`Version ${s.savedAt}`}
                        loading="lazy"
                        tabIndex={-1}
                        sandbox="allow-scripts allow-same-origin"
                        className="pointer-events-none h-[330px] w-[1280px] border-0 bg-white"
                      />
                    </div>
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[10px] text-neutral-400">
                      {s.files.length} file{s.files.length === 1 ? "" : "s"}
                    </div>
                  )}
                </div>
                <div className="px-2 py-1.5">
                  <div className="text-[10px] text-neutral-300">
                    {new Date(s.savedAt).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                  <div className="truncate text-[10px] text-neutral-600">
                    {s.files.join(", ") || "empty"}
                  </div>
                </div>
              </button>
              {/* Restore as copy: forks the snapshot into a NEW project;
                  sibling of the restore button (never nested buttons). */}
              <button
                type="button"
                data-testid={`history-fork-${s.messageId}`}
                disabled={busy}
                onClick={() => onFork(s.messageId)}
                title="Open as a new project — keeps this one unchanged"
                className="absolute right-1 top-1 z-10 rounded-md border border-neutral-700 bg-black/70 px-1.5 py-0.5 text-[10px] text-neutral-300 opacity-0 transition hover:border-neutral-500 hover:text-white focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ⧉ copy
              </button>
              {/* Pinned best version: publishing always ships THIS snapshot,
                  independent of the live workspace. */}
              <button
                type="button"
                data-testid={`history-pin-${s.messageId}`}
                disabled={busy}
                onClick={() => onTogglePin(s.messageId, isPinned)}
                title={
                  isPinned
                    ? "Unpin — publishing returns to the live workspace"
                    : (s.missing?.length ?? 0) > 0
                      ? `Pin as best version — ⚠ missing: ${s.missing!.join(", ")}`
                      : "Pin as best version — publishing always ships this"
                }
                className={`absolute left-1 top-1 z-10 rounded-md border px-1.5 py-0.5 text-[10px] transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  isPinned
                    ? "border-amber-500/70 bg-amber-950/80 text-amber-300"
                    : "border-neutral-700 bg-black/70 text-neutral-300 opacity-0 hover:border-neutral-500 hover:text-white focus:opacity-100 group-hover:opacity-100"
                }`}
              >
                {isPinned ? "📌 pinned" : "📌 pin"}
              </button>
              {(s.missing?.length ?? 0) > 0 && (
                <span
                  data-testid={`history-missing-${s.messageId}`}
                  title={`Snapshot is missing: ${s.missing!.join(", ")} — pinning/publishing it ships a page with 404ing assets`}
                  className="pointer-events-none absolute left-1 bottom-1 z-10 rounded border border-red-900/70 bg-red-950/80 px-1.5 py-0.5 text-[10px] text-red-300"
                >
                  ⚠ {s.missing!.length} missing
                </span>
              )}
              {(s.missing?.length ?? 0) > 0 && (
                <button
                  type="button"
                  data-testid={`history-fix-${s.messageId}`}
                  disabled={busy || fixingId === s.messageId}
                  onClick={() =>
                    void fixThenOfferPin(onFix, onTogglePin, onPublish, s.messageId)
                  }
                  title={
                    fixingId === s.messageId
                      ? "Generating the missing file(s)…"
                      : `Regenerate the missing file(s) (${s.missing!.join(", ")}) into this snapshot — the live workspace is not touched`
                  }
                  className="absolute right-1 bottom-1 z-10 rounded-md border border-emerald-700 bg-emerald-950/85 px-1.5 py-0.5 text-[10px] text-emerald-300 opacity-0 transition hover:border-emerald-500 hover:text-emerald-200 focus:opacity-100 group-hover:opacity-100 disabled:cursor-wait disabled:opacity-40"
                >
                  {fixingId === s.messageId ? "◌ fixing…" : "🛠 fix"}
                </button>
              )}
              {diff && (
                <span
                  data-testid={`history-diff-${s.messageId}`}
                  className="pointer-events-none absolute bottom-full left-0 z-50 mb-1 hidden w-max max-w-[300px] rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-left text-[11px] leading-relaxed text-neutral-300 shadow-xl group-hover:block group-focus-within:block"
                >
                  <VersionHealthBadge
                    testPrefix="history"
                    messageId={s.messageId}
                    missing={s.missing}
                    suggestId={suggestComplete}
                  />
                  {changed ? (
                    <>
                      {diff.added.map((p) => (
                        <span key={`a-${p}`} className="block text-emerald-400">
                          + {p}
                        </span>
                      ))}
                      {diff.removed.map((p) => (
                        <span key={`r-${p}`} className="block text-rose-400">
                          − {p}
                        </span>
                      ))}
                      {diff.modified.map((p) => (
                        <span key={`m-${p}`} className="block text-amber-400">
                          ~ {p}
                        </span>
                      ))}
                    </>
                  ) : (
                    <span className="text-neutral-500">
                      Workspace already matches this version
                    </span>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One-click refinement chips shown after a successful generation, so
 * iterating on quality is a single click instead of typing.
 */
function SuggestionChips({
  messages,
  onPick,
}: {
  messages: BuilderUIMessage[];
  onPick: (text: string) => void;
}) {
  const last = messages[messages.length - 1];
  const meta = last?.metadata as { fileCount?: number } | undefined;
  const justGenerated =
    last?.role === "assistant" &&
    typeof meta?.fileCount === "number" &&
    meta.fileCount > 0;
  if (!justGenerated) return null;
  return (
    <div className="animate-rise flex flex-wrap gap-2 px-3 pb-2">
      {SUGGESTIONS.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className="rounded-full border border-neutral-800 bg-neutral-900/70 px-3 py-1.5 text-xs text-neutral-300 transition hover:border-neutral-600 hover:text-white"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

export function BuilderClient({
  projectId,
  initialMessages,
  initialFiles,
}: {
  projectId: string;
  initialMessages: BuilderUIMessage[];
  initialFiles: WorkspaceFile[];
}) {
  const [files, setFiles] = useState<WorkspaceFile[]>(initialFiles);
  const [activeFile, setActiveFile] = useState<string | null>(
    initialFiles.find((f) => f.path === "index.html")?.path ??
      initialFiles[0]?.path ??
      null,
  );
  const [previewKey, setPreviewKey] = useState(0);
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Bump to make the model picker re-fetch (e.g. after the settings modal closes).
  const [pickerRefreshKey, setPickerRefreshKey] = useState(0);
  // While non-null, the workspace preview shows that stored deploy version.
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  // Side-by-side multi-device preview (desktop + tablet + mobile at once);
  // false = single full-width desktop frame.
  const [multiDevice, setMultiDevice] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  /**
   * One-click recovery after a truncated/failed generation: re-requests the
   * last assistant turn with continueDegenerate=true (the server then uses
   * minimal history + a hard format reminder). `regenerate` trims the
   * conversation at the degenerate assistant message, so the retry replaces
   * it in place instead of appending a new turn.
   */
  const continueDegenerate = (degenerateMessageId: string) => {
    regenerate({ messageId: degenerateMessageId, body: { continueDegenerate: true } });
  };

  const transport = useMemo(
    () =>
      new DefaultChatTransport<BuilderUIMessage>({
        api: "/api/chat",
        body: () => ({ projectId }),
      }),
    [projectId],
  );

  const { messages, sendMessage, status, error, stop, regenerate } = useChat({
    transport,
    id: projectId,
    messages: initialMessages,
    onFinish: () => {
      // Refresh workspace from disk (server persisted files).
      refreshFiles();
    },
  });

  // Collect streamed file updates into local workspace state.
  const pendingFiles = useRef<Map<string, FileUpdate>>(new Map());
  /** Set when live partials were applied mid-stream; the end-of-stream
   * effect still refreshes the preview even with an empty pending map. */
  const streamedApply = useRef(false);
  useEffect(() => {
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type === "data-files") {
          for (const update of part.data as FileUpdate[]) {
            if (update.action === "delete") {
              pendingFiles.current.set(update.path, update);
            } else {
              pendingFiles.current.set(update.path, update);
            }
          }
        }
      }
    }
  }, [messages]);

  // Apply updates whenever the status leaves streaming.
  useEffect(() => {
    if (status === "streaming" || status === "submitted") return;
    if (pendingFiles.current.size === 0 && !streamedApply.current) return;
    streamedApply.current = false;
    if (pendingFiles.current.size > 0) {
      const updates = [...pendingFiles.current.values()];
      pendingFiles.current.clear();
      setFiles((prev) => {
        const next = new Map(prev.map((f) => [f.path, f]));
        for (const u of updates) {
          if (u.action === "delete") next.delete(u.path);
          else next.set(u.path, { path: u.path, content: u.content ?? "" });
        }
        return [...next.values()];
      });
      setActiveFile((cur) => {
        if (cur && updates.some((u) => u.path === cur)) return cur;
        const idx = updates.find((u) => u.path === "index.html") ?? updates[0];
        return idx ? idx.path : cur;
      });
    }
    // Partials were already rendered in the code tab during the stream;
    // this bump is what refreshes the PREVIEW once the app is complete.
    setPreviewKey((k) => k + 1);
  }, [status]);

  // While streaming, apply completed file sections to the workspace LIVE
  // (the server emits each `=== file ===` section the moment it completes,
  // before the fence closes) and show the newest one in the code tab.
  useEffect(() => {
    if (status !== "streaming") return;
    if (pendingFiles.current.size === 0) return;
    const updates = [...pendingFiles.current.values()];
    pendingFiles.current.clear();
    streamedApply.current = true;
    setFiles((prev) => {
      const next = new Map(prev.map((f) => [f.path, f]));
      for (const u of updates) {
        if (u.action === "delete") next.delete(u.path);
        else next.set(u.path, { path: u.path, content: u.content ?? "" });
      }
      return [...next.values()];
    });
    const last = updates[updates.length - 1];
    if (last && last.action !== "delete") {
      setActiveFile(last.path);
      setTab("code");
    }
  }, [messages, status]);

  async function refreshFiles() {
    const res = await fetch(`/api/projects/${projectId}/files`);
    if (!res.ok) return;
    const data = res.json();
    setFiles((await data).files);
    setPreviewKey((k) => k + 1);
    void refreshSnapshots();
    void refreshMissingRefs();
  }

  /** Which turns have a persisted workspace snapshot (newest first). */
  const [snapshotIds, setSnapshotIds] = useState<string[]>([]);
  /** Per-snapshot health (missing assets) for the restore tooltips' badges. */
  const [snapshotHealth, setSnapshotHealth] = useState<
    { id: string; savedAt: string; missing: string[] }[]
  >([]);
  // The 🛠 alternative: the most recent COMPLETE snapshot (same semantics
  // as the pin/publish 409s' `suggest` — newest by savedAt, zero missing).
  const suggestComplete = useMemo(() => {
    const newest = [...snapshotHealth].sort(
      (a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt),
    );
    return newest.find((s) => s.missing.length === 0)?.id ?? null;
  }, [snapshotHealth]);
  /** Bumps when a publish happens OUTSIDE the Publish button (the
   *  fix-then-pin flow's publish-now offer from the history cards) so the
   *  button re-fetches status and its Published badge doesn't go stale. */
  const [publishSyncKey, setPublishSyncKey] = useState(0);
  /** Publish-now path for the fix-then-pin recovery's final offer from
   *  the history cards (the Publish button is a sibling component, so it
   *  can't reuse the panel's publish() — this posts directly and nudges
   *  the button's status re-sync). No ?force=1 needed: by this point the
   *  snapshot was just repaired, so the pinned-missing 409 can't fire. */
  async function publishNow(): Promise<boolean> {
    try {
      const res = await fetch(`/api/projects/${projectId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      setPublishSyncKey((k) => k + 1);
    }
  }
  /**
   * Hover-diff cache per message id: what restoring that snapshot would
   * change vs the CURRENT workspace. Fetched lazily on first hover; a null
   * marks "unavailable" so failed fetches aren't retried every hover.
   * Cleared after any restore — every other snapshot's diff is then stale.
   */
  const [diffCache, setDiffCache] = useState<
    Record<string, { added: string[]; removed: string[]; modified: string[] } | null>
  >({});
  async function loadSnapshotDiff(messageId: string) {
    if (diffCache[messageId] !== undefined) return;
    setDiffCache((c) => ({ ...c, [messageId]: null }));
    try {
      const res = await fetch(`/api/projects/${projectId}/snapshots/${messageId}`);
      if (!res.ok) return;
      const data = await res.json();
      setDiffCache((c) => ({ ...c, [messageId]: data.diff }));
    } catch {
      /* non-fatal: tooltip simply won't render */
    }
  }
  /** Bumped when the snapshot set changes so the history panel re-fetches. */
  const [snapshotRefreshKey, setSnapshotRefreshKey] = useState(0);

  /** Workspace lines referencing files that don't exist — highlighted in
   *  the code view. Same triggers as the snapshot re-sync: initial mount,
   *  refreshFiles (generation end / restore / fix), and snapshot changes. */
  const [missingRefs, setMissingRefs] = useState<MissingRef[]>([]);
  async function refreshMissingRefs() {
    try {
      const res = await fetch(`/api/projects/${projectId}/missing-refs`);
      if (!res.ok) return;
      const data = (await res.json()) as { refs?: MissingRef[] };
      setMissingRefs(data.refs ?? []);
    } catch {
      /* non-fatal: highlighting simply stays stale/off */
    }
  }
  useEffect(() => {
    void refreshMissingRefs();
    // refreshMissingRefs is stable per render and deliberately not a dep:
    // this re-runs only on mount and when the snapshot set changes.
  }, [projectId, snapshotRefreshKey]);

  /** The pinned best version (publish source) — server state, re-synced. */
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  async function refreshPin() {
    try {
      const res = await fetch(`/api/projects/${projectId}/pin`);
      if (!res.ok) return;
      const data = await res.json();
      setPinnedId(data.pinnedSnapshot?.messageId ?? null);
    } catch {
      /* non-fatal */
    }
  }
  useEffect(() => {
    void refreshPin();
  }, [projectId, snapshotRefreshKey]);
  async function togglePin(messageId: string, pinned: boolean, force = false) {
    if (busy) return;
    if (pinned) {
      const res = await fetch(`/api/projects/${projectId}/pin`, {
        method: "DELETE",
      });
      if (res.ok) setPinnedId(null);
      return;
    }
    const res = await fetch(`/api/projects/${projectId}/pin/${messageId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(force ? { force: true } : {}),
    });
    if (!res.ok) {
      // 409: the snapshot is missing assets its HTML references. Confirm
      // once; the retry pins anyway and still says what will 404. When the
      // user declines AND a complete snapshot exists, offer the one-click
      // switch to it (the safe path) instead of leaving them blocked.
      if (res.status === 409) {
        const data = (await res.json().catch(() => null)) as
          | { warning?: string; missing?: string[]; suggest?: string | null }
          | null;
        const list = data?.missing?.join(", ") ?? "";
        const actions: { value: string; label: string; primary?: boolean; danger?: boolean }[] = [
          {
            value: "confirm",
            label: "Pin anyway",
            primary: true,
            danger: true,
          },
        ];
        if (data?.suggest && data.suggest !== messageId) {
          actions.push({
            value: "switch",
            label: "Switch to the complete version",
          });
        }
        actions.push({ value: "cancel", label: "Don't pin" });
        // ONE decision toast replaces the old confirm-then-confirm chain:
        // pin anyway (ships 404s), switch to the complete version, or walk
        // away — no nested dialogs.
        const answer = await choose(
          `This snapshot is missing: ${list}.\n\nPin it anyway? The public page will 404 these assets.`,
          actions,
        );
        if (answer === "confirm") {
          await togglePin(messageId, false, true);
        } else if (answer === "switch" && data?.suggest) {
          await togglePin(data.suggest, false);
        }
      }
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      pinnedWithMissing?: string[];
    };
    setPinnedId(messageId);
    if (data.pinnedWithMissing?.length) {
      notify(
        `Pinned anyway — these assets will 404 on the public page: ${data.pinnedWithMissing.join(", ")}`,
        "warn",
      );
    }
  }
  async function refreshSnapshots() {
    try {
      const res = await fetch(`/api/projects/${projectId}/snapshots`);
      if (!res.ok) return;
      const data = await res.json();
      const list = data.snapshots as SnapshotSummary[];
      setSnapshotIds(list.map((s) => s.messageId));
      // Per-snapshot health feeds the restore tooltips' ✓/⚠/🛠 badges.
      setSnapshotHealth(
        list.map((s) => ({
          id: s.messageId,
          savedAt: s.savedAt,
          missing: s.missing ?? [],
        })),
      );
    } catch {
      /* non-fatal */
    }
  }
  useEffect(() => {
    void refreshSnapshots();
    // Snapshot availability + health are server state; re-synced on
    // generation (via refreshFiles), restore, and fix (refreshKey bumps).
  }, [projectId, snapshotRefreshKey]);

  /** Fork a snapshot into a new project ("restore as copy") and open it. */
  async function forkTurn(messageId: string) {
    if (busy) return;
    try {
      const res = await fetch(
        `/api/projects/${projectId}/snapshots/${messageId}/fork`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data?.project?.id) window.location.assign(`/app/${data.project.id}`);
    } catch {
      /* navigation simply doesn't happen */
    }
  }

  /**
   * Fix a snapshot's missing assets: regenerate them in place. Resolves
   * with the files the fix generated when the snapshot is now COMPLETE —
   * the publish panel's rows use that to offer pinning the fixed version
   * in the same step (a partial fix would just 409 on pin again).
   */
  const [fixingId, setFixingId] = useState<string | null>(null);
  async function fixTurn(messageId: string): Promise<string[] | null> {
    if (busy || fixingId) return null;
    setFixingId(messageId);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/snapshots/${messageId}/fix`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as {
        fixed?: string[];
        stillMissing?: string[];
      } | null;
      if (data?.fixed?.length) {
        notify(
          data.stillMissing?.length
            ? `Partially fixed (${data.fixed.join(", ")}). Still missing: ${data.stillMissing.join(", ")}`
            : `Fixed: ${data.fixed.join(", ")}`,
          data.stillMissing?.length ? "warn" : "info",
        );
      } else {
        notify(
          data?.stillMissing?.length
            ? `Couldn't generate: ${data.stillMissing.join(", ")} — try a stronger model.`
            : "Fix failed — try again.",
          "danger",
        );
      }
      // Snapshot files changed → thumbnails + pin state + diffs re-sync.
      setSnapshotRefreshKey((k) => k + 1);
      setDiffCache({});
      void refreshPin();
      // Complete fix = something was generated AND nothing is still
      // missing → hand the generated list back so the publish panel can
      // offer to pin this now-complete version in the same flow.
      const fixed = data?.fixed ?? [];
      const stillMissing = data?.stillMissing ?? [];
      if (fixed.length > 0 && stillMissing.length === 0) return fixed;
      return null;
    } catch {
      return null;
    } finally {
      setFixingId(null);
    }
  }

  /** Restore the workspace to a generation's snapshot (per-turn undo). */
  async function restoreTurn(messageId: string) {
    if (busy) return;
    const res = await fetch(`/api/projects/${projectId}/snapshots/${messageId}`, {
      method: "POST",
    });
    if (!res.ok) return;
    await refreshFiles();
    // The workspace just changed: every cached hover-diff is stale, and the
    // history panel's "which version matches" state is stale too. The pin
    // may have been cleared server-side (restoring the pinned version), so
    // re-sync it via the panel's refresh effect.
    setDiffCache({});
    setSnapshotRefreshKey((k) => k + 1);
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const busy = status === "submitted" || status === "streaming";

  // Where every preview frame points: a stored deploy version while viewing
  // history, otherwise the live workspace.
  const previewSrc =
    viewingVersion !== null
      ? `/api/projects/${projectId}/deploy/versions/${viewingVersion}/index.html`
      : `/api/preview/${projectId}/index.html`;

  return (
    <div className="flex h-dvh flex-col animate-rise">
      {/* In-app dialogs (pin/fix recovery decisions + outcomes). */}
      <ToastHost />
      {/* Header */}
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm font-semibold text-white">
            anybase
          </a>
          <span className="text-xs text-neutral-600">/</span>
          <span className="text-sm text-neutral-400">{projectId}</span>
        </div>
        <div className="flex flex-1 justify-center items-center gap-3 px-4">
          <ProjectModelPicker projectId={projectId} refreshKey={pickerRefreshKey} />
          <span className="text-neutral-700 text-xs">·</span>
          <ModelPicker refreshKey={pickerRefreshKey} />
        </div>
        <div className="flex items-center gap-2">
          <PublishButton
            projectId={projectId}
            viewingVersion={viewingVersion}
            onViewVersion={setViewingVersion}
            pinSyncKey={pinnedId}
            dirtyKey={files}
            snapshotRefreshKey={snapshotRefreshKey}
            onTogglePin={togglePin}
            onFix={fixTurn}
            builderBusy={busy}
            fixingId={fixingId}
            publishSyncKey={publishSyncKey}
          />
          <div className="flex overflow-hidden rounded-lg border border-neutral-800">
            <button
              onClick={() => setTab("preview")}
              className={`px-3 py-1.5 text-xs ${
                tab === "preview"
                  ? "bg-neutral-800 text-white"
                  : "text-neutral-400 hover:text-white"
              }`}
            >
              Preview
            </button>
            <button
              onClick={() => setTab("code")}
              className={`px-3 py-1.5 text-xs ${
                tab === "code"
                  ? "bg-neutral-800 text-white"
                  : "text-neutral-400 hover:text-white"
              }`}
            >
              Code
            </button>
          </div>
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 hover:text-white"
          >
            ⚙ Settings
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Chat panel */}
        <section className="flex w-[420px] shrink-0 flex-col border-r border-neutral-800">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {messages.length === 0 && (
              <div className="rounded-lg border border-dashed border-neutral-800 p-4 text-sm text-neutral-500">
                Describe the app you want to build. The AI writes the files and
                you'll see it live in the preview.
              </div>
            )}
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                footer={
                  message.role === "assistant" &&
                  snapshotIds.includes(message.id) ? (
                    <RestoreTurnButton
                      messageId={message.id}
                      onRestore={restoreTurn}
                      onHover={() => void loadSnapshotDiff(message.id)}
                      diff={diffCache[message.id]}
                      disabled={busy}
                      missing={
                        snapshotHealth.find((h) => h.id === message.id)?.missing
                      }
                      suggestId={suggestComplete}
                    />
                  ) : null
                }
              />
            ))}
            {!busy && (
              <ContinueGenerationBanner
                messages={messages}
                onContinue={continueDegenerate}
              />
            )}
            {error && (
              <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-xs text-red-300">
                {error.message}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
          {!busy && (
            <SuggestionChips
              messages={messages}
              onPick={(text) => sendMessage({ text })}
            />
          )}
          <form
            className="composer-shadow border-t border-neutral-800 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              const input = e.currentTarget.elements.namedItem(
                "prompt",
              ) as HTMLTextAreaElement;
              const text = input.value.trim();
              if (!text || busy) return;
              input.value = "";
              sendMessage({ text });
            }}
          >
            <textarea
              name="prompt"
              rows={3}
              placeholder={busy ? "Generating…" : "Describe a change or feature…"}
              className="w-full resize-none rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-sm outline-none placeholder:text-neutral-600 focus:border-neutral-600"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-neutral-600">
                Enter to send · Shift+Enter for newline
              </span>
              {busy ? (
                <button
                  type="button"
                  onClick={() => stop()}
                  className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-white"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-neutral-200"
                >
                  Send
                </button>
              )}
            </div>
          </form>
        </section>

        {/* Workspace panel */}
        <section className="flex min-w-0 flex-1 flex-col bg-neutral-900/40">
          {files.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
              No files yet — your generated app will appear here.
            </div>
          ) : (
            <div className="flex min-h-0 flex-1">
              <aside className="w-56 shrink-0 overflow-y-auto border-r border-neutral-800 p-2">
                {files.map((f) => (
                  <button
                    key={f.path}
                    onClick={() => {
                      setActiveFile(f.path);
                      setTab("code");
                    }}
                    className={`block w-full truncate rounded px-2 py-1.5 text-left text-xs ${
                      activeFile === f.path
                        ? "bg-neutral-800 text-white"
                        : "text-neutral-400 hover:bg-neutral-900"
                    }`}
                  >
                    {f.path}
                  </button>
                ))}
              </aside>
              <div className="flex min-w-0 flex-1 flex-col">
                {tab === "preview" ? (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
                      <button
                        onClick={() => setMultiDevice((m) => !m)}
                        title="Toggle side-by-side desktop / tablet / mobile previews"
                        className={`rounded-md border px-2.5 py-1 text-[11px] transition ${
                          multiDevice
                            ? "border-neutral-700 bg-neutral-800 text-white"
                            : "border-neutral-800 text-neutral-400 hover:text-white"
                        }`}
                      >
                        ▭ ▯ Side-by-side
                      </button>
                      <button
                        onClick={() => setPreviewKey((k) => k + 1)}
                        title="Reload all previews"
                        className="rounded-md px-2 py-1 text-[11px] text-neutral-400 transition hover:bg-neutral-800 hover:text-white"
                      >
                        ⟳ Reload
                      </button>
                      <a
                        href={previewSrc}
                        target="_blank"
                        rel="noreferrer"
                        title="Open preview in a new tab"
                        className="ml-auto rounded-md px-2 py-1 text-[11px] text-neutral-400 transition hover:bg-neutral-800 hover:text-white"
                      >
                        Open ↗
                      </a>
                    </div>
                    {multiDevice ? (
                      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto bg-neutral-950/60 p-3">
                        {MULTI_DEVICES.map((d) => (
                          <div
                            key={d.id}
                            className={`flex h-full min-h-0 flex-col ${
                              d.width === null ? "min-w-[420px] flex-1" : "shrink-0"
                            }`}
                            style={d.width === null ? undefined : { width: d.width }}
                          >
                            <div className="flex items-center justify-between rounded-t-lg border border-b-0 border-neutral-800 bg-neutral-900 px-2.5 py-1">
                              <span className="text-[10px] font-medium text-neutral-300">
                                {d.icon} {d.label}
                              </span>
                              <span className="text-[10px] text-neutral-600">
                                {d.width === null ? "fluid" : `${d.width}px`}
                              </span>
                            </div>
                            <div className="min-h-0 flex-1 overflow-hidden rounded-b-lg border border-neutral-800 bg-white">
                              <iframe
                                key={`${previewKey}-${viewingVersion ?? "live"}`}
                                src={previewSrc}
                                sandbox="allow-scripts allow-forms allow-modals allow-popups"
                                className="h-full w-full bg-white"
                                title={`App preview — ${d.label}`}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex min-h-0 flex-1 justify-center overflow-hidden bg-neutral-950/60">
                        <div className="h-full w-full bg-white">
                          <iframe
                            key={`${previewKey}-${viewingVersion ?? "live"}`}
                            src={previewSrc}
                            sandbox="allow-scripts allow-forms allow-modals allow-popups"
                            className="h-full w-full bg-white"
                            title="App preview"
                          />
                        </div>
                      </div>
                    )}
                  <VersionHistoryPanel
                    projectId={projectId}
                    refreshKey={snapshotRefreshKey}
                    busy={busy}
                    onRestore={restoreTurn}
                    onFork={forkTurn}
                    onFix={fixTurn}
                    fixingId={fixingId}
                    onPublish={publishNow}
                    onLoadDiff={(id) => void loadSnapshotDiff(id)}
                    diffs={diffCache}
                    pinnedId={pinnedId}
                    onTogglePin={togglePin}
                  />
                  </div>
                ) : (
                  <MissingRefCodeView
                    content={
                      files.find((f) => f.path === activeFile)?.content ?? ""
                    }
                    missingLines={missingRefs
                      .filter((r) => r.from === activeFile)
                      .map((r) => r.line)}
                  />
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      {settingsOpen && (
        <SettingsModal
          onClose={() => {
            setSettingsOpen(false);
            // Keys/models may have changed — make the picker re-fetch.
            setPickerRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

interface PublishState {
  published: boolean;
  slug?: string;
  publishedAt?: string;
  publicUrl?: string;
  dirty?: boolean;
  pinnedFrom?: string | null;
  /** Local assets the pinned snapshot's HTML references but lacks. */
  pinnedMissing?: string[];
  /** 409 bodies: pin/publish blocked pending user confirmation. */
  warning?: string;
  missing?: string[];
  /** One-click alternative from 409 bodies: the newest complete snapshot. */
  suggest?: string | null;
  error?: string;
}

interface DeployStatus {
  connected: boolean;
  accountId?: string;
  subdomain?: string;
  error?: string;
}

interface DeploymentInfo {
  workerName: string;
  url: string;
  deployedAt: string;
  version?: number;
}

interface DeployVersionInfo {
  version: number;
  deployedAt: string;
  files: string[];
  url: string;
  slug: string;
}

interface CustomDomainInfo {
  hostname: string;
  mode: "managed" | "manual";
  attachedAt: string;
  dns?: {
    type: "managed" | "manual";
    text: string;
    record?: { type: string; name: string; target: string; proxy: string };
  };
}

/**
 * Custom domains for the project's Worker: attach (managed zone → automatic
 * route; external zone → manual CNAME instructions), list, remove.
 */
function CustomDomainsSection({ projectId }: { projectId: string }) {
  const [domains, setDomains] = useState<CustomDomainInfo[]>([]);
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachedAt, setAttachedAt] = useState<CustomDomainInfo | null>(null);

  useEffect(() => {
    fetch(`/api/projects/${projectId}/domains`)
      .then((r) => r.json())
      .then((d) => setDomains(d.domains ?? []))
      .catch(() => {});
  }, [projectId]);

  async function attach() {
    if (!hostname.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname: hostname.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to attach domain");
        return;
      }
      setDomains((prev) => {
        const exists = prev.some((d) => d.hostname === data.domain.hostname);
        return exists
          ? prev.map((d) => (d.hostname === data.domain.hostname ? data.domain : d))
          : [...prev, data.domain];
      });
      setAttachedAt(data.domain);
      setHostname("");
    } finally {
      setBusy(false);
    }
  }

  async function remove(host: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/domains?hostname=${encodeURIComponent(host)}`,
        { method: "DELETE" },
      );
      const data = await res.json();
      if (res.ok) setDomains(data.domains ?? []);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 border-t border-neutral-800 pt-3">
      <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        Custom domains
      </h4>

      {error && (
        <p className="mt-2 rounded-md border border-red-900 bg-red-950/50 px-2.5 py-1.5 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <input
          value={hostname}
          onChange={(e) => setHostname(e.target.value.toLowerCase().trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              attach();
            }
          }}
          placeholder="www.yourdomain.com"
          className="min-w-0 flex-1 rounded-lg border border-neutral-800 bg-neutral-950 px-2.5 py-2 font-mono text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-600"
        />
        <button
          onClick={attach}
          disabled={busy || !hostname.trim()}
          className="shrink-0 rounded-lg border border-neutral-700 bg-neutral-800 px-2.5 py-2 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-40"
        >
          {busy ? "…" : "Attach"}
        </button>
      </div>

      {domains.length === 0 ? (
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
          Point your own domain at this app. If the domain's zone is on your
          Cloudflare account, the route is created automatically; otherwise
          you'll get a CNAME record to add at your DNS provider.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {domains.map((d) => (
            <li
              key={d.hostname}
              className="rounded-lg border border-neutral-800 bg-neutral-950/60 px-2.5 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-xs text-neutral-200">
                  {d.hostname}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${
                      d.mode === "managed"
                        ? "bg-emerald-950 text-emerald-400"
                        : "bg-amber-950 text-amber-400"
                    }`}
                    title={
                      d.mode === "managed"
                        ? "Zone on your Cloudflare account — route created automatically"
                        : "Zone elsewhere — add the CNAME record yourself"
                    }
                  >
                    {d.mode === "managed" ? "auto" : "CNAME"}
                  </span>
                  <button
                    onClick={() => remove(d.hostname)}
                    disabled={busy}
                    className="text-[11px] text-red-400 hover:underline disabled:opacity-40"
                  >
                    remove
                  </button>
                </span>
              </div>
              {d.dns?.record ? (
                <div className="mt-1.5 rounded-md border border-amber-900/60 bg-amber-950/20 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-amber-200">
                  <div>
                    {d.dns.record.type}&nbsp;&nbsp;{d.dns.record.name}
                    &nbsp;&nbsp;→&nbsp;&nbsp;{d.dns.record.target}
                  </div>
                  <div className="mt-0.5 text-amber-500/80">
                    (add at your DNS provider, {d.dns.record.proxy})
                  </div>
                </div>
              ) : d.dns ? (
                <p className="mt-1 text-[10px] leading-relaxed text-neutral-500">
                  {d.dns.text}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One-click publishing (Base44-style): publishes a snapshot of the current
 * files to a public URL. Re-publishing updates the snapshot; unpublishing
 * takes the URL down.
 */
export function PublishButton({
  projectId,
  viewingVersion,
  onViewVersion,
  pinSyncKey,
  dirtyKey,
  snapshotRefreshKey,
  publishSyncKey,
  onTogglePin,
  builderBusy,
  onFix,
  fixingId,
}: {
  projectId: string;
  viewingVersion: number | null;
  onViewVersion: (v: number | null) => void;
  /** Changes when the pin changes → re-fetch status (the pinnedFrom note). */
  pinSyncKey: string | null;
  /** Identity changes whenever the workspace files change (stream apply,
   * refreshFiles, restore) → re-fetch status so the "workspace is ahead"
   * badge stays current. */
  dirtyKey: readonly unknown[];
  /** Bumps when snapshots change → the safe-versions list re-syncs. */
  snapshotRefreshKey: number;
  /** Bumps when a publish happens outside this button (history cards'
   *  fix-then-pin publish-now) → status re-fetches. */
  publishSyncKey?: number;
  /** Pin toggle handed to the safe-versions rows (409-confirm flow).
   *  May return a promise (the shared parent handler is async) so the
   *  switch-to-complete flow can sequence unpin → pin → publish. */
  onTogglePin: (messageId: string, pinned: boolean) => void | Promise<void>;
  /** Global builder busy state (generation/restore) — disables rows. */
  builderBusy: boolean;
  /** Snapshot-fix handler handed to the unsafe rows' 🛠 buttons. A
   *  COMPLETE fix resolves with the generated files → the row offers to
   *  pin the now-complete version in the same flow (null = failed/partial). */
  onFix: (messageId: string) => string[] | null | void | Promise<string[] | null | void>;
  /** The snapshot a fix is currently regenerating (parent guard state) —
   *  that ONE button spins; everything else stays live. */
  fixingId?: string | null;
}) {
  const [state, setState] = useState<PublishState | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [customSlug, setCustomSlug] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`/api/projects/${projectId}/publish`)
      .then((r) => r.json())
      .then((d) => setState(d))
      .catch(() => {});
  }, [projectId, pinSyncKey, dirtyKey, publishSyncKey]);

  async function publish(slug?: string, force = false): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/publish${force ? "?force=1" : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(slug ? { slug } : {}),
        },
      );
      const data = await res.json();
      setState(res.ok ? data : { published: false, ...data });
      if (res.ok) {
        setCustomSlug("");
        setPanelOpen(true);
      }
      return res.ok;
    } finally {
      setBusy(false);
    }
  }

  /** One-click recovery from a pinned-missing refusal: unpin, pin the
   *  suggested newest COMPLETE snapshot (via the shared parent handler so
   *  pin state stays in sync), then republish so the public page
   *  immediately serves a version without 404ing assets. */
  async function switchPin(messageId: string) {
    setBusy(true);
    try {
      if (pinSyncKey) await onTogglePin(pinSyncKey, true);
      await onTogglePin(messageId, false);
      await publish();
    } finally {
      setBusy(false);
    }
  }

  /** One-click recovery when the pinned version is the ONLY version (no
   *  complete alternative to switch to): fix its missing assets in place
   *  (the same 🛠 the safe-versions rows use — the workspace is never
   *  touched), then publish — the repaired snapshot no longer trips the
   *  pinned-missing 409, so no force is needed. A partial/failed fix
   *  resolves null → don't publish (it would just 409 again). */
  /** One-click recovery when the pinned version is the ONLY version (no
   *  complete alternative to switch to): fix its missing assets in place
   *  (the same 🛠 the safe-versions rows use — the workspace is never
   *  touched), then publish — the repaired snapshot no longer trips the
   *  pinned-missing 409, so no force is needed. A partial/failed fix
   *  resolves null → don't publish (it would just 409 again). The wait
   *  reads honestly in two phases: this button itself spins while the
   *  fix generates ("Fixing…", panel stays live), and only the publish
   *  leg holds the panel-wide busy lock. */
  const [fixingPinned, setFixingPinned] = useState(false);
  async function fixPinnedAndPublish() {
    const pinnedId = state?.pinnedFrom ?? pinSyncKey;
    if (!pinnedId) return;
    setFixingPinned(true);
    let fixed: string[] | null | void;
    try {
      fixed = await onFix(pinnedId);
    } finally {
      setFixingPinned(false);
    }
    if (fixed?.length) await publish();
  }

  async function unpublish() {
    setBusy(true);
    try {
      await fetch(`/api/projects/${projectId}/publish`, { method: "DELETE" });
      setState({ published: false });
    } finally {
      setBusy(false);
    }
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(state?.publicUrl ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (http origins) — user can select the text
    }
  }

  const published = state?.published === true;

  return (
    <div className="relative">
      <button
        onClick={() => setPanelOpen((o) => !o)}
        className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
          published
            ? "border border-emerald-800 bg-emerald-950/60 text-emerald-300 hover:bg-emerald-900/60"
            : "bg-white text-neutral-900 hover:bg-neutral-200"
        }`}
      >
        {published ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Published
            {state.dirty && (
              <span
                data-testid="publish-dirty-badge"
                title="Workspace has newer changes — republish to go live."
                className="ml-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300"
              >
                ● changes
              </span>
            )}
          </>
        ) : (
          "Publish"
        )}
      </button>

      {panelOpen && (
        <div
          className="absolute right-0 top-10 z-40 w-80 rounded-xl border border-neutral-800 bg-neutral-900 p-4 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between">
            <h3 className="text-sm font-medium text-white">
              {published ? "Published" : "Publish to the web"}
            </h3>
            <button
              onClick={() => setPanelOpen(false)}
              className="text-neutral-500 hover:text-white"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          {state?.error && (
            <p className="mt-2 rounded-md border border-red-900 bg-red-950/50 px-2.5 py-1.5 text-xs text-red-300">
              {state.error}
            </p>
          )}

          {published ? (
            <>
              <div className="mt-3 flex items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-950 px-2.5 py-2">
                <input
                  readOnly
                  value={state.publicUrl ?? ""}
                  className="min-w-0 flex-1 bg-transparent font-mono text-xs text-neutral-300 outline-none"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  onClick={copyUrl}
                  className="rounded bg-neutral-800 px-2 py-1 text-[10px] text-neutral-200 hover:bg-neutral-700"
                >
                  {copied ? "copied ✓" : "copy"}
                </button>
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px] text-neutral-500">
                <span>
                  {state.dirty
                    ? "Workspace has newer changes — republish to go live."
                    : "Snapshot is up to date."}
                </span>
                {state.dirty && (
                  <button
                    onClick={() => publish()}
                    disabled={busy}
                    className="rounded bg-emerald-700 px-2 py-1 text-[10px] font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
                  >
                    {busy ? "Publishing…" : "Republish"}
                  </button>
                )}
              </div>
              {state.pinnedFrom && (
                <p
                  data-testid="publish-pinned-note"
                  className="mt-2 rounded-md border border-amber-900/60 bg-amber-950/40 px-2.5 py-1.5 text-[11px] text-amber-300"
                >
                  📌 Public page serves the pinned best version — live edits
                  stay private until you unpin or restore it.
                </p>
              )}
              {state.pinnedMissing && state.pinnedMissing.length > 0 && (
                <p
                  data-testid="publish-missing-note"
                  className="mt-2 rounded-md border border-red-900/60 bg-red-950/40 px-2.5 py-1.5 text-[11px] text-red-300"
                >
                  ⚠ The pinned snapshot is missing {state.pinnedMissing.length} asset
                  {state.pinnedMissing.length === 1 ? "" : "s"} its HTML references (
                  {state.pinnedMissing.join(", ")}) — they will 404 on the public
                  page. Unpin or restore a complete version.
                </p>
              )}
              {state.pinnedMissing &&
                state.pinnedMissing.length > 0 &&
                !state.suggest && (
                  <button
                    type="button"
                    data-testid="publish-fix-pinned"
                    disabled={busy || fixingPinned}
                    onClick={() => void fixPinnedAndPublish()}
                    className="mt-2 w-full rounded-lg border border-emerald-700/60 bg-emerald-950/40 px-3 py-2 text-xs font-medium text-emerald-300 transition hover:bg-emerald-900/40 disabled:cursor-wait disabled:opacity-40"
                  >
                    {fixingPinned
                      ? "◌ Fixing the pinned version…"
                      : "🛠 Fix the pinned version & publish"}
                  </button>
                )}
              {state.suggest && state.pinnedMissing && state.pinnedMissing.length > 0 && (
                <button
                  type="button"
                  data-testid="publish-switch-complete"
                  disabled={busy}
                  onClick={() => switchPin(state.suggest!)}
                  className="mt-2 w-full rounded-lg border border-emerald-700/60 bg-emerald-950/40 px-3 py-2 text-xs font-medium text-emerald-300 transition hover:bg-emerald-900/40 disabled:opacity-40"
                >
                  ↩ Switch to the most recent complete version &amp; publish
                </button>
              )}
              <SafeVersionsList
                projectId={projectId}
                refreshKey={snapshotRefreshKey}
                pinnedId={state.pinnedFrom ?? null}
                onTogglePin={onTogglePin}
                onFix={onFix}
                onPublish={publish}
                busy={busy || builderBusy}
                fixingId={fixingId}
              />
              <div className="mt-3 flex items-center justify-between border-t border-neutral-800 pt-3">
                <a
                  href={state.publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-emerald-400 hover:underline"
                >
                  Open public page ↗
                </a>
                <button
                  onClick={unpublish}
                  disabled={busy}
                  className="text-xs text-red-400 hover:underline disabled:opacity-40"
                >
                  Unpublish
                </button>
              </div>
              <DeploySection
                projectId={projectId}
                viewingVersion={viewingVersion}
                onViewVersion={onViewVersion}
              />
            </>
          ) : (
            <>
              <p className="mt-2 text-xs text-neutral-400">
                Publishes a snapshot of the current files to a public URL.
                Later edits stay private until you republish.
              </p>
              <SafeVersionsList
                projectId={projectId}
                refreshKey={snapshotRefreshKey}
                pinnedId={state?.pinnedFrom ?? null}
                onTogglePin={onTogglePin}
                onFix={onFix}
                onPublish={publish}
                busy={busy || builderBusy}
                fixingId={fixingId}
              />
              <div className="mt-3 flex items-center gap-1">
                <span className="text-xs text-neutral-600">/p/</span>
                <input
                  value={customSlug}
                  placeholder="custom-url (optional)"
                  className="min-w-0 flex-1 rounded-lg border border-neutral-800 bg-neutral-950 px-2.5 py-2 font-mono text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-600"
                  onChange={(e) =>
                    setCustomSlug(
                      e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                    )
                  }
                />
              </div>
              {state?.warning && (state.missing?.length ?? 0) > 0 && (
                <p
                  data-testid="publish-missing-warning"
                  className="mt-2 rounded-md border border-red-900/60 bg-red-950/40 px-2.5 py-1.5 text-[11px] text-red-300"
                >
                  ⚠ {state.warning} Missing: {state.missing!.join(", ")}. Fix the
                  workspace (or restore a complete version) and republish, or
                  pin anyway.
                </p>
              )}
              {state?.warning &&
                (state.missing?.length ?? 0) > 0 &&
                !state.suggest &&
                (state.pinnedFrom ?? pinSyncKey) && (
                  <button
                    type="button"
                    data-testid="publish-fix-pinned"
                    disabled={busy || fixingPinned}
                    onClick={() => void fixPinnedAndPublish()}
                    className="mt-2 w-full rounded-lg border border-emerald-700/60 bg-emerald-950/40 px-3 py-2 text-xs font-medium text-emerald-300 transition hover:bg-emerald-900/40 disabled:cursor-wait disabled:opacity-40"
                  >
                    {fixingPinned
                      ? "◌ Fixing the pinned version…"
                      : "🛠 Fix the pinned version & publish"}
                  </button>
                )}
              {state?.suggest && (
                <button
                  type="button"
                  data-testid="publish-switch-complete"
                  disabled={busy}
                  onClick={() => switchPin(state.suggest!)}
                  className="mt-2 w-full rounded-lg border border-emerald-700/60 bg-emerald-950/40 px-3 py-2 text-xs font-medium text-emerald-300 transition hover:bg-emerald-900/40 disabled:opacity-40"
                >
                  ↩ Switch to the most recent complete version &amp; publish
                </button>
              )}
              <button
                onClick={() =>
                  publish(
                    customSlug || undefined,
                    Boolean(state?.warning && (state.missing?.length ?? 0) > 0),
                  )
                }
                disabled={busy}
                className="mt-3 w-full rounded-lg bg-white px-3 py-2 text-xs font-medium text-neutral-900 hover:bg-neutral-200 disabled:opacity-40"
              >
                {busy
                  ? "Publishing…"
                  : state?.warning && (state.missing?.length ?? 0) > 0
                    ? "Publish anyway"
                    : "Publish"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A workspace line referencing an asset the workspace lacks. */
interface MissingRef {
  path: string;
  from: string;
  line: number;
}

/**
 * Code view that highlights lines referencing files the workspace lacks
 * (a broken src/href, @import, or url() — the small-model quirk of
 * referencing a script it never emitted). A left accent bar marks the
 * line; hovering names the missing file. Lines render through strings so
 * the exact file content survives (nothing strips or re-escapes it).
 */
export function MissingRefCodeView({
  content,
  missingLines,
}: {
  content: string;
  missingLines: number[];
}) {
  const missing = useMemo(() => new Set(missingLines), [missingLines]);
  const lines = useMemo(() => content.split("\n"), [content]);
  // Nothing to highlight (or no file content at all) → the plain view.
  if (missing.size === 0 || !content) {
    return (
      <pre className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-neutral-300">
        {content || "// Select a file"}
      </pre>
    );
  }
  return (
    <div
      data-testid="missing-ref-view"
      className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-neutral-300"
    >
      {lines.map((ln, i) => {
        const n = i + 1;
        const hit = missing.has(n);
        return (
          <div
            key={n}
            data-testid={hit ? `missing-ref-line-${n}` : undefined}
            title={hit ? "This line references a file the workspace doesn't have — it will 404." : undefined}
            className={
              hit
                ? "border-l-2 border-red-500 bg-red-950/40 pl-2 text-red-300"
                : "border-l-2 border-transparent pl-2"
            }
          >
            {ln === "" ? "\u00A0" : ln}
          </div>
        );
      })}
    </div>
  );
}

/**
 * "Which versions are safe to publish" list inside the publish panel.
 * Shows every turn snapshot with a ✓ (complete) or ⚠ (missing assets —
 * pinning/publishing it ships 404s) marker before the user commits to a
 * pin, so the publish panel answers "what CAN I safely publish?" — not
 * just the pinned snapshot's problems. The pinned version wears 📌.
 *
 * Rows double as the panel's pin toggle: clicking pins that version (or
 * unpins the pinned one), reusing the history panel's 409-confirm flow
 * for incomplete snapshots.
 */
export function SafeVersionsList({
  projectId,
  refreshKey,
  pinnedId,
  onTogglePin,
  onFix,
  onPublish,
  busy,
  fixingId,
}: {
  projectId: string;
  /** Bumps when snapshots change (generation, restore, fix, pin sync). */
  refreshKey: number;
  pinnedId: string | null;
  /** Same handler the history panel uses (parent's 409-confirm togglePin). */
  onTogglePin: (messageId: string, pinned: boolean) => void | Promise<void>;
  /** Regenerate an incomplete snapshot's missing assets in place (the
   *  same 🛠 fix the history cards offer); the list re-syncs via refreshKey.
   *  A COMPLETE fix resolves with the generated files → the row then
   *  offers to pin the now-complete version (one-flow recovery). */
  onFix: (messageId: string) => string[] | null | void | Promise<string[] | null | void>;
  busy: boolean;
  /** The snapshot a fix is currently regenerating — that ONE button spins
   *  while the other rows stay live. */
  fixingId?: string | null;
  /** Publish-now path for the fix-then-pin recovery's final offer
   *  (the panel's own publish); omit to keep the pin-only offer. */
  onPublish?: () => boolean | void | Promise<boolean | void>;
}) {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/snapshots`)
      .then((r) => (r.ok ? r.json() : { snapshots: [] }))
      .then((d) => {
        if (!cancelled) setSnapshots(d.snapshots as SnapshotSummary[]);
      })
      .catch(() => {
        if (!cancelled) setSnapshots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  if (!snapshots || snapshots.length === 0) return null;
  return (
    <div
      data-testid="publish-safe-versions"
      className="mt-3 border-t border-neutral-800 pt-2"
    >
      <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">
        Versions safe to publish
      </p>
      <ul className="mt-1 space-y-0.5">
        {snapshots.map((s) => {
          const ok = (s.missing?.length ?? 0) === 0;
          return (
            <li key={s.messageId} className="flex items-center gap-1">
            <button
              type="button"
              data-testid={`safe-version-${s.messageId}`}
              disabled={busy}
              onClick={() => onTogglePin(s.messageId, pinnedId === s.messageId)}
              title={
                ok
                  ? pinnedId === s.messageId
                    ? "Pinned — click to unpin"
                    : "Complete — click to pin: publishing ships this version"
                  : `Missing: ${s.missing!.join(", ")} — publishing this version ships 404s. Click to pin anyway (you'll be asked to confirm).`
              }
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] transition hover:bg-neutral-800/80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span aria-hidden className={ok ? "text-emerald-400" : "text-red-400"}>
                {ok ? "✓" : "⚠"}
              </span>
              <span className="text-neutral-400">
                {new Date(s.savedAt).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span className="min-w-0 flex-1 truncate text-neutral-500">
                {s.files.join(", ") || "empty"}
              </span>
              {!ok && (
                <span className="shrink-0 text-[10px] text-red-400/80">
                  missing {s.missing!.length}
                </span>
              )}
              {pinnedId === s.messageId && (
                <span className="shrink-0 text-[10px] text-amber-300" title="Pinned — publishing ships this version">
                  📌
                </span>
              )}
            </button>
            {!ok && (
              <button
                type="button"
                data-testid={`safe-version-fix-${s.messageId}`}
                disabled={busy || fixingId === s.messageId}
                onClick={() =>
                  void fixThenOfferPin(onFix, onTogglePin, onPublish, s.messageId)
                }
                title={
                  fixingId === s.messageId
                    ? "Generating the missing file(s)…"
                    : `Generate the missing file(s): ${s.missing!.join(", ")} — the workspace stays untouched`
                }
                className="shrink-0 rounded border border-emerald-800/60 px-1.5 py-0.5 text-[10px] text-emerald-400 transition hover:bg-emerald-950/60 disabled:cursor-wait disabled:opacity-40"
              >
                {fixingId === s.messageId ? "◌ fixing…" : "🛠 fix"}
              </button>
            )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Deployment section inside the publish panel: connect a Cloudflare account
 * (BYOK) and push the published snapshot to it for a real public URL.
 */
export function DeploySection({
  projectId,
  viewingVersion,
  onViewVersion,
}: {
  projectId: string;
  viewingVersion: number | null;
  onViewVersion: (v: number | null) => void;
}) {
  const [status, setStatus] = useState<DeployStatus | null>(null);
  const [deployment, setDeployment] = useState<DeploymentInfo | null>(null);
  const [accountId, setAccountId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [versions, setVersions] = useState<DeployVersionInfo[]>([]);

  useEffect(() => {
    fetch("/api/deploy/settings")
      .then((r) => r.json())
      .then((d) => {
        setStatus(d);
        setAccountId(d.accountId ?? "");
      })
      .catch(() => {});
    fetch(`/api/projects/${projectId}/deploy`)
      .then((r) => r.json())
      .then((d) => {
        setDeployment(d.deployment);
        setVersions(d.versions ?? []);
      })
      .catch(() => {});
  }, [projectId]);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/deploy/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, apiKey }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to connect");
        return;
      }
      setStatus(data);
      setApiKey("");
    } finally {
      setBusy(false);
    }
  }

  async function deploy() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/deploy`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Deploy failed");
        return;
      }
      setDeployment(data.deployment);
      if (data.versions) setVersions(data.versions);
      onViewVersion(null);
    } finally {
      setBusy(false);
    }
  }

  /** Roll back: restore a past version and redeploy it as the new live one. */
  async function rollback(version: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/deploy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Rollback failed");
        return;
      }
      setDeployment(data.deployment);
      if (data.versions) setVersions(data.versions);
      onViewVersion(null);
    } finally {
      setBusy(false);
    }
  }

  const connected = status?.connected === true;
  const liveVersion = deployment?.version;

  return (
    <div className="mt-4 border-t border-neutral-800 pt-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Deploy to Cloudflare
        </h4>
        {connected && (
          <span className="flex items-center gap-1 text-[10px] text-emerald-400">
            <span className="h-1 w-1 rounded-full bg-emerald-400" />
            connected
          </span>
        )}
      </div>

      {error && (
        <p className="mt-2 rounded-md border border-red-900 bg-red-950/50 px-2.5 py-1.5 text-xs text-red-300">
          {error}
        </p>
      )}

      {!connected ? (
        <>
          <p className="mt-2 text-[11px] text-neutral-500">
            Pushes this app to your Cloudflare account (Workers static assets)
            for a real public URL. Needs an API token with Workers Scripts:Edit.
          </p>
          <input
            value={accountId}
            onChange={(e) => setAccountId(e.target.value.trim())}
            aria-label="Cloudflare Account ID"
            placeholder="Cloudflare Account ID"
            className="mt-2 w-full rounded-lg border border-neutral-800 bg-neutral-950 px-2.5 py-2 font-mono text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-600"
          />
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            aria-label="Cloudflare API token"
            placeholder="API token (Workers Scripts:Edit)"
            className="mt-1.5 w-full rounded-lg border border-neutral-800 bg-neutral-950 px-2.5 py-2 font-mono text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-600"
          />
          <button
            onClick={connect}
            aria-label="Connect Cloudflare"
            disabled={busy || !accountId || !apiKey}
            className="mt-2 w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-40"
          >
            {busy ? "Verifying…" : "Connect Cloudflare"}
          </button>
        </>
      ) : (
        <>
          {deployment && (
            <div className="mt-2 flex items-center gap-1 rounded-lg border border-emerald-900 bg-emerald-950/40 px-2.5 py-2">
              <input
                readOnly
                value={deployment.url}
                className="min-w-0 flex-1 bg-transparent font-mono text-xs text-emerald-300 outline-none"
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(deployment.url);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch {}
                }}
                className="rounded bg-emerald-900 px-2 py-1 text-[10px] text-emerald-200 hover:bg-emerald-800"
              >
                {copied ? "copied ✓" : "copy"}
              </button>
            </div>
          )}
          <button
            onClick={deploy}
            disabled={busy}
            className="mt-2 w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-40"
          >
            {busy
              ? "Deploying…"
              : deployment
                ? "Redeploy latest snapshot"
                : "Deploy to Cloudflare"}
          </button>
          {deployment?.deployedAt && (
            <p className="mt-1.5 text-[10px] text-neutral-600">
              Last deployed{" "}
              {new Date(deployment.deployedAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
              {liveVersion ? ` · v${liveVersion} live` : ""}
            </p>
          )}

          <CustomDomainsSection projectId={projectId} />

          {versions.length > 0 && (
            <div className="mt-3 border-t border-neutral-800 pt-2">
              <div className="flex items-center justify-between">
                <h5 className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                  History ({versions.length})
                </h5>
                {viewingVersion !== null && (
                  <button
                    onClick={() => onViewVersion(null)}
                    className="text-[10px] text-neutral-400 hover:text-white"
                  >
                    back to live
                  </button>
                )}
              </div>
              <ul className="mt-1.5 space-y-1">
                {versions.map((v) => (
                  <li
                    key={v.version}
                    className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[11px] ${
                      v.version === liveVersion
                        ? "bg-emerald-950/50 text-emerald-300"
                        : "bg-neutral-950/60 text-neutral-300"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="font-mono">v{v.version}</span>
                      {v.version === liveVersion && (
                        <span className="rounded bg-emerald-800 px-1 text-[9px] text-emerald-200">
                          live
                        </span>
                      )}
                      <span className="truncate text-neutral-500">
                        {new Date(v.deployedAt).toLocaleString(undefined, {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {v.version !== liveVersion && (
                        <button
                          onClick={() => onViewVersion(v.version)}
                          className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-200 hover:bg-neutral-700"
                          title="Preview this version"
                        >
                          View
                        </button>
                      )}
                      {v.version !== liveVersion && (
                        <button
                          onClick={() => rollback(v.version)}
                          disabled={busy}
                          className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
                          title="Roll back to this version and redeploy it"
                        >
                          Restore
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export interface ModelCatalogEntry {
  id: string;
  name: string;
  configured: boolean;
  defaultModel: string;
  models: string[];
  error?: string;
}

interface ProjectModelData {
  override: { providerId: string; modelId: string } | null;
  default: { providerId?: string; modelId?: string };
  catalog: ModelCatalogEntry[];
}

/**
 * The shared rendering of a model catalog as <optgroup> options, used by
 * both the global picker and the per-project pin picker. One definition of
 * the client-side catalog rules: only `configured` entries (the flag is
 * computed by the server gate — never re-derived here), the live model list
 * falling back to the entry's default model when the endpoint doesn't list
 * any, and — when `ensureSelection` is given — the current selection stays
 * selectable even if the provider doesn't list it (a pin to a model the
 * endpoint doesn't advertise must not silently vanish from the picker).
 */
export function ModelOptgroups({
  entries,
  ensureSelection,
}: {
  entries: ModelCatalogEntry[];
  /** Current "providerId::modelId" selection to keep selectable, if any. */
  ensureSelection?: string;
}) {
  const [selProvider, selModel] = (ensureSelection ?? "").split("::");
  return (
    <>
      {entries
        .filter((p) => p.configured)
        .map((p) => {
          const modelList =
            p.models.length > 0
              ? p.models
              : p.defaultModel
                ? [p.defaultModel]
                : [];
          const extra =
            selProvider === p.id && selModel && !modelList.includes(selModel)
              ? [selModel]
              : [];
          if (extra.length === 0 && modelList.length === 0) return null;
          return (
            <optgroup key={p.id} label={`${p.name}${p.error ? ` (${p.error})` : ""}`}>
              {[...extra, ...modelList].map((m) => (
                <option key={`${p.id}::${m}`} value={`${p.id}::${m}`}>
                  {m}
                </option>
              ))}
            </optgroup>
          );
        })}
    </>
  );
}

/**
 * Per-project model pin, shown next to the global picker. Uses the pinned
 * model for this project only; other projects keep the global default.
 */
export function ProjectModelPicker({
  projectId,
  refreshKey,
}: {
  projectId: string;
  refreshKey: number;
}) {
  const [data, setData] = useState<ProjectModelData | null>(null);
  const [selection, setSelection] = useState<string>("global");
  /** Last committed pin — persist() no-ops when the value already matches. */
  const [loadedPin, setLoadedPin] = useState<string>("global");
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/model`)
      .then((r) => r.json())
      .then((d: ProjectModelData) => {
        if (cancelled) return;
        setData(d);
        setSelection(
          d.override ? `${d.override.providerId}::${d.override.modelId}` : "global",
        );
        setLoadedPin(
          d.override ? `${d.override.providerId}::${d.override.modelId}` : "global",
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  async function persist(value: string) {
    // Diff-based: never re-POST an already-committed pin (mirrors the
    // SettingsForm loaded-state pattern).
    if (value === loadedPin) return;
    setSaving(true);
    setSavedTick(false);
    try {
      if (value === "global") {
        await fetch(`/api/projects/${projectId}/model`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clear: true }),
        });
      } else {
        const [providerId, modelId] = value.split("::");
        await fetch(`/api/projects/${projectId}/model`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerId, modelId }),
        });
      }
      setLoadedPin(value);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  const pinned = selection !== "global";

  return (
    <div className="flex items-center gap-2">
      <select
        aria-label="Model for this project"
        value={selection}
        disabled={!data || saving}
        onChange={(e) => {
          setSelection(e.target.value);
          persist(e.target.value);
        }}
        className={`w-56 rounded-lg border px-3 py-1.5 text-xs outline-none hover:border-neutral-600 focus:border-neutral-600 disabled:opacity-50 ${
          pinned
            ? "border-indigo-800 bg-indigo-950/40 text-indigo-200"
            : "border-neutral-800 bg-neutral-900 text-neutral-200"
        }`}
        title="Model used by this project only (other projects use the global default)"
      >
        <option value="global">
          {data?.default.modelId
            ? `This project: default (${data.default.modelId})`
            : "This project: global default"}
        </option>
        <ModelOptgroups
          entries={data?.catalog ?? []}
          ensureSelection={pinned ? selection : undefined}
        />
      </select>
      {pinned && (
        <span
          className="rounded bg-indigo-900 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-indigo-200"
          title="This project uses a pinned model instead of the global default"
        >
          pinned
        </span>
      )}
      {saving && <span className="text-[10px] text-neutral-500">saving…</span>}
      {savedTick && <span className="text-[10px] text-emerald-400">saved ✓</span>}
    </div>
  );
}

/**
 * Model picker in the builder header. Lists models per configured provider
 * (grouped by provider), and persists the choice globally via the settings
 * API — the same activeProviderId/activeModel pair the Settings page edits.
 */
export function ModelPicker({ refreshKey }: { refreshKey: number }) {
  const [catalog, setCatalog] = useState<
    { providers: ModelCatalogEntry[]; active: { providerId?: string; model?: string } } | null
  >(null);
  const [selection, setSelection] = useState("::"); // "providerId::modelId"
  /** Last committed active pair — persist() no-ops when already active. */
  const [committed, setCommitted] = useState("::");
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setCatalog(d);
        setSelection(currentSelection(d));
        setCommitted(currentSelection(d));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // Keep the select's value in sync when the catalog refreshes.
  useEffect(() => {
    if (catalog) setSelection(currentSelection(catalog));
  }, [catalog]);

  function currentSelection(
    data: NonNullable<typeof catalog>,
  ): string {
    const usable = data.providers.filter(isUsable);
    if (usable.length === 0) return "::";
    const active = data.active.providerId
      ? usable.find((p) => p.id === data.active.providerId)
      : usable[0];
    const provider = active ?? usable[0];
    const model =
      provider.id === data.active.providerId && data.active.model
        ? data.active.model
        : provider.models[0] ?? provider.defaultModel;
    return `${provider.id}::${model}`;
  }

  function isUsable(p: ModelCatalogEntry): boolean {
    return p.configured;
  }

  async function persist(value: string) {
    const [providerId, modelId] = value.split("::");
    if (!providerId || !modelId) return;
    // Diff-based: skip re-posting the already-active pair.
    if (value === committed) return;
    setSaving(true);
    setSavedTick(false);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeProviderId: providerId, activeModel: modelId }),
      });
      setCommitted(value);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  const usable = (catalog?.providers ?? []).filter(isUsable);
  const disabled = usable.length === 0;

  return (
    <div className="flex items-center gap-2">
      <select
        value={selection}
        disabled={disabled || saving}
        onChange={(e) => {
          setSelection(e.target.value);
          persist(e.target.value);
        }}
        className="w-64 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 outline-none hover:border-neutral-600 focus:border-neutral-600 disabled:opacity-50"
        title={disabled ? "No provider configured — open Settings" : "Active model"}
      >
        {disabled && <option value="::">No provider configured — open Settings</option>}
        <ModelOptgroups
          entries={catalog?.providers ?? []}
          ensureSelection={selection}
        />
      </select>
      {saving && <span className="text-[10px] text-neutral-500">saving…</span>}
      {savedTick && <span className="text-[10px] text-emerald-400">saved ✓</span>}
    </div>
  );
}

/**
 * One-click recovery after a degenerate turn: the server stamps
 * `degenerate: true` on assistant messages that produced no files even
 * after the automatic retry (truncated fence, stream error, imitation).
 * Clicking Continue re-runs that turn with minimal history + a format
 * reminder; the new attempt replaces the failed one in place.
 */
export function ContinueGenerationBanner({
  messages,
  onContinue,
}: {
  messages: BuilderUIMessage[];
  onContinue: (messageId: string) => void;
}) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return null;
  const degenerate = Boolean(
    (last.metadata as { degenerate?: boolean } | undefined)?.degenerate,
  );
  if (!degenerate) return null;
  return (
    <div
      className="animate-rise rounded-lg border border-amber-800 bg-amber-950/40 px-3.5 py-3 text-xs leading-relaxed text-amber-300"
      data-testid="continue-banner"
    >
      <span className="font-medium">Generation cut off.</span> The model's reply
      was truncated or invalid, so no files were written.
      <button
        type="button"
        onClick={() => onContinue(last.id)}
        className="ml-2 rounded-md border border-amber-700 bg-amber-900/40 px-2.5 py-1 font-medium text-amber-200 transition hover:bg-amber-900/70"
      >
        ↻ Continue
      </button>
    </div>
  );
}

/** Exported for component tests (same seam as ContinueGenerationBanner). */
export function MessageBubble({
  message,
  footer,
}: {
  message: BuilderUIMessage;
  /** Extra node under the metadata line (per-turn Restore button). */
  footer?: React.ReactNode;
}) {
  if (message.role === "user") {
    return (
      <div className="animate-rise rounded-lg bg-neutral-800/60 px-3.5 py-2.5 text-sm">
        {message.parts
          .filter((p) => p.type === "text")
          .map((p, i) => (
            <span key={i}>{p.text}</span>
          ))}
      </div>
    );
  }
  const meta = message.metadata as
    | {
        modelUsed?: string;
        providerUsed?: string;
        fileCount?: number;
        retried?: boolean;
        quotaFallback?: boolean;
        degenerate?: boolean;
        rolledBackFiles?: number;
      }
    | undefined;
  return (
    <div className="animate-rise space-y-2">
      {meta?.quotaFallback && (
        <div className="rounded-lg border border-amber-800 bg-amber-950/40 px-3.5 py-2.5 text-xs leading-relaxed text-amber-300">
          <span className="font-medium">Free-tier limit hit.</span> The provider
          ran out of its daily quota or rate limit on this message. Switch to a
          stronger model in the header, add another provider in Settings, or
          wait for the quota to reset (daily).
        </div>
      )}
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 text-sm">
        {message.parts
          .filter((p) => p.type === "text")
          .map((p, i) => (
            <p key={i} className="whitespace-pre-wrap">
              {p.text}
            </p>
          ))}
        {message.parts.some((p) => p.type === "data-files") && (
          <div className="mt-2 rounded-md bg-emerald-950/50 px-2.5 py-1.5 text-xs text-emerald-400">
            ✓ App updated — preview refreshed
          </div>
        )}
      </div>
      {(meta?.providerUsed || meta?.rolledBackFiles) && (
        <div className="text-[11px] text-neutral-600">
          {[
            meta.providerUsed
              ? meta.modelUsed
                ? `${meta.providerUsed} · ${meta.modelUsed}`
                : meta.providerUsed
              : null,
            meta.fileCount ? `${meta.fileCount} file(s) written` : null,
            meta.retried ? "auto-retried" : null,
            meta.quotaFallback ? "quota fallback" : null,
            meta.rolledBackFiles
              ? `reverted ${meta.rolledBackFiles} partial file${meta.rolledBackFiles === 1 ? "" : "s"} from the cut-off attempt`
              : null,
            meta.degenerate ? "cut off — use Continue to retry" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
      {footer}
    </div>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-neutral-800 bg-neutral-900 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <SettingsForm onDone={onClose} embedded />
      </div>
    </div>
  );
}

/** Key for the active-pair save in the savingIds set. */
const ACTIVE_KEY = "__active__";

function SettingsForm({
  onDone,
  embedded,
}: {
  onDone: () => void;
  embedded?: boolean;
}) {
  const [providers, setProviders] = useState<
    import("@/lib/types").ProviderConfig[]
  >([]);
  const [activeId, setActiveId] = useState<string>();
  const [activeModel, setActiveModel] = useState<string>("");
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [baseURLs, setBaseURLs] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Record<string, string>>({});
  /**
   * Original server values per provider (baseURL, defaultModel), kept so
   * save() can diff and POST only rows the user actually touched — the
   * settings route merges partial payloads, so untouched providers must
   * not be restated (their catalog entries may have shipped updates the
   * user never saw, and restating them would silently pin those stale
   * copies into providers.json).
   */
  const [originals, setOriginals] = useState<
    Record<string, { baseURL: string; defaultModel: string }>
  >({});
  /** Active pair as last loaded/committed — save() posts it only on change. */
  const [loadedActiveId, setLoadedActiveId] = useState<string | undefined>(
    undefined,
  );
  const [loadedActiveModel, setLoadedActiveModel] = useState<string>("");
  /** Provider ids (plus ACTIVE_KEY) with a save in flight. */
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  /** Provider ids whose last save succeeded (clears on their next edit). */
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  /** One-tick confirmation for the active-pair save. */
  const [savedActive, setSavedActive] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setProviders(d.settings.providers);
        setActiveId(d.settings.activeProviderId);
        setActiveModel(d.settings.activeModel ?? "");
        const burls: Record<string, string> = {};
        const mods: Record<string, string> = {};
        const origs: Record<
          string,
          { baseURL: string; defaultModel: string }
        > = {};
        for (const p of d.settings.providers) {
          burls[p.id] = p.baseURL ?? "";
          mods[p.id] = p.defaultModel ?? "";
          origs[p.id] = {
            baseURL: p.baseURL ?? "",
            defaultModel: p.defaultModel ?? "",
          };
        }
        setBaseURLs(burls);
        setModels(mods);
        setOriginals(origs);
        setLoadedActiveId(d.settings.activeProviderId);
        setLoadedActiveModel(d.settings.activeModel ?? "");
      });
  }, []);

  /**
   * Re-sync committed state (configured badges + originals) after a save
   * WITHOUT clobbering unsaved edits in other cards — unlike the initial
   * load, this never touches the input maps or keys.
   */
  async function refreshCommitted() {
    const r = await fetch("/api/settings");
    if (!r.ok) return;
    const d = await r.json();
    setProviders(d.settings.providers);
    const origs: Record<
      string,
      { baseURL: string; defaultModel: string }
    > = {};
    for (const p of d.settings.providers) {
      origs[p.id] = {
        baseURL: p.baseURL ?? "",
        defaultModel: p.defaultModel ?? "",
      };
    }
    setOriginals(origs);
  }

  /**
   * The dirty state save() will diff against — one definition so the
   * indicator can never disagree with what save() would actually post.
   * (Whitespace-only key input doesn't count; save() trims it away.)
   */
  const dirtyProviderIds = useMemo(
    () =>
      providers
        .filter((p) => {
          const orig = originals[p.id];
          const origBaseURL = orig?.baseURL ?? p.baseURL ?? "";
          const origModel = orig?.defaultModel ?? p.defaultModel ?? "";
          return (
            (baseURLs[p.id] ?? "") !== origBaseURL ||
            (models[p.id] ?? "") !== origModel ||
            Boolean(keys[p.id]?.trim())
          );
        })
        .map((p) => p.id),
    [providers, originals, baseURLs, models, keys],
  );
  const activeDirty =
    activeId !== undefined && activeId !== loadedActiveId;
  const dirtyCount = dirtyProviderIds.length + (activeDirty ? 1 : 0);

  /**
   * Save ONE provider's diff — the per-card Save button. Same dirty rules
   * as the indicator; posts only changed fields (the settings route merges
   * partial payloads, so restating untouched rows would be a catalog-drift
   * hazard — see `originals`). After a key save, re-syncs the committed
   * view so the configured badge can flip without disturbing unsaved
   * edits in other cards.
   */
  async function saveProvider(p: import("@/lib/types").ProviderConfig) {
    const key = keys[p.id]?.trim();
    const baseURL = baseURLs[p.id] ?? "";
    const defaultModel = models[p.id] ?? "";
    const orig = originals[p.id];
    const payload: Record<string, unknown> = { id: p.id };
    if (baseURL !== (orig?.baseURL ?? p.baseURL ?? "")) payload.baseURL = baseURL;
    if (defaultModel !== (orig?.defaultModel ?? p.defaultModel ?? "")) {
      payload.defaultModel = defaultModel;
    }
    if (key) payload.apiKey = key;
    setSavingIds((s) => new Set(s).add(p.id));
    setSavedIds((s) => {
      const n = new Set(s);
      n.delete(p.id);
      return n;
    });
    try {
      await fetch("/api/settings", {
        method: "POST",
        body: JSON.stringify({ provider: payload }),
        headers: { "Content-Type": "application/json" },
      });
      setKeys((k) => {
        const n = { ...k };
        delete n[p.id];
        return n;
      });
      // The saved values are now the committed ones — update originals so
      // the card leaves the dirty state (key saves additionally re-sync
      // from the server below for the configured badge).
      setOriginals((o) => ({
        ...o,
        [p.id]: { baseURL: baseURLs[p.id] ?? "", defaultModel: models[p.id] ?? "" },
      }));
      setSavedIds((s) => new Set(s).add(p.id));
      if (payload.apiKey) await refreshCommitted();
    } finally {
      setSavingIds((s) => {
        const n = new Set(s);
        n.delete(p.id);
        return n;
      });
    }
  }

  /**
   * The active pair commits the moment the radio changes. The model field
   * is cleared so the resolver falls back to the NEW provider's own
   * default model — posting the previous provider's model id here would
   * send the wrong model to the wrong provider.
   */
  async function saveActive(nextId: string) {
    setSavingIds((s) => new Set(s).add(ACTIVE_KEY));
    try {
      await fetch("/api/settings", {
        method: "POST",
        body: JSON.stringify({ activeProviderId: nextId, activeModel: "" }),
        headers: { "Content-Type": "application/json" },
      });
      setActiveId(nextId);
      setActiveModel("");
      setLoadedActiveId(nextId);
      setLoadedActiveModel("");
      setSavedActive(true);
      setTimeout(() => setSavedActive(false), 1500);
    } finally {
      setSavingIds((s) => {
        const n = new Set(s);
        n.delete(ACTIVE_KEY);
        return n;
      });
    }
  }

  return (
    <div>
      {!embedded && <h1 className="text-2xl font-semibold text-white">AI Providers</h1>}
      <p className="mt-1 text-sm text-neutral-400">
        Anybase works with any OpenAI-compatible API. Keys are stored locally in
        providers.json and never leave your machine except to call the provider
        directly.
      </p>

      <div className="mt-5 flex items-center gap-3">
        {dirtyCount > 0 && (
          <span
            role="status"
            className="text-xs text-amber-400"
            title="Edits not yet saved to the server"
          >
            {dirtyCount === 1
              ? "Unsaved change"
              : `${dirtyCount} unsaved changes`}
          </span>
        )}
        {savedActive && (
          <span role="status" className="text-xs text-emerald-400">
            Saved ✓
          </span>
        )}
      </div>

      <div className="mt-5 space-y-3">
        {providers.map((p) => (
          <div
            key={p.id}
            className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="activeProvider"
                  aria-label={`Use ${p.name}`}
                  checked={activeId === p.id}
                  onChange={() => void saveActive(p.id)}
                  className="accent-white"
                />
                <span className="font-medium text-white">{p.name}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    p.configured
                      ? "bg-emerald-950 text-emerald-400"
                      : "bg-neutral-800 text-neutral-500"
                  }`}
                >
                  {p.configured ? "configured" : "needs key"}
                </span>
                {dirtyProviderIds.includes(p.id) && (
                  <span
                    className="rounded bg-amber-950 px-1.5 py-0.5 text-[10px] text-amber-300"
                    title="This provider has unsaved edits"
                  >
                    unsaved
                  </span>
                )}
              </div>
              <span className="text-xs text-neutral-600">{p.id}</span>
            </div>
            {p.note && (
              <p className="mt-1 text-xs text-neutral-500">{p.note}</p>
            )}
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                type="password"
                placeholder={
                  p.configured ? "••••••• (saved)" : "API key"
                }
                aria-label={`API key for ${p.name}`}
                value={keys[p.id] ?? ""}
                onChange={(e) => setKeys({ ...keys, [p.id]: e.target.value })}
                className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs outline-none focus:border-neutral-600"
              />
              <input
                placeholder="Model"
                aria-label={`Default model for ${p.name}`}
                value={models[p.id] ?? ""}
                onChange={(e) => setModels({ ...models, [p.id]: e.target.value })}
                className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs outline-none focus:border-neutral-600"
              />
              <input
                placeholder="Base URL"
                aria-label={`Base URL for ${p.name}`}
                value={baseURLs[p.id] ?? ""}
                onChange={(e) =>
                  setBaseURLs({ ...baseURLs, [p.id]: e.target.value })
                }
                className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs outline-none focus:border-neutral-600 sm:col-span-2"
              />
            </div>
            <div className="mt-3 flex items-center justify-end gap-2">
              {savingIds.has(p.id) ? (
                <span className="text-xs text-neutral-500">Saving…</span>
              ) : dirtyProviderIds.includes(p.id) ? (
                <button
                  onClick={() => void saveProvider(p)}
                  aria-label={`Save ${p.name}`}
                  className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:border-neutral-500"
                >
                  Save
                </button>
              ) : savedIds.has(p.id) ? (
                <span className="text-xs text-emerald-400">Saved ✓</span>
              ) : null}
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}

// Exposed for the /settings page.
export { SettingsForm };
