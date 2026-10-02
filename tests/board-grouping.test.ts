/**
 * groupByStatus — the board view's pure grouping kernel. Pins the column
 * CONTRACT the dashboard renders: the three enum buckets always present
 * in enum order (an empty column is information), each project in exactly
 * one bucket with input order preserved, and the trailing "No status"
 * bucket only when non-empty. Grouping keys on the stored enum value —
 * no re-validation (the store is the only writer).
 */
import { describe, expect, it } from "vitest";
import { groupByStatus, type BoardColumn } from "../src/lib/board";
import { NO_STATUS_LABEL, PROJECT_STATUSES } from "../src/lib/status";
import type { Project } from "../src/lib/types";

function proj(id: string, status?: string): Project {
  return {
    id,
    name: id,
    description: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(status ? { status: status as Project["status"] } : {}),
  };
}

function labels(columns: BoardColumn[]): string[] {
  return columns.map((c) => c.label);
}

describe("groupByStatus", () => {
  it("always renders the three enum columns in enum order, even when empty", () => {
    expect(labels(groupByStatus([]))).toEqual([...PROJECT_STATUSES]);
    const cols = groupByStatus([]);
    expect(cols.map((c) => c.projects)).toEqual([[], [], []]);
    // No trailing "No status" bucket for an empty set.
    expect(labels(groupByStatus([]))).not.toContain(NO_STATUS_LABEL);
  });

  it("puts each project in exactly one bucket, preserving input order", () => {
    const input = [
      proj("a", "shipped"),
      proj("b", "idea"),
      proj("c", "shipped"),
      proj("d", "building"),
    ];
    const cols = groupByStatus(input);
    expect(labels(cols)).toEqual([...PROJECT_STATUSES]);
    expect(cols.find((c) => c.status === "shipped")?.projects.map((p) => p.id)).toEqual([
      "a",
      "c",
    ]);
    expect(cols.find((c) => c.status === "idea")?.projects.map((p) => p.id)).toEqual([
      "b",
    ]);
    expect(cols.find((c) => c.status === "building")?.projects.map((p) => p.id)).toEqual([
      "d",
    ]);
    // Nothing duplicated: bucket sizes sum to the input size.
    expect(cols.flatMap((c) => c.projects)).toHaveLength(input.length);
  });

  it("gives unstatused projects a trailing No status bucket, only when non-empty", () => {
    const cols = groupByStatus([proj("a", "idea"), proj("b")]);
    expect(labels(cols)).toEqual([...PROJECT_STATUSES, NO_STATUS_LABEL]);
    const none = cols[cols.length - 1];
    expect(none.status).toBeUndefined();
    expect(none.projects.map((p) => p.id)).toEqual(["b"]);

    // Every project statused: the trailing bucket disappears.
    const allStatused = groupByStatus([proj("a", "idea"), proj("b", "shipped")]);
    expect(labels(allStatused)).toEqual([...PROJECT_STATUSES]);
  });

  it("keys on the stored enum value itself (no re-validation, no case games)", () => {
    // The store enum-validates on write, so the grouping trusts p.status
    // verbatim — a value that could only exist by bypassing the store
    // falls into the unstatused bucket rather than crashing.
    const cols = groupByStatus([proj("a", "shipped"), proj("b", "nonsense")]);
    expect(cols.find((c) => c.status === "shipped")?.projects.map((p) => p.id)).toEqual([
      "a",
    ]);
    expect(cols.at(-1)?.projects.map((p) => p.id)).toEqual(["b"]);
  });
});
