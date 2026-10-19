"use client";

import { useCallback, useEffect, useState } from "react";

import {
  reloadEvidence,
  type ReloadEntry,
  type ReloadHistoryView,
} from "@/lib/deploy/reload-history";

/**
 * The reloads the production server has performed, on the settings page.
 *
 * A reload is a decision about a live server — the replacement is serving, or it
 * was rolled back, or nothing changed — and it happens while nobody is watching
 * the terminal: `npm start`'s supervisor is usually running under a process
 * manager, on a machine the operator is not sitting at. This panel is that
 * decision surfaced where the operator already is, reading from the same file the
 * deploy gate reads and naming each outcome with the same words
 * (`OUTCOME_VERDICT`), so the page can never colour a rollback green while the
 * gate fails the deploy over it.
 *
 * It is a VIEW, not a gate, and it degrades like one: no history configured, no
 * file yet, a request that failed — each is a sentence on the page, never a
 * missing panel or a thrown render. The one thing it refuses to do quietly is
 * mislabel: an outcome this build does not know is shown verbatim, as unknown,
 * rather than folded into "replaced" or hidden.
 *
 * The time is absolute and the exact instant is in the tooltip, because a
 * relative age is only true at the moment it renders — and this panel is fetched
 * once and then only when someone asks.
 */

/** The tone a verdict reads in: landed, did not land, or not understood. */
function toneOf(entry: ReloadEntry): string {
  if (entry.verdict === null) return "bg-neutral-800 text-neutral-400";
  return entry.verdict.landed
    ? "bg-emerald-950 text-emerald-400"
    : "bg-red-950 text-red-400";
}

function When({ at }: { at?: string }) {
  if (!at) return <span className="shrink-0 text-[10px] text-neutral-600">-</span>;
  const when = new Date(at);
  return (
    <span
      className="shrink-0 text-[10px] text-neutral-600"
      title={`${at} (UTC)`}
    >
      {Number.isNaN(when.getTime()) ? at : when.toLocaleString()}
    </span>
  );
}

function ReloadRow({ entry }: { entry: ReloadEntry }) {
  const label = entry.verdict?.word ?? entry.record.outcome ?? "UNKNOWN";
  return (
    <li className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-3">
      {/* The badge and the moment on one line, the words on their own: an outcome
          name is short and a sentence is long, and interleaving them wraps a row
          into something that reads like two. */}
      <div className="flex items-center justify-between gap-3">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${toneOf(entry)}`}>
          {label}
        </span>
        <When at={entry.record.at} />
      </div>
      <p className="mt-1 text-xs leading-relaxed text-neutral-400">
        {entry.verdict
          ? entry.verdict.why
          : "an outcome this build does not know — the supervisor is newer than this page"}
      </p>
      <p className="mt-1 text-[10px] leading-relaxed text-neutral-500">
        {reloadEvidence(entry.record)}
      </p>
      {entry.record.detail && (
        <p className="mt-1 text-[10px] leading-relaxed text-neutral-400">
          {entry.record.detail}
        </p>
      )}
    </li>
  );
}

export function ReloadHistorySection() {
  const [view, setView] = useState<ReloadHistoryView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/deploy/reloads");
      setView((await res.json()) as ReloadHistoryView);
      setFailed(false);
    } catch {
      // The page keeps its other sections: a panel that cannot read the history
      // says so, and that is the whole of the damage.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const unreadable = view?.unreadable ?? [];

  return (
    <section className="mt-10" aria-label="Reloads">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Reloads</h2>
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          aria-label="Refresh reloads"
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-200 transition hover:border-neutral-500 disabled:cursor-wait disabled:opacity-40"
        >
          {busy ? "Reading…" : "Refresh"}
        </button>
      </div>
      <p className="mt-1 text-xs text-neutral-400">
        Every reload <code>npm start</code> performs, as the supervisor wrote it
        down — the replacement serving, a rollback, or nothing changed. This is
        the same record <code>npm run check:reload-history</code> gates a deploy
        on.
      </p>

      {failed && (
        <p role="status" className="mt-4 text-xs text-amber-400">
          Could not read the reload history — the request to{" "}
          <code>/api/deploy/reloads</code> failed. The rest of this page is
          unaffected.
        </p>
      )}

      {!failed && view && !view.configured && (
        <p role="status" className="mt-4 text-xs text-neutral-400">
          No reload history is configured. Name a path with{" "}
          <code>PROD_RELOAD_HISTORY</code> and restart <code>npm start</code>:
          every reload it performs from then on appends a line to that file, and
          this panel shows the last ten.
        </p>
      )}

      {!failed && view?.error && (
        <p role="status" className="mt-4 text-xs text-amber-400">
          {view.error.message}
        </p>
      )}

      {!failed && view?.configured && !view.error && view.records.length === 0 && (
        <p role="status" className="mt-4 text-xs text-neutral-400">
          No reload has been performed yet. The file exists; the first reload
          writes its first line.
        </p>
      )}

      {!failed && view && view.records.length > 0 && (
        <>
          <ul aria-label="Recent reloads" className="mt-4 space-y-2">
            {view.records.map((entry) => (
              <ReloadRow key={`${entry.line}-${entry.atMs}`} entry={entry} />
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-neutral-600">
            {view.records.length === view.total
              ? `${view.total} reload(s) recorded in ${view.path}`
              : `newest ${view.records.length} of ${view.total} reload(s) recorded in ${view.path}`}
          </p>
        </>
      )}

      {!failed && unreadable.length > 0 && (
        <p role="status" className="mt-2 text-[10px] text-amber-400">
          {unreadable.length} line(s) of the history could not be read (
          {unreadable.map((problem) => `line ${problem.line}: ${problem.reason}`).join("; ")}
          ) — the reload gate refuses to judge a file with one, since it cannot
          read all of its evidence.
        </p>
      )}
    </section>
  );
}
