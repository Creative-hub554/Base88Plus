import { NextRequest } from "next/server";
import {
  getProject,
  mostRecentCompleteSnapshot,
  setPinnedSnapshot,
  snapshotMissingAssets,
} from "@/lib/store";

/**
 * POST: mark a turn snapshot as the project's PINNED best version —
 * publishing always ships this snapshot's files (independent of the live
 * workspace) until the pin is cleared via DELETE /pin.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string; messageId: string }> },
) {
  const { projectId, messageId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  // Confirm-overrides (force=true) still report what they overrode so the
  // client can say "pinned anyway — these assets will 404".
  const missing = snapshotMissingAssets(projectId, messageId);
  let force = false;
  try {
    force = (await req.json())?.force === true;
  } catch {
    // no body → plain pin request
  }
  if (missing.length > 0 && !force) {
    return Response.json(
      {
        warning: "This snapshot is missing assets its HTML references.",
        missing,
        // One-click alternative: the newest self-contained snapshot, so
        // the UI can offer "switch to the complete version instead".
        suggest: mostRecentCompleteSnapshot(projectId),
      },
      { status: 409 },
    );
  }
  const updated = setPinnedSnapshot(projectId, messageId);
  if (!updated) {
    return Response.json({ error: "Snapshot not found" }, { status: 404 });
  }
  return Response.json({
    pinnedSnapshot: updated.pinnedSnapshot ?? null,
    ...(missing.length > 0 ? { pinnedWithMissing: missing } : {}),
  });
}
