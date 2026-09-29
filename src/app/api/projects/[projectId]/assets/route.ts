import { NextRequest } from "next/server";
import { isAssetPath } from "@/lib/asset-extensions";
import {
  getProject,
  saveAppFile,
  listAppFiles,
  touchProject,
} from "@/lib/store";

/** Per-asset cap: generous for icons/fonts, hostile to video dumps. */
const MAX_ASSET_BYTES = 2_000_000;

/**
 * Direct asset upload: the drag-and-drop/click companion to zip import —
 * users add images and fonts to a project without a zip round-trip.
 * The server is the validator (the client's accept list is only UX):
 * extension allowlist, size cap, filename safety, duplicate rejection
 * (replace via zip import or the chat).
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json(
      { error: "Expected multipart/form-data with one or more 'file' fields" },
      { status: 400 },
    );
  }

  const files = [...form.getAll("file")].filter(
    (f): f is File => typeof f !== "string",
  );
  if (files.length === 0) {
    return Response.json(
      { error: "No files uploaded (field 'file')" },
      { status: 400 },
    );
  }

  const existing = new Set(listAppFiles(projectId).map((f) => f.path));
  const saved: { path: string }[] = [];
  const errors: { filename: string; error: string }[] = [];

  for (const file of files) {
    // Basename only — a browser File.name cannot contain separators, but
    // a hand-rolled multipart can claim anything.
    const rawName = file.name.split(/[\\/]/).pop() ?? "";
    if (!rawName || rawName.startsWith(".")) {
      errors.push({ filename: file.name, error: "Unsafe filename" });
      continue;
    }
    if (!isAssetPath(rawName)) {
      errors.push({ filename: file.name, error: "Unsupported asset type" });
      continue;
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length === 0) {
      errors.push({ filename: file.name, error: "Empty file" });
      continue;
    }
    if (bytes.length > MAX_ASSET_BYTES) {
      errors.push({
        filename: file.name,
        error: `Too large (max ${Math.round(MAX_ASSET_BYTES / 1000)} kB)`,
      });
      continue;
    }
    if (existing.has(rawName)) {
      errors.push({ filename: file.name, error: "A file with this name already exists" });
      continue;
    }
    saveAppFile(projectId, rawName, bytes.toString("base64"), "base64");
    existing.add(rawName);
    saved.push({ path: rawName });
  }

  if (saved.length > 0) touchProject(projectId);
  return Response.json(
    { saved, errors },
    { status: saved.length > 0 ? 201 : 400 },
  );
}
