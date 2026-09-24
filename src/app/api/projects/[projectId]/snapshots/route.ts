import { NextRequest } from "next/server";
import {
  getProject,
  listTurnSnapshots,
  snapshotMissingAssets,
} from "@/lib/store";

/** Snapshot summaries for the undo UI, newest first. */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  // `missing` = local assets the snapshot's HTML references but the
  // snapshot lacks — pinning/publishing it ships a page with 404ing
  // assets, so the UI can warn before that happens.
  return Response.json({
    snapshots: listTurnSnapshots(projectId).map((s) => ({
      ...s,
      missing: snapshotMissingAssets(projectId, s.messageId),
    })),
  });
}
