import { NextRequest } from "next/server";
import JSZip from "jszip";
import { EXPORT_META_FILENAME } from "@/lib/zip-import";
import { getProject, listAppFiles } from "@/lib/store";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) return new Response("Project not found", { status: 404 });

  const zip = new JSZip();
  // Metadata envelope at the zip root: anybase marker + id/name/
  // description/createdAt/updatedAt/template/pinnedSnapshot. The import
  // consumes it (restoring the app's original name/description) when the
  // marker is present; the OLD id/timestamps never leak into the fresh
  // project. No secrets: Project carries none — BYO keys live in
  // settings, never in the project record. Root project.json is
  // store-reserved, so this name can never collide with an app file
  // (listAppFiles excludes the record), and a foreign zip carrying its
  // own project.json just gets skipped as reserved on import.
  zip.file(
    EXPORT_META_FILENAME,
    JSON.stringify(
      {
        anybase: 1,
        id: project.id,
        name: project.name,
        description: project.description,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        ...(project.template ? { template: project.template } : {}),
        ...(project.pinnedSnapshot ? { pinnedSnapshot: project.pinnedSnapshot } : {}),
      },
      null,
      2,
    ),
  );
  for (const file of listAppFiles(projectId)) {
    if (file.encoding === "base64") {
      // Binary asset: zip the RAW bytes, not the base64 string layer.
      zip.file(file.path, Buffer.from(file.content, "base64"), { binary: true });
    } else {
      zip.file(file.path, file.content);
    }
  }

  const buffer = await zip.generateAsync({ type: "uint8array" });
  return new Response(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.zip"`,
    },
  });
}
