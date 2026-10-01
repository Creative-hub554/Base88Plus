import Link from "next/link";
import { getProjectModelInfo } from "@/lib/providers/gateway";
import {
  getPublishManifest,
  listProjects,
} from "@/lib/store";
import { ImportZipButton } from "@/components/import-button";
import { ProjectCard } from "@/components/project-card";
import { ToastHost } from "@/components/toast";
import { projectMatchesTag } from "@/lib/tags";
import type { Project } from "@/lib/types";
import {
  PROJECT_STATUSES,
  STATUS_DOT,
  isProjectStatus,
  statusMatches,
  type ProjectStatus,
} from "@/lib/status";

export const dynamic = "force-dynamic";

/**
 * The dashboard doubles as the metadata filter: `/?tag=<tag>` and
 * `/?status=<status>` narrow the view server-side (case-insensitive
 * exact matches, ANDed when both are present), so a pill/badge click on
 * any card is a deep-linkable filter and the back button undoes it. No
 * client state — the URL IS the state.
 *
 * `/?view=board` swaps the grid for a three-column status board
 * (idea / building / shipped). It is a VIEW over the same filtered
 * project set — tag and status filters apply identically in both views.
 * Projects without a status land in a trailing "No status" column rather
 * than vanishing (the board answers "what's where"; hiding projects
 * would lie). A status edit on a board card soft-refreshes the page so
 * the card re-sorts into its new column.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{
    tag?: string | string[];
    status?: string | string[];
    view?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const rawTag = params.tag;
  const activeTag = (Array.isArray(rawTag) ? rawTag[0] : rawTag)?.trim() ?? "";
  const rawStatus = params.status;
  const activeStatus =
    (Array.isArray(rawStatus) ? rawStatus[0] : rawStatus)?.trim() ?? "";
  const rawView = params.view;
  const activeView =
    (Array.isArray(rawView) ? rawView[0] : rawView)?.trim() ?? "";
  // Anything that is not exactly "board" renders the default grid, so
  // hand-typed junk URLs can never produce a half-initialized layout.
  const boardView = activeView === "board";
  const allProjects = listProjects();
  const projects = allProjects.filter(
    (p) =>
      (!activeTag || projectMatchesTag(p.tags, activeTag)) &&
      (!activeStatus || statusMatches(p.status, activeStatus)),
  );
  const hasFilter = Boolean(activeTag || activeStatus);

  // Effective model per project (pin or global default) comes from the
  // gateway's own resolver — never re-derived here. Only the grid's
  // generation-health line consumes it.
  const modelByProject = new Map(
    getProjectModelInfo().map((pj) => [pj.projectId, pj] as const),
  );

  // Board grouping: the three enum columns are always present (an empty
  // column is information — "nothing is building"), and unstatused
  // projects get a trailing "No status" column only when one exists.
  const boardColumns: {
    status: ProjectStatus | undefined;
    label: string;
    projects: Project[];
  }[] = PROJECT_STATUSES.map((status) => ({
    status,
    label: status,
    projects: projects.filter((p) => statusMatches(p.status, status)),
  }));
  const unstatused = projects.filter(
    (p) => !(p.status && isProjectStatus(p.status)),
  );
  if (unstatused.length > 0) {
    boardColumns.push({
      status: undefined,
      label: "No status",
      projects: unstatused,
    });
  }

  // The toggle preserves an active filter (board + ?tag= is a valid deep
  // link). The grid link stays plain "/" when unfiltered so it doubles
  // as the filter-clear; the board link always carries view=board.
  const filterQs = [
    activeTag && `tag=${encodeURIComponent(activeTag)}`,
    activeStatus && `status=${encodeURIComponent(activeStatus)}`,
  ]
    .filter(Boolean)
    .join("&");
  const gridHref = filterQs ? `/?${filterQs}` : "/";
  const boardHref = filterQs ? `/?${filterQs}&view=board` : "/?view=board";

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <header className="mb-14">
        <div className="mb-3 flex items-center gap-2 text-sm text-neutral-500">
          <span className="rounded-md bg-neutral-800 px-2 py-0.5 font-mono text-xs">
            anybase
          </span>
          <span>AI app builder · works with every model</span>
        </div>
        <h1 className="text-4xl font-semibold tracking-tight text-white">
          Describe an app. Get a working app.
        </h1>
        <p className="mt-3 max-w-2xl text-neutral-400">
          Anybase turns chat into full web apps and streams the result into a
          live preview. Bring your own key from any provider — OpenAI,
          Anthropic, Google, Groq, Mistral, DeepSeek, OpenRouter, Together,
          Fireworks, xAI, or a fully local model via Ollama / LM Studio / vLLM.
        </p>
      </header>

      <section className="mb-10 flex flex-wrap items-center gap-3">
        <Link
          href="/new"
          className="rounded-lg bg-white px-5 py-2.5 text-sm font-medium text-neutral-900 transition hover:bg-neutral-200"
        >
          + New app
        </Link>
        <Link
          href="/providers"
          className="rounded-lg border border-neutral-800 px-5 py-2.5 text-sm text-neutral-300 transition hover:bg-neutral-900"
        >
          Providers health
        </Link>
        <Link
          href="/settings"
          className="rounded-lg border border-neutral-800 px-5 py-2.5 text-sm text-neutral-300 transition hover:bg-neutral-900"
        >
          Settings → AI Providers
        </Link>
        <ImportZipButton />
      </section>

      <section>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
            Your apps
          </h2>
          <div
            className="flex items-center gap-1 rounded-lg border border-neutral-800 p-0.5"
            data-testid="view-toggle"
          >
            <Link
              href={gridHref}
              data-testid="view-grid-link"
              aria-current={boardView ? undefined : "page"}
              className={`rounded-md px-2.5 py-1 text-xs transition ${
                boardView
                  ? "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                  : "bg-neutral-800 text-white"
              }`}
            >
              Grid
            </Link>
            <Link
              href={boardHref}
              data-testid="view-board-link"
              aria-current={boardView ? "page" : undefined}
              className={`rounded-md px-2.5 py-1 text-xs transition ${
                boardView
                  ? "bg-neutral-800 text-white"
                  : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
              }`}
            >
              Board
            </Link>
          </div>
        </div>
        {hasFilter && (
          <div
            className="mb-4 flex flex-wrap items-center gap-2 text-sm text-neutral-400"
            data-testid="tag-filter-bar"
          >
            <span>
              {projects.length} project{projects.length === 1 ? "" : "s"}
              {activeTag && (
                <>
                  {" "}tagged{" "}
                  <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-200">
                    {activeTag}
                  </span>
                </>
              )}
              {activeStatus && (
                <>
                  {" "}· status{" "}
                  <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-200">
                    {activeStatus}
                  </span>
                </>
              )}
            </span>
            <Link
              href="/"
              data-testid="tag-filter-clear"
              className="rounded border border-neutral-800 px-2 py-0.5 text-xs text-neutral-300 transition hover:bg-neutral-900"
            >
              Clear ✕
            </Link>
          </div>
        )}
        {hasFilter && projects.length === 0 ? (
          <div
            className="rounded-xl border border-dashed border-neutral-800 p-10 text-center text-neutral-500"
            data-testid="tag-filter-empty"
          >
            {activeTag && activeStatus
              ? "No projects match this filter."
              : activeStatus
                ? `No ${activeStatus} projects.`
                : `No projects tagged “${activeTag}”.`}{" "}
            <Link href="/" className="text-neutral-300 underline underline-offset-2">
              Show all apps
            </Link>
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-800 p-10 text-center text-neutral-500">
            No apps yet — create your first one and describe what you want to
            build.
          </div>
        ) : boardView ? (
          <div
            className="grid grid-cols-1 gap-4 sm:grid-cols-3"
            data-testid="board"
          >
            {boardColumns.map((col) => (
              <div
                key={col.label}
                className="min-w-0"
                data-testid={`board-column-${col.status ?? "none"}`}
              >
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
                  {col.status && (
                    <span
                      aria-hidden
                      className={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_DOT[col.status]}`}
                    />
                  )}
                  <span>
                    {col.label}{" "}
                    <span className="text-neutral-600">
                      ({col.projects.length})
                    </span>
                  </span>
                </div>
                <ul className="space-y-2">
                  {col.projects.map((p) => (
                    <ProjectCard
                      key={p.id}
                      project={p}
                      layout="board"
                      published={Boolean(getPublishManifest(p.id)?.slug)}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                published={Boolean(getPublishManifest(p.id)?.slug)}
                modelId={modelByProject.get(p.id)?.modelId}
              />
            ))}
          </ul>
        )}
      </section>
      {/* Dashboard-level host: the client components here (import, card
          editors) toast through the module bus. */}
      <ToastHost />
    </main>
  );
}
