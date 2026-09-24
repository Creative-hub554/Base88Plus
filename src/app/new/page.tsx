"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { choose, ToastHost } from "../../components/toast";

interface TemplateStatus {
  id: string;
  name: string;
  tagline: string;
  gradient: string;
  ready: boolean;
  generating: boolean;
  stale: boolean;
  files: string[];
  generatedAt?: string;
}

interface TemplateDef {
  id: string;
  name: string;
  tagline: string;
  appName: string;
  brief: string;
  gradient: string;
}

/**
 * Client copy of the template catalog (src/lib/templates.ts). Briefs must
 * stay byte-identical to the server's — they are the cache key.
 */
const TEMPLATES: TemplateDef[] = [
  {
    id: "landing",
    name: "Product landing page",
    tagline: "Hero, features, social proof, pricing teaser, CTA footer",
    appName: "Landing Page",
    brief:
      "A premium product landing page for a modern SaaS tool. Above the fold: bold headline, subheadline, primary CTA button and a hero visual (CSS/SVG illustration, no external images). Sections: logo strip, 6 feature cards in a responsive grid, a stats band, one testimonial, pricing teaser with 3 tiers, FAQ, and a final CTA footer. Sticky glassy navbar with smooth-scroll anchor links; footer with columns and copyright.",
    gradient: "from-indigo-500 via-purple-500 to-pink-500",
  },
  {
    id: "portfolio",
    name: "Portfolio",
    tagline: "Case-study grid, about section, contact links",
    appName: "Portfolio",
    brief:
      "A personal portfolio site for a designer/developer. Hero with name, role and short bio; a filterable project grid (6+ case-study cards with CSS-drawn thumbnails and hover lift); an about section with skills; a contact section with email and social links. Elegant, typography-led, generous whitespace.",
    gradient: "from-amber-400 via-orange-500 to-rose-500",
  },
  {
    id: "restaurant",
    name: "Restaurant",
    tagline: "Menu, hours, reservation form, map placeholder",
    appName: "Restaurant Site",
    brief:
      "A restaurant website: warm, appetite-driven design. Hero with restaurant name and reservation CTA; an interactive menu (tabbed categories, items with prices); opening hours; a reservation form with validation and success state (localStorage-backed); a location section with a stylized CSS map placeholder; footer with contact info.",
    gradient: "from-emerald-500 via-teal-500 to-cyan-500",
  },
  {
    id: "saas",
    name: "SaaS site",
    tagline: "Features, integrations, pricing table, multiple pages",
    appName: "SaaS Site",
    brief:
      "A multi-page SaaS marketing site: index.html (hero, feature grid, integrations logos, pricing table with monthly/yearly toggle), pricing.html (detailed comparison table), about.html (team, story), contact.html (form with validation). Shared navbar and footer across all pages; consistent design system; responsive at 390px/768px.",
    gradient: "from-sky-500 via-blue-600 to-indigo-600",
  },
  {
    id: "event",
    name: "Event page",
    tagline: "Schedule, speakers, tickets with countdown",
    appName: "Event Site",
    brief:
      "A conference/event site: bold hero with date, venue and a live countdown timer; schedule with day tabs; speaker grid with CSS-drawn avatars; ticket tiers with a working registration form (localStorage, success + validation states); FAQ accordion; footer with sponsors row.",
    gradient: "from-fuchsia-500 via-rose-500 to-orange-400",
  },
  {
    id: "blog",
    name: "Blog",
    tagline: "Post grid, single-post view, categories, newsletter",
    appName: "Blog",
    brief:
      "A clean multi-page blog: index.html with a featured post and a post grid; post.html reading a shared posts.js data file and rendering the selected post; about page; newsletter signup with validation. Category filtering, reading-time labels, and a typographic, readable layout.",
    gradient: "from-lime-400 via-green-500 to-emerald-600",
  },
];

const BLANK_IDEAS = [
  "A pomodoro timer with task list and daily streaks",
  "A personal expense tracker with monthly charts",
  "A kanban board with drag-and-drop and localStorage persistence",
  "A markdown notes app with search and tags",
  "A habit tracker with weekly heatmap",
];

