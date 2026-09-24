import { NextRequest } from "next/server";
import {
  getSettings,
  isPlaceholderKey,
  redactSettings,
  saveSettings,
} from "@/lib/providers/gateway";
import { DEFAULT_PROVIDERS } from "@/lib/providers/registry";

export async function GET() {
  const settings = getSettings();
  return Response.json({ settings: redactSettings(settings) });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    activeProviderId?: string;
    activeModel?: string;
    provider?: {
      id: string;
      name?: string;
      baseURL?: string;
      apiKey?: string;
      defaultModel?: string;
      headers?: Record<string, string>;
    };
  };

  const settings = getSettings();
  settings.providers = settings.providers.length
    ? settings.providers
    : DEFAULT_PROVIDERS.map((p) => ({ ...p }));

  if (body.activeProviderId !== undefined) {
    settings.activeProviderId = body.activeProviderId;
  }
  if (body.activeModel !== undefined) {
    settings.activeModel = body.activeModel;
  }

  if (body.provider) {
    const { id, ...rest } = body.provider;
    const existing = settings.providers.find((p) => p.id === id);
    if (existing) {
      Object.assign(existing, rest);
      if (rest.apiKey === "" || (rest.apiKey && isPlaceholderKey(rest.apiKey)))
        existing.apiKey = undefined;
    } else {
      settings.providers.push({
        id,
        name: rest.name || id,
        kind: "openai-compatible",
        baseURL: rest.baseURL || "",
        defaultModel: rest.defaultModel || "",
        configured: Boolean(rest.apiKey),
        headers: rest.headers,
        apiKey: rest.apiKey,
      });
    }
  }

  saveSettings(settings);

  // Return redacted settings.
  return Response.json({ settings: redactSettings(settings) });
}
