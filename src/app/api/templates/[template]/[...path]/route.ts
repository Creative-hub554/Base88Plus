import { NextRequest } from "next/server";
import { readAppFile } from "@/lib/store";
import { templateProjectId } from "@/lib/templates";
import { contentTypeFor } from "@/lib/content-types";

/**
 * Serves a generated template demo's files for the /new gallery's live
 * thumbnails. Read-only; serves the library project's workspace files.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ template: string; path: string[] }> },
) {
  const { template, path } = await ctx.params;
  const known = ["landing", "portfolio", "restaurant", "saas", "event", "blog"];
  if (!known.includes(template)) {
    return new Response("Not found", { status: 404 });
  }
  if (path.length === 0) {
    return new Response("Not found", { status: 404 });
  }

  const projectId = templateProjectId(template);
  const filePath = path.join("/");
  const content = readAppFile(projectId, filePath);
  if (content === null) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(content, {
    headers: {
      "Content-Type": contentTypeFor(filePath),
      // Thumbnails are immutable per generatedAt version query param.
      "Cache-Control": "public, max-age=60",
    },
  });
}
