/**
 * Client-safe tag helpers — no node imports, so the server-rendered
 * dashboard AND the "use client" card editor share one definition.
 *
 * Tags are ONE comma-separated string on the Project record; the store's
 * `setProjectMeta` is what BUILDS that string (per-tag trim, empties
 * dropped, ", " join). These helpers only READ it — never re-normalize
 * or rewrite here.
 */

/** Split the stored tags string into its non-empty, trimmed pieces. */
export function splitTags(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Case-insensitive exact-tag match. Used by the dashboard's `?tag=` filter:
 * pill clicks pass the stored tag verbatim, but hand-typed URLs get the
 * forgiving comparison for free.
 */
export function projectMatchesTag(
  raw: string | undefined | null,
  tag: string,
): boolean {
  const needle = tag.trim().toLowerCase();
  if (!needle) return false;
  return splitTags(raw).some((t) => t.toLowerCase() === needle);
}
