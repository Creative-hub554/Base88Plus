"use client";

import { useInlineMetaEdit, MetaEditButtons } from "./inline-meta-edit";

/**
 * Inline project-description editor on dashboard cards — the list-view leg
 * of the metadata lifecycle (#77 put rename/describe in the builder header;
 * this puts it where every project is first seen). All shared rules live in
 * `useInlineMetaEdit` (PATCH /api/projects/[id]/meta, server-wins
 * normalization, failure toasts); this file is the card-specific shell.
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
  const meta = useInlineMetaEdit({
    projectId,
    field: "description",
    initial: initialDescription,
    clientCap: 500,
    savedToast: () => "Description updated.",
    clearedToast: () => "Description cleared.",
  });

  if (meta.editing) {
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
          value={meta.draft}
          onChange={(e) => meta.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              meta.cancel();
            }
          }}
          maxLength={500}
          aria-label="Project description"
          data-testid="card-desc-input"
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-white outline-none focus:border-neutral-500"
        />
        <MetaEditButtons
          busy={meta.busy}
          onSave={() => void meta.commit()}
          onCancel={meta.cancel}
          counter={`${meta.draft.trim().length}/500`}
          saveTestId="card-desc-save"
          cancelTestId="card-desc-cancel"
        />
      </div>
    );
  }

  return (
    <div className="group relative mt-1" data-testid="card-desc">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          meta.start();
        }}
        disabled={meta.busy}
        title={meta.value ? "Edit description" : "Add a description"}
        data-testid="card-desc-button"
        className="block w-full text-left"
      >
        <span
          className={`line-clamp-2 pr-4 text-sm ${
            meta.value ? "text-neutral-500" : "italic text-neutral-600"
          }`}
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
