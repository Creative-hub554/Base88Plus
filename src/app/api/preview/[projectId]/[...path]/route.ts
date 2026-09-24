import { NextRequest } from "next/server";
import { contentTypeFor } from "@/lib/content-types";
import {
  getProject,
  readAppFile,
} from "@/lib/store";

/**
 * Serves a generated app file so the preview iframe can load it.
 * Content types cover the common web asset types the generator produces.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string; path: string[] }> },
) {
  const { projectId, path } = await ctx.params;
  const project = getProject(projectId);
  if (!project) return new Response("Project not found", { status: 404 });

  const filePath = path.map(decodeURIComponent).join("/");
  const content = readAppFile(projectId, filePath);
  if (content === null) return new Response("Not found", { status: 404 });

  const headers: Record<string, string> = {
    "Content-Type": contentTypeFor(filePath),
    "Cache-Control": "no-store",
  };
  // Relax same-origin restrictions so the sandboxed iframe can load assets.
  headers["Content-Security-Policy"] =
    "sandbox allow-scripts allow-forms allow-modals allow-popups";
  return new Response(content, { headers });
}
