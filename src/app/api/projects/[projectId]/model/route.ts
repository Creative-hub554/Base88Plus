import { NextRequest } from "next/server";
import { getProject, setProjectModelOverride } from "@/lib/store";
import {
  getSettings,
  hasProviderCredentials,
  isProviderUsable,
  listProviderModels,
} from "@/lib/providers/gateway";

function ctxOf(ctx: { params: Promise<{ projectId: string }> }) {
  return ctx.params;
}

/**
 * GET → the project's current model pin (or null) plus the catalog the
 * pin-picker offers (configured providers, live model lists, global default).
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctxOf(ctx);
  const project = getProject(projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const settings = getSettings();
  const catalog = await Promise.all(
    settings.providers.map(async (p) => ({
      id: p.id,
      name: p.name,
      configured: hasProviderCredentials(p, settings),
      defaultModel: p.defaultModel,
      ...(await listProviderModels(p, settings)),
    })),
  );

  return Response.json({
    override: project.modelOverride ?? null,
    default: { providerId: settings.activeProviderId, modelId: settings.activeModel },
    catalog,
  });
}

/**
 * PUT → pin a provider/model for this project, or clear the pin with
 * `{ providerId: null }` / `{ clear: true }`.
 */
export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctxOf(ctx);
  const project = getProject(projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const body = (await req.json()) as {
    providerId?: string | null;
    modelId?: string;
    clear?: boolean;
  };

  if (body.clear === true || body.providerId === null) {
    setProjectModelOverride(projectId, undefined);
    return Response.json({ override: null });
  }

  const { providerId, modelId } = body;
  if (!providerId || !modelId) {
    return Response.json(
      { error: "providerId and modelId are required (or clear: true)" },
      { status: 400 },
    );
  }

  // Validate against the gateway's own usability gate — the pin route must
  // never accept a pin the resolver would refuse on the next message.
  const settings = getSettings();
  const provider = settings.providers.find((p) => p.id === providerId);
  if (!provider || !isProviderUsable(provider, settings)) {
    return Response.json(
      { error: `Provider "${providerId}" is not configured` },
      { status: 400 },
    );
  }

  setProjectModelOverride(projectId, { providerId, modelId });
  return Response.json({ override: { providerId, modelId } });
}
