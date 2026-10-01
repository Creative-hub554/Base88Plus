"use client";

import { useInlineMetaEdit, MetaEditButtons } from "./inline-meta-edit";
import { PROJECT_STATUSES, type ProjectStatus } from "@/lib/status";

/**
 * Inline project-status editor on dashboard cards — the FOURTH metadata
 * surface, and the first application of docs/playbooks.md recipe 7.
 * Shell only: every shared rule lives in `useInlineMetaEdit`; what is
 * surface-specific here is the WIDGET and the commit semantics:
 *
 * - display: a colored-dot badge (idea = neutral, building = amber,
 *   shipped = emerald) linking to the dashboard's `/?status=` filter;
 * - edit: a select over the PROJECT_STATUSES enum — the server is THE
 *   validator (unknown values 400 with the value list), the client cap
 *   rule does not apply to enums so the counter is omitted;
 * - commit: explicit Save/Cancel (same blur-fights-buttons reasoning as
 *   the other card editors); Escape cancels; no Enter commit — a select
 *   already gives one-click choice, and Enter-in-select has native
 *   form semantics we do not want to fight.
 *
 * Empty state: "No status" affordance opens the editor; once set, the
 * badge is the filter link and the pencil re-opens the editor (recipe 7
 * rule 5: filled state may be a feature).
 */

const STATUS_DOT: Record<ProjectStatus, string> = {
  idea: "bg-neutral-500",
  building: "bg-amber-400",
  shipped: "bg-emerald-400",
};

export function ProjectCardStatus({
  projectId,
  initialStatus,
  fallback = "No status",
}: {
  projectId: string;
  initialStatus: string;
  fallback?: string;
}) {
  const meta = useInlineMetaEdit({
    projectId,
    field: "status",
    initial: initialStatus,
    clientCap: 20,
    savedToast: (value) => `Status set to ${value}.`,
    clearedToast: () => "Status cleared.",
  });

  if (meta.editing) {
    return (
      <div
        className="mt-1"
        // Never let edit-mode input bubble into the card <Link>.
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        data-testid="card-status-editing"
      >
        <select
          autoFocus
          value={meta.draft}
          onChange={(e) => meta.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              meta.cancel();
            }
          }}
          aria-label="Project status"
          data-testid="card-status-select"
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-white outline-none focus:border-neutral-500"
        >
          <option value="">{fallback}</option>
          {PROJECT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <MetaEditButtons
          busy={meta.busy}
          onSave={() => void meta.commit()}
          onCancel={meta.cancel}
          saveTestId="card-status-save"
          cancelTestId="card-status-cancel"
        />
      </div>
    );
  }

  // Empty state: the whole area opens the editor (nothing to filter yet).
  if (!meta.value) {
    return (
      <div className="group relative mt-1" data-testid="card-status">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            meta.start();
          }}
          disabled={meta.busy}
          title="Set status"
          data-testid="card-status-button"
          className="block w-full text-left"
        >
          <span className="text-xs italic text-neutral-600">{fallback}</span>
          <span
            aria-hidden
            className="absolute right-0 top-0 text-xs text-neutral-600 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
          >
            ✎
          </span>
        </button>
      </div>
    );
  }

  // Status set: badge is the filter link; the pencil edits.
  return (
    <div className="group relative mt-1" data-testid="card-status">
      <div className="flex items-center gap-1.5 pr-5">
        <span
          aria-hidden
          className={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_DOT[meta.value as ProjectStatus] ?? "bg-neutral-500"}`}
        />
        <a
          href={`/?status=${encodeURIComponent(meta.value)}`}
          onClick={(e) => e.stopPropagation()}
          title={`Show ${meta.value} projects`}
          aria-label={`Filter projects by status ${meta.value}`}
          data-testid="card-status-badge"
          className="text-xs text-neutral-300 transition hover:text-white"
        >
          {meta.value}
        </a>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          meta.start();
        }}
        disabled={meta.busy}
        title="Edit status"
        aria-label="Edit status"
        data-testid="card-status-button"
        className="absolute right-0 top-0 text-xs text-neutral-600 opacity-0 transition hover:text-neutral-400 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:text-neutral-400 focus-visible:outline-none"
      >
        ✎
      </button>
    </div>
  );
}
