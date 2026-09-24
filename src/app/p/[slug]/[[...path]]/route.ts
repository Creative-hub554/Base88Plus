import { NextRequest } from "next/server";
import { contentTypeFor } from "@/lib/content-types";
import {
  findPublishedProject,
  readPublishedFile,
} from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Public published-app route: /p/<slug> and /p/<slug>/<asset-path>.
 * Serves the immutable publish snapshot — NOT the live workspace — so
 * republishing is what makes new edits visible, Base44-style.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string; path?: string[] }> },
) {
  const { slug, path } = await ctx.params;

  const found = findPublishedProject(slug);
  if (!found) {
    return new Response("This page doesn't exist or is no longer published.", {
      status: 404,
    });
  }

  const requested = (path ?? []).map(decodeURIComponent).join("/");
  const filePath = requested === "" ? "index.html" : requested;
  const content = readPublishedFile(found.projectId, filePath);
  if (content === null) return new Response("Not found", { status: 404 });

  const headers: Record<string, string> = {
    "Content-Type": contentTypeFor(filePath),
    // Public pages are safe to cache briefly; keeps repeat visits snappy.
    "Cache-Control": "public, max-age=60",
  };
  // Same sandbox posture as the in-app preview: scripts run, but the page
  // can't reach cookies/storage of anything else on this origin.
  headers["Content-Security-Policy"] =
    "sandbox allow-scripts allow-forms allow-modals allow-popups";
  return new Response(content, { headers });
}
