import Link from "next/link";
import { getGenerationHealth } from "@/lib/store";
import type { Project } from "@/lib/types";
import { ProjectCardDescription } from "./project-card-description";
import { ProjectCardTags } from "./project-card-tags";
import { ProjectCardStatus } from "./project-card-status";

/**
 * The dashboard's project card — ONE component, two layouts:
 *
 * - `grid` (default): the full card — description + tags + status editors
 *   in the reserved-slot overlay beside the link, plus the updated /
 *   generation-health meta lines. Markup identical to the pre-extraction
 *   inline card (per-surface suites + dashboard suite pin this);
 * - `board`: the compact card — no description slot (the board groups by
 *   status; description text fights the column width) and no meta lines,
 *   tags + status editors only.
 *
 * Both layouts keep the recipe 7 sibling-overlay contract: the client
 * editors render as a SIBLING of the card <Link>, never inside it, so
 * their stopPropagation boundaries stay authoritative and editing never
 * triggers navigation. The board passes `refreshAfterSave` to the status
 * editor so a status change re-sorts the card into its new column (the
 * grid card never moves, so the grid leaves it off).
 */
export function ProjectCard({
  project,
  layout = "grid",
  published,
  modelId,
}: {
  project: Project;
  layout?: "grid" | "board";
  published?: boolean;
  /** Effective model id — feeds the grid's generation-health line. */
  modelId?: string;
}) {
  const p = project;
  const board = layout === "board";

  // Reserved slots: the overlay editors position over these. Board keeps
  // only the tags/status rows; grid also reserves the description slot.
  const slots = board ? (
    <>
      <div className="h-5" aria-hidden />
      <div className="h-5" aria-hidden />
    </>
  ) : (
    <>
      {/* The description slot is reserved here; the editable overlay
          renders on top of it as a SIBLING so the card link and the
          editor's controls never nest. The tags editor stacks below it
          in the same overlay. */}
      <div className="mt-1 h-10" aria-hidden />
      <div className="h-5" aria-hidden />
      <div className="h-5" aria-hidden />
    </>
  );

  const overlay = board ? (
    <div className="absolute inset-x-3 top-10">
      <ProjectCardTags projectId={p.id} initialTags={p.tags ?? ""} />
      <ProjectCardStatus
        projectId={p.id}
        initialStatus={p.status ?? ""}
        refreshAfterSave
      />
    </div>
  ) : (
    <div className="absolute inset-x-4 top-10">
      <ProjectCardDescription
        projectId={p.id}
        initialDescription={p.description}
      />
      <ProjectCardTags projectId={p.id} initialTags={p.tags ?? ""} />
      <ProjectCardStatus projectId={p.id} initialStatus={p.status ?? ""} />
    </div>
  );

  return (
    <li className="relative">
      <Link
        href={`/app/${p.id}`}
        className={`block rounded-xl border border-neutral-800 transition hover:border-neutral-600 hover:bg-neutral-900 ${
          board ? "p-3 pb-8" : "p-4 pb-10"
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="font-medium text-white">{p.name}</div>
          {published && (
            <span className="flex items-center gap-1 rounded-md bg-emerald-950 px-1.5 py-0.5 text-[10px] text-emerald-400">
              <span className="h-1 w-1 rounded-full bg-emerald-400" />
              public
            </span>
          )}
        </div>
        {slots}
        {!board && (
          <>
            <div className="mt-2 text-xs text-neutral-600">
              Updated{" "}
              {new Date(p.updatedAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </div>
            {(() => {
              const health = getGenerationHealth(p.id);
              if (!modelId || !health) return null;
              const pct = Math.round(health.successRate * 100);
              return (
                <div
                  className="mt-1.5 flex items-center gap-1.5 text-[11px] text-neutral-500"
                  data-testid="generation-health"
                >
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      pct >= 80
                        ? "bg-emerald-400"
                        : pct >= 50
                          ? "bg-amber-400"
                          : "bg-red-400"
                    }`}
                    aria-hidden
                  />
                  <span
                    title={`${health.turns} generation turn(s), ${health.degenerateTurns} unrecoverable`}
                  >
                    <span className="font-mono text-neutral-400">
                      {modelId}
                    </span>
                    {" · "}
                    {pct}% ok · {health.avgRetries.toFixed(1)} retries/turn
                  </span>
                </div>
              );
            })()}
          </>
        )}
      </Link>
      {overlay}
    </li>
  );
}
