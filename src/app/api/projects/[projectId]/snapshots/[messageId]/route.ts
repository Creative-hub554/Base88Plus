import { NextRequest } from "next/server";
import {
  getProject,
  restoreTurnSnapshot,
  turnSnapshotDiff,
} from "@/lib/store";

/**
 * What restoring this snapshot would change vs the current workspace —
 * the hover diff summary for the chat's Restore buttons.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string; messageId: string }> },
) {
  const { projectId, messageId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  const diff = turnSnapshotDiff(projectId, messageId);
  if (!diff) {
    return Response.json(
      { error: "Snapshot not found" },
      { status: 404 },
    );
  }
  return Response.json({ diff });
}

/**
 * Restore the workspace to a turn's snapshot (per-generation undo).
 * Returns the restored snapshot, or 404 when it no longer exists (pruned
 * or unknown message id).
 */
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string; messageId: string }> },
) {
  const { projectId, messageId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  const restored = restoreTurnSnapshot(projectId, messageId);
  if (!restored) {
    return Response.json(
      { error: "Snapshot not found" },
      { status: 404 },
    );
  }
  return Response.json({ restored });
}
