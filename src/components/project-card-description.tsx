"use client";

import { useState } from "react";
import { notify } from "./toast";

/**
 * Inline project-description editor on dashboard cards — the list-view leg
 * of the metadata lifecycle (#77 put rename/describe in the builder header;
 * this puts it where every project is first seen). Same contract as
 * ProjectNameEditor: the server is THE validator (PATCH
 * /api/projects/[id]/meta), the 500-char cap here is only UX, and the
 * committed value is whatever the server normalized. An empty description
 * is allowed and falls back to "No description". Failures toast and revert.
 *
 * The dashboard card is a server-rendered <Link>, so this renders as a
 * sibling overlay INSIDE the card: clicks and key events are stopped at the
 * component boundary so editing never triggers card navigation, and the
 * commit is an explicit Save/Cancel pair (a blur-commit would fight the
 * buttons — clicking Save would blur first).
 */
export function ProjectCardDescription({
  projectId,
  initialDescription,
  fallback = "No description",
}: {
  projectId: string;
  initialDescription: string;
  fallback?: string;
}) {
  const [description, setDescription] = useState(initialDescription);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const commit = async () => {
    setEditing(false);
    const next = draft.trim().slice(0, 500);
    if (busy || next === description) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/meta`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: next }),
      });
      const data = (await res.json().catch(() => null)) as
        | { project?: { description?: string }; error?: string }
        | null;
      if (res.ok && data?.project) {
        // The server-normalized value is the truth (trim + cap happened
        // there); show exactly what was persisted.
        setDescription(data.project.description ?? "");
        notify(next ? "Description updated." : "Description cleared.");
      } else {
        notify(data?.error || "Description update failed — try again.", "danger");
      }
    } catch {
      notify("Description update failed — network error.", "danger");
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div
        className="mt-1"
        // Never let edit-mode input bubble into the card <Link>.
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        data-testid="card-desc-editing"
      >
        <textarea
          autoFocus
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          maxLength={500}
          aria-label="Project description"
          data-testid="card-desc-input"
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-white outline-none focus:border-neutral-500"
        />
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={commit}
            disabled={busy}
            data-testid="card-desc-save"
            className="rounded-md bg-white px-2 py-0.5 text-xs font-medium text-neutral-900 transition hover:bg-neutral-200 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            disabled={busy}
            data-testid="card-desc-cancel"
            className="rounded-md border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 transition hover:bg-neutral-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <span className="ml-auto font-mono text-[10px] text-neutral-600">
            {draft.trim().length}/500
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="group relative mt-1" data-testid="card-desc">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setDraft(description);
          setEditing(true);
        }}
        disabled={busy}
        title={description ? "Edit description" : "Add a description"}
        data-testid="card-desc-button"
        className="block w-full text-left"
      >
        <span
          className={`line-clamp-2 pr-4 text-sm ${
            description ? "text-neutral-500" : "italic text-neutral-600"
          }`}
        >
          {description || fallback}
        </span>
        <span
          aria-hidden
          className="absolute right-0 top-0 text-xs text-neutral-600 opacity-0 transition group-hover:opacity-100"
        >
          ✎
        </span>
      </button>
    </div>
  );
}
