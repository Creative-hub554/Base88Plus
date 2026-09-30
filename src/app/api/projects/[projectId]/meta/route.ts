import { NextRequest } from "next/server";
import { getProject, setProjectMeta } from "@/lib/store";

/**
 * PATCH /api/projects/[projectId]/meta
 *
 * Rename + describe a project in place. The store function (`setProjectMeta`)
 * is THE validator and returns the persisted record; this route adds only
 * the transport concerns: JSON parsing, the at-least-one-field contract, and
 * shape checks so the store receives only strings.
 *
 * Body: { name?: string, description?: string } — at least one required.
 * 200 → { project }  full updated record (updatedAt bumped by the store)
 * 400 → { error }    bad JSON / empty patch / wrong types
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
  const patch = (body ?? {}) as { name?: unknown; description?: unknown };

  const patchShape: { name?: string; description?: string } = {};
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
  if (patchShape.name === undefined && patchShape.description === undefined) {
    return Response.json(
      { error: "Provide name and/or description to update" },
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
