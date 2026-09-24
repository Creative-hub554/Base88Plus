import { NextRequest } from "next/server";
import { contentTypeFor } from "@/lib/content-types";
import { getDeployVersion, readDeployVersionFile } from "@/lib/store";

/**
 * Serve a file from a stored deploy version so past versions can be
 * previewed: /api/projects/:id/deploy/versions/:version/<path>.
 * Read-only — viewing history never touches the live deployment.
 */
export async function GET(
  _req: NextRequest,
  ctx: {
    params: Promise<{ projectId: string; version: string; path?: string[] }>;
  },
) {
  const { projectId, version, path } = await ctx.params;
  const v = Number(version);
  if (!Number.isInteger(v) || v < 1) {
    return new Response("Invalid version", { status: 400 });
  }
  if (!getDeployVersion(projectId, v)) {
    return new Response("Version not found (may have been pruned)", {
      status: 404,
    });
  }

  const requested = (path ?? []).map(decodeURIComponent).join("/");
  const filePath = requested === "" ? "index.html" : requested;
  const content = readDeployVersionFile(projectId, v, filePath);
  if (content === null) return new Response("Not found", { status: 404 });

  return new Response(content, {
    headers: {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": "no-store",
      // Same sandbox posture as the live preview.
      "Content-Security-Policy":
        "sandbox allow-scripts allow-forms allow-modals allow-popups",
    },
  });
}
