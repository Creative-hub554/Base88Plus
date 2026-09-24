import { NextRequest } from "next/server";
import { deployToCloudflare, DeployError } from "@/lib/deploy/cloudflare";
import fs from "node:fs";
import {
  getProject,
  getPublishManifest,
  listDeployVersions,
  readPublishedFile,
  restoreDeployVersion,
  setProjectDeployment,
  recordDeployVersion,
} from "@/lib/store";
import { cfCredentials, cfSubdomain, getSettings } from "@/lib/providers/gateway";
import type { ProjectFile } from "@/lib/types";

/** Display URL for a deploy: edge override (E2E harness) or real workers.dev. */
function displayUrl(
  slug: string,
  subdomain: string | undefined,
): string {
  const edgeBase = fs.existsSync(".env.cloudflare-edge")
    ? fs
        .readFileSync(".env.cloudflare-edge", "utf8")
        .trim()
        .replace(/\/$/, "")
    : "";
  return edgeBase
    ? `${edgeBase}/${slug}`
    : `https://${slug}.${subdomain}.workers.dev`;
}

/** Run the Cloudflare pipeline for a file set; returns the public URL. */
async function runDeploy(
  slug: string,
  files: ProjectFile[],
): Promise<{ url: string }> {
  const settings = getSettings();
  const cf = cfCredentials(settings);
  if (!cf) {
    throw new DeployError(
      "Cloudflare is not connected. Add an Account ID and API token first.",
      400,
    );
  }
  const { subdomain } = await deployToCloudflare(slug, files, {
    accountId: cf.accountId,
    apiKey: cf.apiKey,
    subdomain: cfSubdomain(settings),
  });
  return { url: displayUrl(slug, subdomain) };
}

/**
 * GET → deploy status + version history for the builder UI.
 * POST → deploy the current published snapshot as a new version.
 * PUT → roll back: restore a past version ({version: n}) into the
 * workspace + snapshot, then redeploy it as a new version.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  return Response.json({
    deployment: project.deployment ?? null,
    versions: listDeployVersions(projectId),
  });
}

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const manifest = getPublishManifest(projectId);
  if (!manifest) {
    return Response.json(
      { error: "Publish the app first — deploys ship the published snapshot." },
      { status: 400 },
    );
  }

  // Materialize the snapshot files for the deploy engine.
  const files: ProjectFile[] = [];
  for (const path of manifest.files) {
    const content = readPublishedFile(projectId, path);
    if (content !== null) files.push({ path, content });
  }

  try {
    const { url } = await runDeploy(manifest.slug, files);
    const deployedAt = new Date().toISOString();
    const version = recordDeployVersion(projectId, files, {
      url,
      slug: manifest.slug,
      deployedAt,
    });
    const deployment = {
      workerName: manifest.slug,
      url,
      deployedAt,
      version: version.version,
    };
    setProjectDeployment(projectId, deployment);
    return Response.json({ deployment, versions: listDeployVersions(projectId) });
  } catch (e) {
    if (e instanceof DeployError) {
      return Response.json({ error: e.message }, { status: e.status ?? 500 });
    }
    const message = e instanceof Error ? e.message : "Deploy failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { version?: number };
  const target = Number(body.version);
  if (!Number.isInteger(target) || target < 1) {
    return Response.json({ error: "Body must be {version: <number>}." }, { status: 400 });
  }

  const restored = restoreDeployVersion(projectId, target);
  if (!restored) {
    return Response.json(
      { error: `Version ${target} not found (it may have been pruned).` },
      { status: 404 },
    );
  }

  const manifest = getPublishManifest(projectId);
  if (!manifest) {
    return Response.json({ error: "Publish snapshot missing" }, { status: 500 });
  }

  try {
    const { url } = await runDeploy(manifest.slug, restored.files);
    const deployedAt = new Date().toISOString();
    const newVersion = recordDeployVersion(projectId, restored.files, {
      url,
      slug: manifest.slug,
      deployedAt,
    });
    const deployment = {
      workerName: manifest.slug,
      url,
      deployedAt,
      version: newVersion.version,
    };
    setProjectDeployment(projectId, deployment);
    return Response.json({
      deployment,
      restoredFrom: target,
      versions: listDeployVersions(projectId),
    });
  } catch (e) {
    if (e instanceof DeployError) {
      return Response.json({ error: e.message }, { status: e.status ?? 500 });
    }
    const message = e instanceof Error ? e.message : "Rollback deploy failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
