import {
  clearReachabilityCache,
  getProvidersHealth,
  getProjectModelInfo,
  type ProviderHealth,
} from "@/lib/providers/gateway";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Health snapshot for the /providers dashboard: which providers are
 * configured and reachable (parallel cached probes), plus the model every
 * project actually generates with (pin or global default). `?probe=1`
 * drops the 30s probe cache for a fresh verdict ("Re-check now").
 */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("probe")) clearReachabilityCache();
  const providers = await getProvidersHealth();
  const reachableById = new Map<string, boolean | null>(
    providers.map((p: ProviderHealth) => [p.id, p.reachable] as const),
  );
  const projects = getProjectModelInfo(reachableById);
  return Response.json({ providers, projects });
}
