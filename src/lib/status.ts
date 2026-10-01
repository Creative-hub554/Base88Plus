/**
 * Project status — the enum metadata field (idea / building / shipped),
 * the fourth inline metadata surface (docs/playbooks.md recipe 7).
 *
 * Client-safe (no node imports): the store validator, the meta route,
 * the dashboard's server-side `?status=` filter, and the client card
 * shell all read from this one definition. `setProjectMeta` is the only
 * WRITER — everything here just describes and matches the enum.
 */

export const PROJECT_STATUSES = ["idea", "building", "shipped"] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Narrow an unknown wire value to a ProjectStatus. */
export function isProjectStatus(value: unknown): value is ProjectStatus {
  return (
    typeof value === "string" &&
    (PROJECT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Case-insensitive exact match for the dashboard's `?status=` filter —
 * same forgiveness contract as the tag filter (pill clicks pass the
 * stored value verbatim; hand-typed URLs get the lowercase compare).
 */
export function statusMatches(
  raw: string | undefined | null,
  status: string,
): boolean {
  const needle = status.trim().toLowerCase();
  if (!needle) return false;
  return typeof raw === "string" && raw.trim().toLowerCase() === needle;
}

/**
 * Dot color per status — shared by the card badge and the board column
 * headers so a status looks the same everywhere.
 */
export const STATUS_DOT: Record<ProjectStatus, string> = {
  idea: "bg-neutral-500",
  building: "bg-amber-400",
  shipped: "bg-emerald-400",
};
