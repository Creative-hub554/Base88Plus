import {
  getSettings,
  hasProviderCredentials,
  listProviderModels,
} from "@/lib/providers/gateway";

interface CatalogProvider {
  id: string;
  name: string;
  configured: boolean;
  activeModel?: string;
  defaultModel: string;
  /** Live model ids from the provider's /models endpoint; empty when unreachable. */
  models: string[];
  error?: string;
}

/**
 * GET /api/models
 *
 * Lists available models per configured provider. For each provider with
 * credentials (or keyless local ones), queries its OpenAI-compatible
 * /v1/models endpoint. Unreachable providers return [] with an error note
 * so the picker can degrade gracefully.
 */
export async function GET() {
  const settings = getSettings();
  const activeProviderId = settings.activeProviderId;
  const activeModel = settings.activeModel;

  const providers: CatalogProvider[] = await Promise.all(
    settings.providers.map(async (p) => {
      const { models, error } = await listProviderModels(p, settings);

      return {
        id: p.id,
        name: p.name,
        configured: hasProviderCredentials(p, settings),
        activeModel:
          p.id === activeProviderId ? activeModel || p.defaultModel : p.defaultModel,
        defaultModel: p.defaultModel,
        models,
        error,
      };
    }),
  );

  return Response.json(
    { providers, active: { providerId: activeProviderId, model: activeModel } },
    { headers: { "Cache-Control": "no-store" } },
  );
}



