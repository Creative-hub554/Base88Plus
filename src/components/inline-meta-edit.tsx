"use client";

import { useState } from "react";
import { notify } from "./toast";

/**
 * Shared state machine + wire contract for every inline project-metadata
 * editor (builder-header name editor, dashboard card description editor,
 * and whatever field comes next). One place owns THE rules:
 *
 * - the PATCH goes to `/api/projects/[projectId]/meta` with exactly one
 *   field key (`name` or `description`) — never both;
 * - the server is THE validator: the client cap is UX-only, and the
 *   committed value is whatever the server normalized;
 * - failures toast danger and leave the previous value in place;
 * - success stores the server-normalized value and closes edit mode.
 *
 * Commit semantics differ per surface and stay caller-owned: the header
 * name editor commits on blur/Enter (single-click rename in the header),
 * the card description editor uses an explicit Save/Cancel pair (its
 * blur would fight the buttons). Everything else — draft lifecycle, busy
 * guard, wire shape, server-wins normalization — lives here.
 */

/** The persisted record fields the meta route can return. */
export interface MetaEditResult {
  name?: string;
  description?: string;
}

export function useInlineMetaEdit(options: {
  projectId: string;
  /** The single meta field this editor owns: "name" | "description". */
  field: "name" | "description";
  /** Current persisted value (server truth); kept in local state. */
  initial: string;
  /** UX-only cap applied to the draft before sending. */
  clientCap: number;
  /** Success toast copy for a non-empty committed value. */
  savedToast: (value: string) => string;
  /** Toast copy when the committed value is empty (where allowed). */
  clearedToast?: () => string;
}) {
  const { projectId, field, initial, clientCap } = options;
  const [value, setValue] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  /** Enter edit mode with the draft seeded from the persisted value. */
  const start = () => {
    setDraft(value);
    setEditing(true);
  };

  /** Discard the draft; blocked while a save is in flight. */
  const cancel = () => {
    if (busy) return;
    setEditing(false);
  };

  /**
   * Commit the draft. `next` defaults to the current draft; the header
   * editor passes a trimmed override for blur-commits. No-ops when the
   * normalized value is unchanged, so re-blurs are free.
   */
  const commit = async (nextOverride?: string) => {
    const next = (nextOverride ?? draft).trim().slice(0, clientCap);
    if (busy || next === value) return;
    // Close edit mode up front (both surfaces did this): a failure lands
    // the user back on the display value, never on a stale draft.
    setEditing(false);
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/meta`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: next }),
      });
      const data = (await res.json().catch(() => null)) as
        | { project?: MetaEditResult; error?: string }
        | null;
      const record = data?.project;
      if (res.ok && record) {
        // The server-normalized value is the truth (trim + cap happened
        // there); show exactly what was persisted.
        setValue(record[field] ?? "");
        if (next) notify(options.savedToast(record[field] ?? ""));
        else options.clearedToast?.();
      } else {
        notify(data?.error || "Update failed — try again.", "danger");
      }
    } catch {
      notify("Update failed — network error.", "danger");
    } finally {
      setBusy(false);
    }
  };

  return { value, editing, draft, busy, setDraft, start, cancel, commit };
}

/** The Save/Cancel row under an editing surface (card description). */
export function MetaEditButtons(props: {
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
  /** Optional live counter (e.g. "128/500") right-aligned in the row. */
  counter?: string;
  saveLabel?: string;
  /** Stable per-surface selectors (existing suites pin card-desc-*). */
  saveTestId?: string;
  cancelTestId?: string;
}) {
  const {
    busy,
    onSave,
    onCancel,
    counter,
    saveLabel = "Save",
    saveTestId = "meta-edit-save",
    cancelTestId = "meta-edit-cancel",
  } = props;
  return (
    <div className="mt-1 flex items-center gap-2">
      <button
        type="button"
        onClick={onSave}
        disabled={busy}
        data-testid={saveTestId}
        className="rounded-md bg-white px-2 py-0.5 text-xs font-medium text-neutral-900 transition hover:bg-neutral-200 disabled:opacity-50"
      >
        {busy ? "Saving…" : saveLabel}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        data-testid={cancelTestId}
        className="rounded-md border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 transition hover:bg-neutral-800 disabled:opacity-50"
      >
        Cancel
      </button>
      {counter && (
        <span className="ml-auto font-mono text-[10px] text-neutral-600">
          {counter}
        </span>
      )}
    </div>
  );
}
