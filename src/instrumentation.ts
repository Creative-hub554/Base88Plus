/**
 * Next.js instrumentation hook: runs once per server process start, after
 * the runtime is initialized — the right place for the one-time background
 * template-cache warmup. Not called during `next build`'s page-data
 * collection phase (guarding on NEXT_PHASE for safety regardless), and not
 * in the edge runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  // Fire-and-forget: a slow provider must never delay server readiness.
  const { warmTemplateCache } = await import("@/lib/template-generation");
  void warmTemplateCache().catch((err) =>
    console.error("[templates] warmup crashed:", err),
  );
}
