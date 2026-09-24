import { NextRequest } from "next/server";
import { readTurnSnapshotFile } from "@/lib/store";
import { contentTypeFor } from "@/lib/content-types";

/**
 * Serves one file from a turn snapshot for the version-history panel's
 * live thumbnails (read-only, like the template gallery's thumbnail
 * route). Paths are traversal-safe via readTurnSnapshotFile.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string; messageId: string; path: string[] }> },
) {
  const { projectId, messageId, path } = await ctx.params;
  if (path.length === 0) {
    return new Response("Not found", { status: 404 });
  }
  const content = readTurnSnapshotFile(projectId, messageId, path.join("/"));
  if (content === null) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(content, {
    headers: {
      "Content-Type": contentTypeFor(path.join("/")),
      // Snapshots are immutable; the panel re-fetches the list per open.
      "Cache-Control": "no-store",
    },
  });
}
