import Link from "next/link";
import { getProjectModelInfo } from "@/lib/providers/gateway";
import {
  getGenerationHealth,
  getPublishManifest,
  listProjects,
} from "@/lib/store";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const projects = listProjects();
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
      </section>

      <section>
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-neutral-500">
          Your apps
        </h2>
        {projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-800 p-10 text-center text-neutral-500">
            No apps yet — create your first one and describe what you want to
            build.
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/app/${p.id}`}
                  className="block rounded-xl border border-neutral-800 p-4 transition hover:border-neutral-600 hover:bg-neutral-900"
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
                  <div className="mt-1 line-clamp-2 text-sm text-neutral-500">
                    {p.description || "No description"}
                  </div>
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
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
