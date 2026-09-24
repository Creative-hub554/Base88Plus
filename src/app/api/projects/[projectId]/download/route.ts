import { NextRequest } from "next/server";
import JSZip from "jszip";
import { getProject, listAppFiles } from "@/lib/store";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) return new Response("Project not found", { status: 404 });

  const zip = new JSZip();
  for (const file of listAppFiles(projectId)) {
    zip.file(file.path, file.content);
  }

  const buffer = await zip.generateAsync({ type: "uint8array" });
  return new Response(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.zip"`,
    },
  });
}
