import { NextRequest } from "next/server";
import { getProject, workspaceMissingRefs } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Missing-asset references in the LIVE workspace: every HTML src/href and
 * CSS @import/url() that points at a file the workspace doesn't contain.
 * Lines are 1-based so the code view can highlight the exact lines.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  if (!getProject(projectId)) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  return Response.json({ refs: workspaceMissingRefs(projectId) });
}
