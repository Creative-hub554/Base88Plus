import { NextRequest } from "next/server";
import { getProject, listAppFiles } from "@/lib/store";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  return Response.json({ files: listAppFiles(projectId) });
}
