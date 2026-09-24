import { NextRequest } from "next/server";
import {
  generateTemplateDemoOrThrow,
  getTemplateCacheStatus,
  startRegenerateAll,
} from "@/lib/template-generation";
import { TEMPLATES } from "@/lib/templates";

export const maxDuration = 800;

/**
 * GET → per-template cache status (plus whether the startup warm pass is
 * still running, which the gallery polls on).
 */
export async function GET() {
  const status = await getTemplateCacheStatus();
  return Response.json(status);
}

/**
 * POST {id} → generate (or regenerate when stale) one template's demo app
 * server-side into its library project. Blocking, like before: returns the
 * fresh status on success or an error message for the gallery banner. The
 * gallery already flips the card into its generating state optimistically
 * and polls GET, so slow providers just show progress on the card.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    all?: boolean;
  };

  // {all:true} → force-regenerate every template demo in the background.
  if (body.all === true) {
    const result = await startRegenerateAll();
    if (!result.ok) {
      const busy = result.error?.includes("already running");
      return Response.json({ error: result.error }, { status: busy ? 409 : 400 });
    }
    return Response.json({ started: true });
  }
  const template = TEMPLATES.find((t) => t.id === body.id);
  if (!template) {
    return Response.json({ error: "Unknown template id" }, { status: 400 });
  }

  try {
    const status = await generateTemplateDemoOrThrow(template);
    return Response.json({ status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    const code = message.includes("Already generating")
      ? 409
      : message.includes("no files")
        ? 502
        : 400;
    return Response.json({ error: message }, { status: code });
  }
}
