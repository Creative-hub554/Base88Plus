import {
  getSettings,
  hasProviderCredentials,
  listProviderModels,
} from "@/lib/providers/gateway";
import type { ModelMetadata } from "@/lib/models-catalog";

interface CatalogProvider {
  id: string;
  name: string;
  configured: boolean;
  activeModel?: string;
  defaultModel: string;
  /** Live model ids from the provider's /models endpoint; empty when unreachable. */
  models: string[];
  /**
   * Provider-published facts per model id (context window, price, …), {} for
   * a provider that publishes none. Never derived here — the picker shows
   * the provider's own numbers or nothing at all.
   */
  metadata: Record<string, ModelMetadata>;
  error?: string;
  /** The catalog is the last good one; the refresh failed (see error). */
  stale?: boolean;
}

/**
 * GET /api/models
 *
 * Lists available models per configured provider. For each provider with
 * credentials (or keyless local ones), queries its OpenAI-compatible
 * /v1/models endpoint — cached and single-flight (see readModelCatalog), so
 * the pickers' repeated opens do not each become 33 requests. Unreachable
 * providers return [] with an error note so the picker can degrade
 * gracefully; a provider that blipped keeps serving its last catalog, marked
 * `stale`, rather than emptying the dropdown.
 */
export async function GET() {
  const settings = getSettings();
  const activeProviderId = settings.activeProviderId;
  const activeModel = settings.activeModel;

  const providers: CatalogProvider[] = await Promise.all(
    settings.providers.map(async (p) => {
      const { models, metadata, error, stale } = await listProviderModels(
        p,
        settings,
      );

      return {
        id: p.id,
        name: p.name,
        configured: hasProviderCredentials(p, settings),
        activeModel:
          p.id === activeProviderId ? activeModel || p.defaultModel : p.defaultModel,
        defaultModel: p.defaultModel,
        models,
        metadata,
        error,
        ...(stale ? { stale: true } : {}),
      };
    }),
  );

  return Response.json(
    { providers, active: { providerId: activeProviderId, model: activeModel } },
    { headers: { "Cache-Control": "no-store" } },
  );
}



