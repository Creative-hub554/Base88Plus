"use client";

import Link from "next/link";
import { useInlineMetaEdit, MetaEditButtons } from "./inline-meta-edit";
import { splitTags } from "@/lib/tags";

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
 *
 * TAGS ARE FUNCTIONAL: each rendered tag is a link to `/?tag=<tag>`, the
 * dashboard's server-side filter. The whole-area click-to-edit affordance
 * is kept only for the EMPTY state ("Add tags"); once tags exist, the
 * pencil is the edit trigger and the pills filter.
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

  const tags = splitTags(meta.value);

  // Empty state: the whole area opens the editor (nothing to filter yet).
  if (tags.length === 0) {
    return (
      <div className="group relative mt-1" data-testid="card-tags">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            meta.start();
          }}
          disabled={meta.busy}
          title="Add tags"
          data-testid="card-tags-button"
          className="block w-full text-left"
        >
          <span className="line-clamp-1 pr-4 text-xs italic text-neutral-600">
            {fallback}
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

  // Tags exist: pills filter the dashboard; the pencil edits.
  return (
    <div className="group relative mt-1" data-testid="card-tags">
      <div className="flex items-center gap-1 overflow-hidden pr-5">
        {tags.map((tag) => (
          <Link
            key={tag}
            href={`/?tag=${encodeURIComponent(tag)}`}
            onClick={(e) => e.stopPropagation()}
            title={`Show projects tagged “${tag}”`}
            aria-label={`Filter projects by tag ${tag}`}
            data-testid="card-tags-pill"
            className="whitespace-nowrap rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] leading-4 text-neutral-300 transition hover:bg-neutral-700"
          >
            {tag}
          </Link>
        ))}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          meta.start();
        }}
        disabled={meta.busy}
        title="Edit tags"
        aria-label="Edit tags"
        data-testid="card-tags-button"
        className="absolute right-0 top-0 text-xs text-neutral-600 opacity-0 transition hover:text-neutral-400 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:text-neutral-400 focus-visible:outline-none"
      >
        ✎
      </button>
    </div>
  );
}
