import { NextRequest } from "next/server";
import { getProject, setProjectMeta } from "@/lib/store";

/**
 * PATCH /api/projects/[projectId]/meta
 *
 * Rename + describe + tag a project in place. The store function
 * (`setProjectMeta`) is THE validator and returns the persisted record;
 * this route adds only the transport concerns: JSON parsing, the
 * at-least-one-field contract, and shape checks so the store receives
 * only strings.
 *
 * Body: { name?: string, description?: string, tags?: string,
 * status?: string } — at least one required. Tags are one comma-separated
 * string (store splits/trims/joins); status must be empty (clears it) or
 * one of the `PROJECT_STATUSES` enum values (400 with the value list
 * otherwise).
 * 200 → { project }  full updated record (updatedAt bumped by the store)
 * 400 → { error }    bad JSON / empty patch / wrong types / bad status
 * 404 → { error }    unknown project
 * The store trims and enforces caps; a name that is empty after trim is a
 * 400 from the store (surfaced here as 400 with the store's message).
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const patch = (body ?? {}) as {
    name?: unknown;
    description?: unknown;
    tags?: unknown;
    status?: unknown;
  };

  const patchShape: {
    name?: string;
    description?: string;
    tags?: string;
    status?: string;
  } = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string") {
      return Response.json({ error: "name must be a string" }, { status: 400 });
    }
    patchShape.name = patch.name;
  }
  if (patch.description !== undefined) {
    if (typeof patch.description !== "string") {
      return Response.json({ error: "description must be a string" }, { status: 400 });
    }
    patchShape.description = patch.description;
  }
  if (patch.tags !== undefined) {
    if (typeof patch.tags !== "string") {
      return Response.json({ error: "tags must be a string" }, { status: 400 });
    }
    patchShape.tags = patch.tags;
  }
  if (patch.status !== undefined) {
    if (typeof patch.status !== "string") {
      return Response.json({ error: "status must be a string" }, { status: 400 });
    }
    patchShape.status = patch.status;
  }
  if (
    patchShape.name === undefined &&
    patchShape.description === undefined &&
    patchShape.tags === undefined &&
    patchShape.status === undefined
  ) {
    return Response.json(
      { error: "Provide name, description, tags, and/or status to update" },
      { status: 400 },
    );
  }

  try {
    const updated = setProjectMeta(projectId, patchShape);
    return Response.json({ project: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Update failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
