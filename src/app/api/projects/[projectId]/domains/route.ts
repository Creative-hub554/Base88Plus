import { NextRequest } from "next/server";
import {
  attachCustomDomain,
  detachCustomDomain,
  DeployError,
} from "@/lib/deploy/cloudflare";
import {
  getProject,
  setProjectCustomDomains,
} from "@/lib/store";
import {
  cfCredentials,
  cfSubdomain,
  getSettings,
} from "@/lib/providers/gateway";
import type { CustomDomain } from "@/lib/types";

/** Load Cloudflare creds or return an error response. */
function requireCf(): { accountId: string; apiKey: string; subdomain?: string } | Response {
  const settings = getSettings();
  const cf = cfCredentials(settings);
  if (!cf) {
    return Response.json(
      { error: "Cloudflare is not connected. Connect it in the Deploy section first." },
      { status: 400 },
    );
  }
  return { ...cf, subdomain: cfSubdomain(settings) };
}

/** GET → the project's domains, each with per-domain DNS instructions. */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const subdomain = cfSubdomain(getSettings());
  const workerName = project.deployment?.workerName ?? project.id;
  const domains = (project.customDomains ?? []).map((d) => ({
    ...d,
    dns: instructionsFor(d, workerName, subdomain),
  }));
  return Response.json({ domains, connected: Boolean(subdomain) });
}

function instructionsFor(
  d: CustomDomain,
  workerName: string,
  subdomain?: string,
) {
  if (d.mode === "managed") {
    return {
      type: "managed" as const,
      text: `Zone is on your Cloudflare account — the Workers route (${d.hostname}/*) was created automatically. If the DNS record for ${d.hostname} doesn't exist yet, add an A/AAAA/CNAME record for it in the Cloudflare dashboard (proxied).`,
    };
  }
  const target = `${workerName}.${subdomain ?? "<your-subdomain>"}.workers.dev`;
  return {
    type: "manual" as const,
    text: `Add this DNS record at your domain's DNS provider:`,
    record: { type: "CNAME", name: d.hostname, target, proxy: "DNS only" },
  };
}

/** POST {hostname} → attach a domain (managed route or manual CNAME). */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const creds = requireCf();
  if (creds instanceof Response) return creds;

  const body = (await req.json().catch(() => ({}))) as { hostname?: string };
  const hostname = (body.hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!hostname) {
    return Response.json({ error: "hostname is required" }, { status: 400 });
  }

  const subdomain = cfSubdomain(getSettings()) ?? "";

  try {
    // The worker URL is only needed for the manual CNAME target; the worker
    // name comes from the last deploy when available.
    const workerName = project.deployment?.workerName;
    if (!workerName) {
      return Response.json(
        { error: "Deploy to Cloudflare once before attaching a domain." },
        { status: 400 },
      );
    }
    const result = await attachCustomDomain(
      workerName,
      hostname,
      creds,
      subdomain,
    );
    const entry: CustomDomain = {
      hostname: result.hostname,
      zoneId: result.zoneId,
      mode: result.mode,
      attachedAt: new Date().toISOString(),
    };
    const domains = [...(project.customDomains ?? []).filter(
      (d) => d.hostname !== result.hostname,
    ), entry];
    setProjectCustomDomains(projectId, domains);
    return Response.json({
      domain: { ...entry, workerUrl: result.workerUrl },
      domains,
    });
  } catch (e) {
    if (e instanceof DeployError) {
      return Response.json({ error: e.message }, { status: e.status ?? 500 });
    }
    const message = e instanceof Error ? e.message : "Domain attach failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

/** DELETE {hostname} (query param) → detach. */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const creds = requireCf();
  if (creds instanceof Response) return creds;

  const hostname = new URL(req.url).searchParams.get("hostname");
  if (!hostname) {
    return Response.json({ error: "hostname query param required" }, { status: 400 });
  }

  const domain = (project.customDomains ?? []).find((d) => d.hostname === hostname);
  if (!domain) {
    return Response.json({ error: "Domain not attached" }, { status: 404 });
  }

  try {
    const workerName = project.deployment?.workerName ?? project.id;
    await detachCustomDomain(workerName, domain, creds);
  } catch (e) {
    // Detach is best-effort: if the route removal fails (zone deleted, token
    // scope lost) we still drop it locally so the UI doesn't wedge.
    console.error("[domains] route removal failed:", e);
  }

  const domains = (project.customDomains ?? []).filter(
    (d) => d.hostname !== hostname,
  );
  setProjectCustomDomains(projectId, domains);
  return Response.json({ domains });
}
