import { NextRequest } from "next/server";
import { forkTurnSnapshot, getProject } from "@/lib/store";

/**
 * "Restore as copy": fork a turn snapshot into a NEW project with the
 * snapshot's files as its starting workspace. The source project is
 * untouched. Body (optional): { name?: string }.
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
  let name: string | undefined;
  try {
    const body = (await req.json()) as { name?: string };
    if (typeof body?.name === "string" && body.name.trim()) {
      name = body.name.trim();
    }
  } catch {
    /* no body → default name */
  }
  const fork = forkTurnSnapshot(projectId, messageId, name);
  if (!fork) {
    return Response.json({ error: "Snapshot not found" }, { status: 404 });
  }
  return Response.json({ project: fork });
}
