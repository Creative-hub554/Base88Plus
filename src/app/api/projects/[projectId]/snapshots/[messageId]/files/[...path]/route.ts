import { NextRequest } from "next/server";
import { readTurnSnapshotFile, isBinaryPath } from "@/lib/store";
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
  const filePath = path.join("/");
  const content = readTurnSnapshotFile(projectId, messageId, filePath);
  if (content === null) {
    return new Response("Not found", { status: 404 });
  }
  // Binary assets ride the string layer as base64 — emit raw bytes.
  const body: BodyInit = isBinaryPath(filePath)
    ? Buffer.from(content, "base64")
    : content;
  return new Response(body, {
    headers: {
      "Content-Type": contentTypeFor(filePath),
      // Snapshots are immutable; the panel re-fetches the list per open.
      "Cache-Control": "no-store",
    },
  });
}