export default function NewAppPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<TemplateStatus[] | null>(null);
  const [providerReady, setProviderReady] = useState(true);
  const [warming, setWarming] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [regenAll, setRegenAll] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/templates");
      const data = await res.json();
      setStatus(data.templates);
      setProviderReady(data.configured !== false);
      setWarming(data.warming === true);
    } catch {
      // gallery still usable without status
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // While the server's startup warm pass, a regenerate-all pass, or any
  // single generation is running, poll until everything settles — cards
  // fill in live as demos land.
  useEffect(() => {
    const busy = warming || regenAll || (status?.some((t) => t.generating) ?? false);
    if (busy && !pollRef.current) {
      pollRef.current = setInterval(refresh, 2500);
    }
    if (!busy && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (
        pollRef.current &&
        !warming &&
        !regenAll &&
        !status?.some((t) => t.generating)
      ) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [status, warming, regenAll, refresh]);

  // The warming flag turning off means any server-side pass just finished;
  // if it was a regenerate-all, clear its button state.
  useEffect(() => {
    if (!warming && regenAll) setRegenAll(false);
  }, [warming, regenAll]);

  async function generate(id: string) {
    setTemplateError(null);
    // Optimistic: flip the card into "generating" immediately.
    setStatus((prev) =>
      prev ? prev.map((t) => (t.id === id ? { ...t, generating: true } : t)) : prev,
    );
    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTemplateError(data.error ?? "Generation failed");
      }
    } catch {
      setTemplateError("Generation request failed");
    } finally {
      refresh();
    }
  }

  /**
   * Promote the cached demo into a real project: files are copied verbatim
   * (no regeneration), the chat is seeded with provenance, and the builder
   * opens immediately.
   */
  async function regenerateAll() {
    const go = await choose(
      "Regenerate every template demo with the active model?\n\nCached previews will be replaced as they finish.",
      [
        { value: "confirm", label: "Regenerate all", primary: true },
        { value: "cancel", label: "Cancel" },
      ],
    );
    if (go !== "confirm") return;
    setTemplateError(null);
    setRegenAll(true);
    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTemplateError(data.error ?? "Could not start regeneration");
        setRegenAll(false);
      }
    } catch {
      setTemplateError("Could not start regeneration");
      setRegenAll(false);
    }
  }

  async function promote(id: string) {
    setTemplateError(null);
    setPromoting(id);
    try {
      const res = await fetch(`/api/templates/${id}/promote`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setTemplateError(data.error ?? "Could not create the app");
        return;
      }
      router.push(`/app/${data.project.id}`);
    } catch {
      setTemplateError("Could not create the app");
    } finally {
      setPromoting(null);
    }
  }

  async function create(finalName: string, finalDescription: string) {
    setCreating(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: finalName, description: finalDescription }),
      });
      const data = await res.json();
      router.push(`/app/${data.project.id}`);
    } finally {
      setCreating(false);
    }
  }

  function applyTemplate(t: TemplateDef) {
    setSelected(t.id);
    setName(t.appName);
    setDescription(t.brief);
  }

  function startBlank() {
    setSelected(null);
    setName("");
    setDescription("");
  }

  return (
    <>
      <ToastHost />
      <main className="mx-auto max-w-5xl px-6 py-16">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Create a new app</h1>
          <p className="mt-2 text-sm text-neutral-400">
            Start from a template — every field is editable — or describe
            anything from scratch.
          </p>
        </div>
        <button
          type="button"
          onClick={regenerateAll}
          disabled={
            regenAll || warming || !providerReady || promoting !== null
          }
          title={
            providerReady
              ? "Regenerate every template demo with the active model"
              : "No AI provider configured — open Settings"
          }
          className="shrink-0 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40"
        >
          {regenAll || warming ? "Regenerating…" : "Regenerate all"}
        </button>
      </div>      {templateError && (
          <p className="mt-4 rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-300">
            {templateError}
          </p>
        )}

        {warming && (
          <p className="mt-4 flex items-center gap-2 rounded-lg border border-indigo-900/60 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-300">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400" />
            {regenAll
              ? "Regenerating every template demo — cards will update as each finishes."
              : "Generating template previews in the background — cards will fill in automatically."}
          </p>
        )}

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(status ?? TEMPLATES.map((t) => ({
          id: t.id,
          name: t.name,
          tagline: t.tagline,
          gradient: t.gradient,
          ready: false,
          generating: false,
          stale: false,
          files: [],
        }))).map((t) => (
          <TemplateCard
            key={t.id}
            status={t}
            selected={selected === t.id}
            providerReady={providerReady}
            promoting={promoting === t.id}
            onSelect={() => {
              const def = TEMPLATES.find((d) => d.id === t.id);
              if (def) applyTemplate(def);
            }}
            onGenerate={() => generate(t.id)}
            onPromote={() => promote(t.id)}
          />
        ))}
        <button
          type="button"
          onClick={startBlank}
          className={`rounded-xl border border-dashed p-4 text-left transition ${
            selected === null
              ? "border-white/60 bg-neutral-900"
              : "border-neutral-700 hover:border-neutral-500"
          }`}
        >
          <div className="flex h-40 w-full items-center justify-center rounded-lg border border-neutral-700 text-2xl text-neutral-500">
            ✦
          </div>
          <div className="mt-3 font-medium text-white">Start from blank</div>
          <div className="mt-1 text-xs leading-relaxed text-neutral-400">
            Describe anything — tools, games, dashboards.
          </div>
        </button>
      </div>

      <form
        className="mt-10 space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!description.trim() || creating) return;
          create(name.trim() || "Untitled app", description.trim());
        }}
      >
        <div>
          <label className="mb-1.5 block text-sm font-medium text-neutral-300">
            App name (optional)
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Habit Tracker"
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3.5 py-2.5 text-sm outline-none placeholder:text-neutral-600 focus:border-neutral-600"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-neutral-300">
            Brief
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={7}
            placeholder="Describe the app you want to build…"
            className="w-full resize-none rounded-lg border border-neutral-800 bg-neutral-900 px-3.5 py-2.5 text-sm outline-none placeholder:text-neutral-600 focus:border-neutral-600"
          />
          {selected === null && (
            <div className="mt-2 flex flex-wrap gap-2">
              {BLANK_IDEAS.map((idea) => (
                <button
                  key={idea}
                  type="button"
                  onClick={() => setDescription(idea)}
                  className="rounded-full border border-neutral-800 px-3 py-1 text-xs text-neutral-400 transition hover:bg-neutral-900"
                >
                  {idea}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="submit"
          disabled={!description.trim() || creating}
          className="rounded-lg bg-white px-5 py-2.5 text-sm font-medium text-neutral-900 transition hover:bg-neutral-200 disabled:opacity-40"
        >
          {creating ? "Creating…" : "Create app"}
        </button>
      </form>
    </main>
    </>
  );
}

/**
 * Template card. The visual is a live, scaled-down iframe of the generated
 * demo (non-interactive), cached server-side; a gradient placeholder shows
 * until the template has been generated at least once.
 */
function TemplateCard({
  status,
  selected,
  providerReady,
  promoting,
  onSelect,
  onGenerate,
  onPromote,
}: {
  status: TemplateStatus;
  selected: boolean;
  providerReady: boolean;
  promoting: boolean;
  onSelect: () => void;
  onGenerate: () => void;
  onPromote: () => void;
}) {
  // 1440px-wide demo scaled to fit the ~280px card ⇒ scale ≈ 0.19.
  const SCALE = 0.19;
  const CONTAINER = 160; // h-40 visual height
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [pageHeight, setPageHeight] = useState<number | null>(null);
  const thumbUrl = status.ready
    ? `/api/templates/${status.id}/index.html?v=${encodeURIComponent(
        status.generatedAt ?? "",
      )}`
    : null;

  /**
   * Measure the demo's real height once its document loads so the hover pan
   * can scroll exactly to the bottom of the page. Falls back to a fixed
   * depth when measurement isn't possible. (The thumbnail route is served
   * same-origin, and the iframe sandbox includes allow-same-origin for the
   * generated demo's own localStorage to work at all.)
   */
  function measure() {
    const frame = frameRef.current;
    if (!frame) return;
    try {
      const doc = frame.contentDocument;
      if (!doc) return;
      // Collapse the frame first: an iframe's scrollHeight can never be
      // smaller than its own viewport (element height), so measuring with
      // the fallback height in place would clamp short pages to it.
      frame.style.height = "10px";
      const h =
        doc.documentElement?.scrollHeight ?? doc.body?.scrollHeight ?? 0;
      if (h > 200) setPageHeight(h);
    } catch {
      // keep fallback
    }
  }

  // How far the pan travels, in unscaled iframe px: from the top of the
  // page to its bottom (clamped so short pages don't scroll past their end).
  const depth = pageHeight
    ? Math.max(0, Math.min(pageHeight - 520, pageHeight - CONTAINER / SCALE))
    : 680; // sensible default for a typical landing page
  // Speed scales with depth: ~280px/s, clamped to a pleasant range.
  const panDuration = Math.min(14, Math.max(3, depth / 280));

  return (
    <div
      className={`group rounded-xl border p-4 text-left transition ${
        selected
          ? "border-white/60 bg-neutral-900"
          : "border-neutral-800 bg-neutral-900/40 hover:border-neutral-600 hover:bg-neutral-900"
      }`}
    >
      <div
        className="relative h-40 w-full overflow-hidden rounded-lg"
        style={
          status.ready
            ? undefined
            : {
                background:
                  "linear-gradient(135deg, var(--tw-gradient-stops))",
              }
        }
      >
        {status.ready && thumbUrl ? (
          <div
            className="thumb-pan absolute left-0 top-0 w-[1440px]"
            style={
              {
                "--pan": `-${depth}px`,
                "--pan-duration": `${panDuration}s`,
              } as React.CSSProperties
            }
          >
            <iframe
              ref={frameRef}
              src={thumbUrl}
              title={`${status.name} preview`}
              loading="lazy"
              sandbox="allow-scripts allow-same-origin"
              tabIndex={-1}
              onLoad={measure}
              className="pointer-events-none absolute left-0 top-0 w-[1440px] origin-top-left border-0 bg-white"
              style={{
                height: pageHeight ? `${pageHeight}px` : "1600px",
                transform: `scale(${SCALE})`,
              }}
            />
          </div>
        ) : (
          <div
            className={`flex h-full w-full items-center justify-center rounded-lg bg-gradient-to-br ${status.gradient} ${
              status.stale ? "opacity-40" : ""
            }`}
          >
            {status.generating && (
              <span className="animate-pulse rounded-full bg-black/50 px-3 py-1 text-xs text-white">
                generating…
              </span>
            )}
            {status.stale && !status.generating && (
              <span className="rounded-full bg-black/50 px-3 py-1 text-xs text-white">
                outdated — regenerate?
              </span>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onSelect}
        className="mt-3 block w-full text-left"
      >
        <div className="font-medium text-white">{status.name}</div>
        <div className="mt-1 text-xs leading-relaxed text-neutral-400">
          {status.tagline}
        </div>
      </button>

      {status.ready ? (
        <button
          type="button"
          onClick={onPromote}
          disabled={promoting}
          className="mt-2.5 w-full rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-neutral-900 transition hover:bg-neutral-200 disabled:opacity-40"
        >
          {promoting ? "Creating app…" : "Use this template"}
        </button>
      ) : (
        <button
          type="button"
          onClick={onGenerate}
          disabled={status.generating || !providerReady}
          title={
            providerReady
              ? "Generate a live demo for this template"
              : "No AI provider configured — open Settings"
          }
          className="mt-2.5 w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40"
        >
          {status.generating
            ? "Generating…"
            : status.stale
              ? "Regenerate preview"
              : "Generate preview"}
        </button>
      )}
    </div>
  );
}
