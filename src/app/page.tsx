import Link from "next/link";
import { getProjectModelInfo } from "@/lib/providers/gateway";
import {
  getGenerationHealth,
  getPublishManifest,
  listProjects,
} from "@/lib/store";
import { ImportZipButton } from "@/components/import-button";
import { ProjectCardDescription } from "@/components/project-card-description";
import { ProjectCardTags } from "@/components/project-card-tags";
import { ProjectCardStatus } from "@/components/project-card-status";
import { ToastHost } from "@/components/toast";
import { projectMatchesTag } from "@/lib/tags";
import { statusMatches } from "@/lib/status";

export const dynamic = "force-dynamic";

/**
 * The dashboard doubles as the metadata filter: `/?tag=<tag>` and
 * `/?status=<status>` narrow the grid server-side (case-insensitive
 * exact matches, ANDed when both are present), so a pill/badge click on
 * any card is a deep-linkable filter and the back button undoes it. No
 * client state — the URL IS the state.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{
    tag?: string | string[];
    status?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const rawTag = params.tag;
  const activeTag = (Array.isArray(rawTag) ? rawTag[0] : rawTag)?.trim() ?? "";
  const rawStatus = params.status;
  const activeStatus =
    (Array.isArray(rawStatus) ? rawStatus[0] : rawStatus)?.trim() ?? "";
  const allProjects = listProjects();
  const projects = allProjects.filter(
    (p) =>
      (!activeTag || projectMatchesTag(p.tags, activeTag)) &&
      (!activeStatus || statusMatches(p.status, activeStatus)),
  );
  const hasFilter = Boolean(activeTag || activeStatus);
  const publishedSlugs = new Map(
    projects
      .map((p) => [p.id, getPublishManifest(p.id)?.slug] as const)
      .filter(([, slug]) => Boolean(slug)),
  );
  // Effective model per project (pin or global default) comes from the
  // gateway's own resolver — never re-derived here.
  const modelByProject = new Map(
    getProjectModelInfo().map((pj) => [pj.projectId, pj] as const),
  );

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
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-neutral-500">
          Your apps
        </h2>
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
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {projects.map((p) => (
              <li key={p.id} className="relative">
                <Link
                  href={`/app/${p.id}`}
                  className="block rounded-xl border border-neutral-800 p-4 pb-10 transition hover:border-neutral-600 hover:bg-neutral-900"
                >
                  <div className="flex items-center justify-between">
                    <div className="font-medium text-white">{p.name}</div>
                    {publishedSlugs.get(p.id) && (
                      <span className="flex items-center gap-1 rounded-md bg-emerald-950 px-1.5 py-0.5 text-[10px] text-emerald-400">
                        <span className="h-1 w-1 rounded-full bg-emerald-400" />
                        public
                      </span>
                    )}
                  </div>
                  {/* The description slot is reserved here; the editable
                      overlay renders on top of it as a SIBLING so the card
                      link and the editor's controls never nest. The tags
                      editor stacks below it in the same overlay. */}
                  <div className="mt-1 h-10" aria-hidden />
                  <div className="h-5" aria-hidden />
                  <div className="h-5" aria-hidden />
                  <div className="mt-2 text-xs text-neutral-600">
                    Updated{" "}
                    {new Date(p.updatedAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </div>
                  {(() => {
                    const model = modelByProject.get(p.id);
                    const health = getGenerationHealth(p.id);
                    if (!model || !health) return null;
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
                        <span title={`${health.turns} generation turn(s), ${health.degenerateTurns} unrecoverable`}>
                          <span className="font-mono text-neutral-400">{model.modelId}</span>
                          {" · "}
                          {pct}% ok · {health.avgRetries.toFixed(1)} retries/turn
                        </span>
                      </div>
                   );
                  })()}
                </Link>
                <div className="absolute inset-x-4 top-10">
                  <ProjectCardDescription
                    projectId={p.id}
                    initialDescription={p.description}
                  />
                  <ProjectCardTags projectId={p.id} initialTags={p.tags ?? ""} />
                  <ProjectCardStatus projectId={p.id} initialStatus={p.status ?? ""} />
                </div>
              </li>
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
