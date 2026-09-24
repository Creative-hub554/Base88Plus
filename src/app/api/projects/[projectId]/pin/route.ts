import { NextRequest } from "next/server";
import {
  clearPinnedSnapshot,
  getProject,
  setPinnedSnapshot,
} from "@/lib/store";

/**
 * Pinned best version: GET returns the current pin (null when unpinned);
 * DELETE clears the pin so publishing returns to the live workspace.
 * POST (on /pin/[messageId]) marks a turn snapshot as THE version
 * publishing always ships, independent of the live workspace.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  return Response.json({ pinnedSnapshot: project.pinnedSnapshot ?? null });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  clearPinnedSnapshot(projectId);
  return Response.json({ pinnedSnapshot: null });
}
