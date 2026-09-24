import { NextRequest } from "next/server";
import {
  createProject,
  getProject,
  listAppFiles,
  readAppFile,
  saveAppFile,
  saveMessages,
  setProjectFromTemplate,
} from "@/lib/store";
import { TEMPLATES, templateProjectId } from "@/lib/templates";
import { getTemplateCacheStatus } from "@/lib/template-generation";
import type { BuilderUIMessage } from "@/lib/types";

/**
 * POST /api/templates/<id>/promote → create a real project from the cached
 * template demo, copying its files verbatim instead of regenerating. The
 * demo must be fresh (briefHash match) — the gallery only shows the button
 * on ready cards, and staleness here is refused with 409.
 *
 * A seeded assistant chat message records where the app came from, so the
 * builder opens with context instead of an empty transcript.
 */
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ template: string }> },
) {
  const { template: templateId } = await ctx.params;
  const template = TEMPLATES.find((t) => t.id === templateId);
  if (!template) {
    return Response.json({ error: "Unknown template id" }, { status: 400 });
  }

  const libraryId = templateProjectId(template.id);
  const library = getProject(libraryId);
  const status = (await getTemplateCacheStatus()).templates.find(
    (t) => t.id === template.id,
  );
  if (!library || !status?.ready) {
    return Response.json(
      {
        error:
          "This template has no cached demo yet (or it's stale) — generate a preview first.",
      },
      { status: 409 },
    );
  }

  const source = listAppFiles(libraryId);
  if (source.length === 0) {
    return Response.json(
      { error: "Template demo is empty — regenerate the preview first." },
      { status: 409 },
    );
  }

  const name = template.appName;
  const project = createProject(name, template.brief);

  // Copy every demo file verbatim into the new project's workspace.
  for (const f of source) {
    const content = readAppFile(libraryId, f.path);
    if (content === null) continue;
    saveAppFile(project.id, f.path, content);
  }

  setProjectFromTemplate(project.id, {
    id: template.id,
    name: template.name,
    promotedAt: new Date().toISOString(),
  });

  // Seed the chat with a compact provenance note (assistant role, so it
  // renders as a message bubble rather than user input).
  const now = Date.now();
  const seed: BuilderUIMessage = {
    id: `seed-${now}`,
    role: "assistant",
    parts: [
      {
        type: "text",
        text: `This app started from the **${template.name}** template — its generated demo files were copied into your workspace, ready to iterate on. Describe any change below (colors, sections, content) and the AI will edit the copied files directly.`,
      },
    ],
    metadata: { fileCount: source.length },
  };
  saveMessages(project.id, [seed]);

  return Response.json({ project }, { status: 201 });
}
