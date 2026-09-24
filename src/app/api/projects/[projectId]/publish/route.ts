import { NextRequest } from "next/server";
import {
  getProject,
  getPublishManifest,
  listAppFiles,
  mostRecentCompleteSnapshot,
  publishProject,
  readPublishedFile,
  setPinnedSnapshot,
  slugTakenByOther,
  slugify,
  snapshotMissingAssets,
  unpublishProject,
} from "@/lib/store";

/**
 * Whether the live workspace differs from what the published folder holds:
 * any file added/removed (length mismatch) or changed in place. One
 * definition shared by the status GET and the publish POST so the client's
 * PublishState never disagrees with itself.
 */
function dirtySince(
  projectId: string,
  publishedPaths: string[],
  current: { path: string; content: string }[],
): boolean {
  return (
    publishedPaths.length !== current.length ||
    current.some((f) => readPublishedFile(projectId, f.path) !== f.content)
  );
}

function publicUrl(req: NextRequest, slug: string): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const host = req.headers.get("host") ?? "localhost:3000";
  return `${proto}://${host}/p/${slug}`;
}

/**
 * GET → publish status for the builder UI:
 * published?, publicUrl, slug, publishedAt, and "dirty" (workspace files
 * changed since the last publish).
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const manifest = getPublishManifest(projectId);
  if (!manifest) {
    // Unpublished — but pin state is still reported so the publish panel's
    // safe-versions list can mark the pinned version before first publish.
    return Response.json({
      published: false,
      pinnedFrom: project.pinnedSnapshot?.messageId ?? null,
    });
  }

  // Dirty = any difference between the published snapshot and the live
  // workspace: added/removed files OR changed contents. (Path-only checks
  // miss in-place edits.)
  const current = listAppFiles(projectId);
  const dirty = dirtySince(projectId, manifest.files, current);

  // Pin state (the public page serves the pinned snapshot when set) plus
  // the assets it lacks and the one-click alternative to offer the user.
  const pinId = manifest.pinnedFrom ?? project.pinnedSnapshot?.messageId ?? null;
  const pinMissing = pinId ? snapshotMissingAssets(projectId, pinId) : [];

  return Response.json({
    published: true,
    slug: manifest.slug,
    publishedAt: manifest.publishedAt,
    publicUrl: publicUrl(req, manifest.slug),
    dirty,
    // The public page serves the PINNED best version when one is set —
    // the workspace "dirty" signal then describes the live workspace
    // only, not what the public URL shows.
    pinnedFrom: pinId,
    // Assets the pinned snapshot's HTML references but the snapshot lacks
    // (empty when no pin or the pinned snapshot is self-contained).
    pinnedMissing: pinMissing,
    // One-click recovery when the pinned snapshot ships 404s: the newest
    // complete snapshot to switch the pin to (null when none exists).
    suggest: pinMissing.length > 0 ? mostRecentCompleteSnapshot(projectId) : null,
  });
}

/**
 * POST → publish (or republish). Body: { slug?: string }. An explicit slug
 * is refused with 409 if another project owns it; auto slugs get suffixed.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  let body: { slug?: string } = {};
  try {
    body = (await req.json()) as { slug?: string };
  } catch {
    // empty body → auto slug
  }

  const manifest = getPublishManifest(projectId);
  const baseSlug =
    body.slug?.trim() ||
    manifest?.slug ||
    slugify(project.name);

  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(baseSlug)) {
    return Response.json(
      { error: "Slug may only contain lowercase letters, numbers and dashes (max 64)." },
      { status: 400 },
    );
  }

  if (slugTakenByOther(baseSlug, projectId)) {
    return Response.json(
      { error: `The URL /p/${baseSlug} is already taken by another app.`, slug: baseSlug },
      { status: 409 },
    );
  }

  // A pinned snapshot missing referenced assets (the known small-model
  // quirk) ships a broken page — refuse with the asset list unless the
  // caller confirms with ?force=1 (the pin warning's "pin anyway" path).
  const pin = getProject(projectId)?.pinnedSnapshot;
  if (pin?.messageId) {
    const missing = snapshotMissingAssets(projectId, pin.messageId);
    if (missing.length > 0 && new URL(req.url).searchParams.get("force") !== "1") {
      return Response.json(
        {
          published: false,
          warning: "The pinned snapshot is missing assets its HTML references.",
          missing,
          // One-click alternative: unpin and pin this newest complete
          // snapshot instead of force-publishing a 404ing page.
          suggest: mostRecentCompleteSnapshot(projectId),
        },
        { status: 409 },
      );
    }
  }

  const published = publishProject(projectId, baseSlug);
  // The client REPLACES its PublishState with this response — it must carry
  // the same shape the status GET returns, or the 📌 pinned note (and the
  // dirty flag) would vanish after every republish while the pin holds.
  // dirty uses the same formula as GET: under a pin whose live workspace
  // has moved on, the public page still serves the pinned files but the
  // workspace IS ahead of it.
  const current = listAppFiles(projectId);
  return Response.json({
    published: true,
    slug: published.slug,
    publishedAt: published.publishedAt,
    fileCount: published.files.length,
    publicUrl: publicUrl(req, published.slug),
    dirty: dirtySince(projectId, published.files, current),
    pinnedFrom: published.pinnedFrom ?? null,
    pinnedMissing: pin?.messageId
      ? snapshotMissingAssets(projectId, pin.messageId)
      : [],
  });
}

/** DELETE → unpublish: the public URL stops resolving. */
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = getProject(projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  unpublishProject(projectId);
  return Response.json({ published: false });
}
