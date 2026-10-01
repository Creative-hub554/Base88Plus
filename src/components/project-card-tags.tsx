"use client";

import { useInlineMetaEdit, MetaEditButtons } from "./inline-meta-edit";

/**
 * Inline project-tags editor on dashboard cards — the third metadata
 * surface, built as a thin shell over the shared `useInlineMetaEdit`
 * layer. Proof the #84 extraction pays off: every shared rule (the
 * one-field PATCH to /api/projects/[id]/meta, server-wins normalization,
 * failure toasts that revert) lives in the hook; this file is only the
 * card-specific shell — exactly like ProjectCardDescription, with no
 * state machine of its own.
 *
 * Tags are ONE comma-separated string on the wire; the store splits it,
 * trims each tag, drops empties, and re-joins with ", " (so what the
 * server persisted is what the card displays — server-wins for formatting
 * too). Same sibling-overlay contract as the description editor: clicks
 * and keys are stopped at the boundary so editing never triggers the
 * card's navigation, and the commit is an explicit Save/Cancel pair
 * (Enter commits; a blur-commit would fight the buttons).
 */
export function ProjectCardTags({
  projectId,
  initialTags,
  fallback = "No tags",
}: {
  projectId: string;
  initialTags: string;
  fallback?: string;
}) {
  const meta = useInlineMetaEdit({
    projectId,
    field: "tags",
    initial: initialTags,
    clientCap: 120,
    savedToast: () => "Tags updated.",
    clearedToast: () => "Tags cleared.",
  });

  if (meta.editing) {
    return (
      <div
        className="mt-1"
        // Never let edit-mode input bubble into the card <Link>.
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        data-testid="card-tags-editing"
      >
        <input
          autoFocus
          type="text"
          value={meta.draft}
          onChange={(e) => meta.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              meta.cancel();
            }
            if (e.key === "Enter") {
              e.preventDefault();
              void meta.commit();
            }
          }}
          maxLength={120}
          placeholder="comma, separated, tags"
          aria-label="Project tags"
          data-testid="card-tags-input"
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-white outline-none focus:border-neutral-500"
        />
        <MetaEditButtons
          busy={meta.busy}
          onSave={() => void meta.commit()}
          onCancel={meta.cancel}
          counter={`${meta.draft.trim().length}/120`}
          saveTestId="card-tags-save"
          cancelTestId="card-tags-cancel"
        />
      </div>
    );
  }

  return (
    <div className="group relative mt-1" data-testid="card-tags">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          meta.start();
        }}
        disabled={meta.busy}
        title={meta.value ? "Edit tags" : "Add tags"}
        data-testid="card-tags-button"
        className="block w-full text-left"
      >
        <span
          className={`line-clamp-1 pr-4 text-xs ${meta.value ? "text-neutral-400" : "italic text-neutral-600"}`}
        >
          {meta.value || fallback}
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
