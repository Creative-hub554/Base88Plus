"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface ProviderHealth {
  id: string;
  name: string;
  configured: boolean;
  reachable: boolean | null;
  defaultModel: string;
  activeModel?: string;
  kind: string;
  baseURL: string;
}

interface ProjectModelInfo {
  projectId: string;
  projectName: string;
  updatedAt: string;
  source: "project" | "global";
  providerId: string;
  providerName: string;
  modelId: string;
  pinBroken: boolean;
}

interface HealthData {
  providers: ProviderHealth[];
  projects: ProjectModelInfo[];
}

function StatusDot({ state }: { state: "ok" | "down" | "unknown" }) {
  const cls =
    state === "ok"
      ? "bg-emerald-400"
      : state === "down"
        ? "bg-red-500"
        : "bg-neutral-600";
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${cls}`} />;
}

function statusLabel(p: ProviderHealth): {
  state: "ok" | "down" | "unknown";
  text: string;
} {
  if (!p.configured) return { state: "unknown", text: "not configured" };
  if (p.reachable === null) return { state: "unknown", text: "not probed" };
  return p.reachable
    ? { state: "ok", text: "reachable" }
    : { state: "down", text: "unreachable" };
}

export default function ProvidersPage() {
  const [data, setData] = useState<HealthData | null>(null);
  const [probing, setProbing] = useState(false);
  const [probedAt, setProbedAt] = useState<number | null>(null);

  const load = useCallback(async (probe: boolean) => {
    setProbing(true);
    try {
      const res = await fetch(`/api/providers/health${probe ? "?probe=1" : ""}`);
      const json = (await res.json()) as HealthData;
      setData(json);
      setProbedAt(Date.now());
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const configuredCount =
    data?.providers.filter((p) => p.configured).length ?? 0;
  const reachableCount =
    data?.providers.filter((p) => p.configured && p.reachable).length ?? 0;
  const pinnedCount =
    data?.projects.filter((p) => p.source === "project").length ?? 0;

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <div className="mb-8">
        <a href="/" className="text-sm text-neutral-500 hover:text-white">
          ← Back to apps
        </a>
      </div>

      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">
            Providers health
          </h1>
          <p className="mt-1 text-sm text-neutral-400">
            {configuredCount} configured · {reachableCount} reachable ·{" "}
            {pinnedCount} project{pinnedCount === 1 ? "" : "s"} pinned
            {probedAt ? ` · checked ${new Date(probedAt).toLocaleTimeString()}` : ""}
          </p>
        </div>
        <button
          onClick={() => void load(true)}
          disabled={probing}
          className="rounded-lg border border-neutral-800 px-4 py-2 text-sm text-neutral-300 transition hover:bg-neutral-900 disabled:opacity-40"
        >
          {probing ? "Checking…" : "Re-check now"}
        </button>
      </header>

      {!data ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-10 text-center text-neutral-500">
          Checking providers…
        </div>
      ) : (
        <div className="space-y-8">
          {/* ------------------------------ providers */}
          <section>
            <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-500">
              Providers
            </h2>
            <div className="space-y-2">
              {data.providers.map((p) => {
                const status = statusLabel(p);
                const isActive = Boolean(p.activeModel);
                return (
                  <div
                    key={p.id}
                    className={`rounded-xl border p-4 ${
                      isActive
                        ? "border-neutral-600 bg-neutral-900/60"
                        : "border-neutral-800 bg-neutral-950/40"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusDot state={status.state} />
                      <span className="font-medium text-white">{p.name}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          p.configured
                            ? "bg-emerald-950 text-emerald-400"
                            : "bg-neutral-800 text-neutral-500"
                        }`}
                      >
                        {p.configured ? "configured" : "needs key"}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          status.state === "ok"
                            ? "bg-emerald-950 text-emerald-400"
                            : status.state === "down"
                              ? "bg-red-950 text-red-400"
                              : "bg-neutral-800 text-neutral-500"
                        }`}
                      >
                        {status.text}
                      </span>
                      {isActive && (
                        <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-medium text-neutral-900">
                          active
                        </span>
                      )}
                      <span className="ml-auto font-mono text-[11px] text-neutral-600">
                        {p.id}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-neutral-500">
                      Model:{" "}
                      <span className="font-mono text-neutral-300">
                        {p.activeModel || p.defaultModel}
                      </span>
                      {p.activeModel && (
                        <span className="ml-1 text-neutral-500">
                          (global default)
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-neutral-600">
                      {p.baseURL}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ------------------------------ projects */}
          <section>
            <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-500">
              Models by project
            </h2>
            {data.projects.length === 0 ? (
              <div className="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
                No apps yet — create one from the{" "}
                <Link href="/new" className="text-neutral-300 underline">
                  template gallery
                </Link>
                .
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-neutral-800">
                <table className="w-full text-sm">
                  <tbody>
                    {data.projects.map((pj) => (
                      <tr
                        key={pj.projectId}
                        className="border-b border-neutral-800/60 last:border-0"
                      >
                        <td className="px-4 py-3">
                          <Link
                            href={`/app/${pj.projectId}`}
                            className="font-medium text-white hover:underline"
                          >
                            {pj.projectName}
                          </Link>
                          <div className="text-xs text-neutral-600">
                            Updated{" "}
                            {new Date(pj.updatedAt).toLocaleString(undefined, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span
                            className={`mr-2 rounded px-1.5 py-0.5 text-[10px] ${
                              pj.source === "project"
                                ? "bg-indigo-950 text-indigo-300"
                                : "bg-neutral-800 text-neutral-400"
                            }`}
                          >
                            {pj.source === "project" ? "pinned" : "global"}
                          </span>
                          <span className="text-neutral-300">
                            {pj.providerName}
                          </span>
                          <span className="ml-2 font-mono text-xs text-neutral-400">
                            {pj.modelId}
                          </span>
                          {pj.pinBroken && (
                            <span className="ml-2 rounded bg-red-950 px-1.5 py-0.5 text-[10px] text-red-400">
                              pin unusable — falling back
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
