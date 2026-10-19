import {
  clearReachabilityCache,
  getProvidersHealth,
  getProjectModelInfo,
  type ProviderHealth,
} from "@/lib/providers/gateway";
import { warmModelFacts } from "@/lib/providers/model-facts";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Health snapshot for the /providers dashboard: which providers are
 * configured and reachable (parallel cached probes), plus the model every
 * project actually generates with (pin or global default). `?probe=1`
 * drops the 30s probe cache for a fresh verdict ("Re-check now"), and warms
 * the models.dev facts too — the user is asking this app to go and look, so
 * the picker's next open should not be the thing that pays for it.
 */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("probe")) {
    clearReachabilityCache();
    warmModelFacts();
  }
  const providers = await getProvidersHealth();
  const reachableById = new Map<string, boolean | null>(
    providers.map((p: ProviderHealth) => [p.id, p.reachable] as const),
  );
  const projects = getProjectModelInfo(reachableById);
  return Response.json({ providers, projects });
}
