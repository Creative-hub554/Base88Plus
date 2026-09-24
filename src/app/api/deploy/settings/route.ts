import { NextRequest } from "next/server";
import {
  cfCredentials,
  getSettings,
  isPlaceholderKey,
  saveSettings,
} from "@/lib/providers/gateway";
import { verifyCloudflare } from "@/lib/deploy/cloudflare";

/**
 * GET → Cloudflare deploy connection status (token redacted).
 * POST → connect {accountId, apiKey}, verify, discover workers.dev subdomain.
 */
export async function GET() {
  const settings = getSettings();
  const cf = cfCredentials(settings);
  return Response.json({
    connected: Boolean(cf),
    accountId: cf?.accountId,
    subdomain: settings.cloudflare?.subdomain || undefined,
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    accountId?: string;
    apiKey?: string;
  };

  const settings = getSettings();
  settings.cloudflare = settings.cloudflare ?? {};

  if (body.accountId !== undefined) settings.cloudflare.accountId = body.accountId.trim();
  if (body.apiKey !== undefined) {
    settings.cloudflare.apiKey = body.apiKey.trim() || undefined;
  }

  const creds = cfCredentials(settings);
  if (!creds) {
    saveSettings(settings);
    return Response.json(
      { error: "Account ID and API token are required." },
      { status: 400 },
    );
  }
  const { accountId, apiKey } = creds;

  // Verify up front and cache the workers.dev subdomain.
  try {
    const { subdomain } = await verifyCloudflare({ accountId, apiKey });
    settings.cloudflare.subdomain = subdomain;
    saveSettings(settings);
    return Response.json({ connected: true, accountId, subdomain });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Verification failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
