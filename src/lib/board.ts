import type { Project } from "./types";
import { NO_STATUS_LABEL, PROJECT_STATUSES, type ProjectStatus } from "./status";

/**
 * The dashboard board view's grouping — client-safe and pure so the page
 * and the tests share one definition of what a column IS.
 *
 * Kept out of lib/status.ts on purpose: status.ts describes and matches
 * the enum (and must stay import-free — types.ts imports ProjectStatus
 * from it), while grouping consumes full Project records.
 */

/** One board column: a status bucket, or the trailing unstatused one. */
export interface BoardColumn {
  /** undefined for the trailing "No status" column. */
  status: ProjectStatus | undefined;
  label: string;
  projects: Project[];
}

/**
 * Group projects into board columns: the three enum buckets are ALWAYS
 * present in enum order (an empty column is information — "nothing is
 * building"), and unstatused projects get a trailing "No status" bucket
 * only when non-empty (hiding them would lie about the board).
 *
 * Grouping keys on the stored enum value itself — the store is the only
 * writer and enum-validates, so no re-validation happens here. Each
 * project lands in exactly one bucket, preserving input order.
 */
export function groupByStatus(projects: Project[]): BoardColumn[] {
  const buckets = new Map<ProjectStatus, Project[]>(
    PROJECT_STATUSES.map((s) => [s, []]),
  );
  const unstatused: Project[] = [];
  for (const p of projects) {
    const bucket = p.status ? buckets.get(p.status) : undefined;
    if (bucket) bucket.push(p);
    else unstatused.push(p);
  }
  const columns: BoardColumn[] = PROJECT_STATUSES.map((status) => ({
    status,
    label: status,
    projects: buckets.get(status) as Project[],
  }));
  if (unstatused.length > 0) {
    columns.push({
      status: undefined,
      label: NO_STATUS_LABEL,
      projects: unstatused,
    });
  }
  return columns;
}
